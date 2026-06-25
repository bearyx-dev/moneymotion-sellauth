"use strict";

const express = require("express");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Config ────────────────────────────────────────────────────────────────────
const {
  MONEYMOTION_API_KEY,
  MONEYMOTION_WEBHOOK_SECRET,
  SELLAUTH_API_KEY,
  SELLAUTH_SHOP_ID,
  DOMAIN,
  SANDBOX,
} = process.env;

const MM_BASE = SANDBOX === "true"
  ? "https://api.sandbox.moneymotion.io"
  : "https://api.moneymotion.io";

const SA_BASE = "https://api.sellauth.com/v1";

// ─── Helpers ────────────────────────────────────────────────────────────────────
function validateEnv() {
  const required = [
    "MONEYMOTION_API_KEY",
    "MONEYMOTION_WEBHOOK_SECRET",
    "SELLAUTH_API_KEY",
    "SELLAUTH_SHOP_ID",
    "DOMAIN",
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error("❌  Missing required environment variables:", missing.join(", "));
    process.exit(1);
  }
}

async function sellAuthFetch(method, path, body) {
  const res = await fetch(`${SA_BASE}/shops/${SELLAUTH_SHOP_ID}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${SELLAUTH_API_KEY}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`SellAuth ${method} ${path} → ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function moneyMotionFetch(method, path, body) {
  const res = await fetch(`${MM_BASE}${path}`, {
    method,
    headers: {
      "X-API-Key": MONEYMOTION_API_KEY,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`MoneyMotion ${method} ${path} → ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

// HMAC-SHA512 base64 — matches MoneyMotion docs exactly
async function hmacSha512(secret, data) {
  return crypto.createHmac("sha512", secret).update(data).digest("base64");
}

async function verifyWebhookSignature(rawBody, signatureHeader, secret) {
  const computed = await hmacSha512(secret, rawBody);
  try {
    return crypto.timingSafeEqual(
      Buffer.from(computed),
      Buffer.from(signatureHeader)
    );
  } catch {
    return false;
  }
}

// ─── Middleware ──────────────────────────────────────────────────────────────────
// Keep raw body for webhook signature verification
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  })
);
app.use(express.urlencoded({ extended: true }));

// ─── Routes ─────────────────────────────────────────────────────────────────────

/**
 * GET /
 * Health check — confirms the server is live
 */
app.get("/", (_req, res) => {
  res.json({
    status: "online",
    service: "MoneyMotion × SellAuth Bridge",
    sandbox: SANDBOX === "true",
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /pay/:invoiceId
 *
 * Entry point — SellAuth redirects the customer here after they pick the
 * MoneyMotion payment method at checkout.
 *
 * 1. Fetch the SellAuth invoice to get the amount.
 * 2. Create a MoneyMotion checkout session.
 * 3. Redirect the customer to MoneyMotion's hosted checkout page.
 */
app.get("/pay/:invoiceId", async (req, res) => {
  const { invoiceId } = req.params;

  console.log(`[pay] Incoming invoice: ${invoiceId}`);

  try {
    // 1. Get invoice details from SellAuth
    const invoice = await sellAuthFetch("GET", `/invoices/${invoiceId}`);
    console.log(`[pay] SellAuth invoice:`, JSON.stringify(invoice, null, 2));

    // SellAuth returns price in USD (decimal). Convert to cents for MoneyMotion.
    const priceUsd =
      invoice.price_usd ??
      invoice.price ??
      invoice.total_price_usd ??
      invoice.total ??
      null;

    if (priceUsd === null || priceUsd === undefined) {
      console.error("[pay] Could not determine price from SellAuth invoice:", invoice);
      return res.status(500).send("Could not determine invoice price. Check server logs.");
    }

    const totalInCents = Math.round(parseFloat(priceUsd) * 100);
    console.log(`[pay] Amount: $${priceUsd} → ${totalInCents} cents`);

    // 2. Create a MoneyMotion checkout session
    const session = await moneyMotionFetch("POST", "/createCheckoutSession", {
      totalInCents,
      metadata: {
        invoiceId,           // used in the webhook to complete the SellAuth order
        sellAuthShopId: SELLAUTH_SHOP_ID,
      },
      successUrl: `${DOMAIN}/payment-complete?status=success&invoice=${invoiceId}`,
      cancelUrl: `${DOMAIN}/payment-complete?status=cancelled&invoice=${invoiceId}`,
    });

    console.log(`[pay] MoneyMotion session created:`, JSON.stringify(session, null, 2));

    const redirectUrl = session.url ?? session.checkoutUrl ?? session.redirect_url;
    if (!redirectUrl) {
      console.error("[pay] MoneyMotion response missing checkout URL:", session);
      return res.status(500).send("MoneyMotion did not return a checkout URL. Check server logs.");
    }

    // 3. Redirect customer to pay
    res.redirect(302, redirectUrl);
  } catch (err) {
    console.error(`[pay] Error:`, err.message);
    res.status(500).send("Something went wrong. Please contact support.");
  }
});

/**
 * POST /moneymotion-webhook
 *
 * MoneyMotion POSTs here when a checkout session changes status.
 *
 * 1. Verify the HMAC-SHA512 signature.
 * 2. Only act on checkout_session:complete events.
 * 3. Extract the SellAuth invoiceId from session metadata.
 * 4. Tell SellAuth to complete the invoice → product gets delivered.
 */
app.post("/moneymotion-webhook", async (req, res) => {
  // Signature is in the header — accept a few common header name variants
  const signature =
    req.headers["x-moneymotion-signature"] ??
    req.headers["x-webhook-signature"] ??
    req.headers["x-signature"] ??
    "";

  const rawBody = req.rawBody ?? JSON.stringify(req.body);

  // 1. Verify signature
  const valid = await verifyWebhookSignature(rawBody, signature, MONEYMOTION_WEBHOOK_SECRET);
  if (!valid) {
    console.warn("[webhook] Invalid signature — rejecting request");
    return res.status(401).json({ error: "Invalid signature" });
  }

  const event = req.body;
  console.log(`[webhook] Received event: ${event.event}`);

  // 2. Only care about completed checkouts
  if (event.event !== "checkout_session:complete") {
    console.log(`[webhook] Ignoring event: ${event.event}`);
    return res.status(200).json({ received: true });
  }

  const session = event.checkoutSession;
  if (!session) {
    console.error("[webhook] No checkoutSession in payload");
    return res.status(400).json({ error: "Missing checkoutSession" });
  }

  if (session.status !== "completed") {
    console.log(`[webhook] Session status is "${session.status}" — ignoring`);
    return res.status(200).json({ received: true });
  }

  // 3. Get invoiceId from metadata
  const invoiceId = session.metadata?.invoiceId;
  if (!invoiceId) {
    console.error("[webhook] No invoiceId in session metadata:", session.metadata);
    return res.status(400).json({ error: "Missing invoiceId in metadata" });
  }

  console.log(`[webhook] Payment confirmed for invoice: ${invoiceId}`);

  // 4. Complete the SellAuth invoice → delivers the product automatically
  try {
    await sellAuthFetch("POST", `/invoices/${invoiceId}/complete`);
    console.log(`[webhook] ✅  SellAuth invoice ${invoiceId} marked as complete`);
  } catch (err) {
    console.error(`[webhook] Failed to complete SellAuth invoice ${invoiceId}:`, err.message);
    // Return 200 so MoneyMotion doesn't retry (we log the failure server-side)
    return res.status(200).json({ received: true, warning: "SellAuth completion failed — check logs" });
  }

  res.status(200).json({ received: true });
});

/**
 * GET /payment-complete
 * Simple confirmation page shown to the customer after they pay (or cancel).
 */
app.get("/payment-complete", (req, res) => {
  const status = req.query.status ?? "unknown";
  const invoice = req.query.invoice ?? "";

  if (status === "success") {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Payment Successful</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #0a0a0f;
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 2rem;
    }
    .card {
      background: #13131a;
      border: 1px solid #ffffff18;
      border-radius: 16px;
      padding: 2.5rem;
      text-align: center;
      max-width: 420px;
      width: 100%;
    }
    .icon { font-size: 3rem; margin-bottom: 1rem; }
    h1 { font-size: 1.5rem; font-weight: 700; margin-bottom: 0.5rem; color: #4ade80; }
    p { color: #a1a1aa; line-height: 1.6; margin-bottom: 1rem; }
    small { color: #52525b; font-size: 0.75rem; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✅</div>
    <h1>Payment Successful</h1>
    <p>Your payment was confirmed. Check your email for your product delivery — it should arrive within a few minutes.</p>
    <p>If you don't receive anything, contact support with your order reference.</p>
    <small>Order ref: ${invoice}</small>
  </div>
</body>
</html>
    `);
  } else if (status === "cancelled") {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Payment Cancelled</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #0a0a0f;
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 2rem;
    }
    .card {
      background: #13131a;
      border: 1px solid #ffffff18;
      border-radius: 16px;
      padding: 2.5rem;
      text-align: center;
      max-width: 420px;
      width: 100%;
    }
    .icon { font-size: 3rem; margin-bottom: 1rem; }
    h1 { font-size: 1.5rem; font-weight: 700; margin-bottom: 0.5rem; color: #f87171; }
    p { color: #a1a1aa; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">❌</div>
    <h1>Payment Cancelled</h1>
    <p>Your payment was not completed. You can go back to the store and try again.</p>
  </div>
</body>
</html>
    `);
  } else {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Payment Status</title>
  <style>
    body { font-family: sans-serif; background: #0a0a0f; color: #fff; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #13131a; border: 1px solid #fff2; border-radius: 16px; padding: 2.5rem; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Processing…</h1>
    <p style="color:#a1a1aa;margin-top:0.5rem">Your payment is being processed. Please wait a moment.</p>
  </div>
</body>
</html>
    `);
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────────
validateEnv();
app.listen(PORT, () => {
  console.log(`\n🚀  MoneyMotion × SellAuth bridge running on port ${PORT}`);
  console.log(`    Sandbox mode: ${SANDBOX === "true" ? "YES (test payments only)" : "NO (live payments)"}`);
  console.log(`    Domain:       ${DOMAIN}`);
  console.log(`    Health:       ${DOMAIN}/\n`);
});
