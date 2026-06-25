"use strict";

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const url = require("url");

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

// ─── Env check ──────────────────────────────────────────────────────────────────
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
    console.error("Missing required environment variables:", missing.join(", "));
    process.exit(1);
  }
}

// ─── HTTP helpers ───────────────────────────────────────────────────────────────
function request(method, rawUrl, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(rawUrl);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method,
      headers: { "Content-Type": "application/json", ...headers },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        } else {
          resolve(data ? JSON.parse(data) : null);
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function sellAuth(method, path, body) {
  return request(method, `${SA_BASE}/shops/${SELLAUTH_SHOP_ID}${path}`, {
    Authorization: `Bearer ${SELLAUTH_API_KEY}`,
  }, body);
}

function moneyMotion(method, path, body) {
  return request(method, `${MM_BASE}${path}`, {
    "X-API-Key": MONEYMOTION_API_KEY,
  }, body);
}

// ─── Webhook verification ────────────────────────────────────────────────────────
async function verifySignature(rawBody, sigHeader) {
  const computed = crypto.createHmac("sha512", MONEYMOTION_WEBHOOK_SECRET)
    .update(rawBody).digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(sigHeader));
  } catch {
    return false;
  }
}

// ─── Response helpers ────────────────────────────────────────────────────────────
function send(res, status, body) {
  const isJson = typeof body === "object";
  const content = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, {
    "Content-Type": isJson ? "application/json" : "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(content),
  });
  res.end(content);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => resolve(raw));
  });
}

// ─── Pages ───────────────────────────────────────────────────────────────────────
const PAGE = {
  success: (invoice) => `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment Successful</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0a0a0f;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:2rem}.card{background:#13131a;border:1px solid #ffffff18;border-radius:16px;padding:2.5rem;text-align:center;max-width:420px;width:100%}.icon{font-size:3rem;margin-bottom:1rem}h1{font-size:1.5rem;font-weight:700;margin-bottom:.5rem;color:#4ade80}p{color:#a1a1aa;line-height:1.6;margin-bottom:1rem}small{color:#52525b;font-size:.75rem}</style></head><body><div class="card"><div class="icon">✅</div><h1>Payment Successful</h1><p>Your payment was confirmed. Check your email for delivery — it should arrive within a few minutes.</p><p>If you don't receive anything, contact support with your order reference.</p><small>Order ref: ${invoice}</small></div></body></html>`,
  cancelled: () => `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment Cancelled</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0a0a0f;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:2rem}.card{background:#13131a;border:1px solid #ffffff18;border-radius:16px;padding:2.5rem;text-align:center;max-width:420px;width:100%}.icon{font-size:3rem;margin-bottom:1rem}h1{font-size:1.5rem;font-weight:700;margin-bottom:.5rem;color:#f87171}p{color:#a1a1aa;line-height:1.6}</style></head><body><div class="card"><div class="icon">❌</div><h1>Payment Cancelled</h1><p>Your payment was not completed. Go back to the store and try again.</p></div></body></html>`,
};

// ─── Server ───────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const path = parsed.pathname;
  const method = req.method;

  try {
    // Health check
    if (path === "/" && method === "GET") {
      return send(res, 200, {
        status: "online",
        service: "MoneyMotion × SellAuth Bridge",
        sandbox: SANDBOX === "true",
        timestamp: new Date().toISOString(),
      });
    }

    // Payment entry point — SellAuth redirects here
    const payMatch = path.match(/^\/pay\/(.+)$/);
    if (payMatch && method === "GET") {
      const invoiceId = payMatch[1];
      console.log(`[pay] Invoice: ${invoiceId}`);

      const invoice = await sellAuth("GET", `/invoices/${invoiceId}`);
      console.log(`[pay] Invoice data:`, JSON.stringify(invoice));

      const priceUsd = invoice.price_usd ?? invoice.price ?? invoice.total_price_usd ?? invoice.total ?? null;
      if (priceUsd === null) {
        console.error("[pay] Cannot determine price:", invoice);
        return send(res, 500, "text/plain: Could not determine invoice price.");
      }

      const totalInCents = Math.round(parseFloat(priceUsd) * 100);
      console.log(`[pay] Amount: $${priceUsd} → ${totalInCents} cents`);

      const session = await moneyMotion("POST", "/createCheckoutSession", {
        totalInCents,
        metadata: { invoiceId, sellAuthShopId: SELLAUTH_SHOP_ID },
        successUrl: `${DOMAIN}/payment-complete?status=success&invoice=${invoiceId}`,
        cancelUrl: `${DOMAIN}/payment-complete?status=cancelled&invoice=${invoiceId}`,
      });
      console.log(`[pay] MM session:`, JSON.stringify(session));

      const redirectUrl = session.url ?? session.checkoutUrl ?? session.redirect_url;
      if (!redirectUrl) {
        console.error("[pay] No checkout URL in response:", session);
        return send(res, 500, "MoneyMotion did not return a checkout URL.");
      }

      return redirect(res, redirectUrl);
    }

    // Webhook — MoneyMotion posts here on payment events
    if (path === "/moneymotion-webhook" && method === "POST") {
      const rawBody = await readBody(req);
      const sig = req.headers["x-moneymotion-signature"]
        ?? req.headers["x-webhook-signature"]
        ?? req.headers["x-signature"]
        ?? "";

      const valid = await verifySignature(rawBody, sig);
      if (!valid) {
        console.warn("[webhook] Bad signature");
        return send(res, 401, { error: "Invalid signature" });
      }

      const event = JSON.parse(rawBody);
      console.log(`[webhook] Event: ${event.event}`);

      if (event.event !== "checkout_session:complete") {
        return send(res, 200, { received: true });
      }

      const session = event.checkoutSession;
      if (!session || session.status !== "completed") {
        return send(res, 200, { received: true });
      }

      const invoiceId = session.metadata?.invoiceId;
      if (!invoiceId) {
        console.error("[webhook] No invoiceId in metadata:", session.metadata);
        return send(res, 400, { error: "Missing invoiceId" });
      }

      console.log(`[webhook] Completing SellAuth invoice: ${invoiceId}`);
      try {
        await sellAuth("POST", `/invoices/${invoiceId}/complete`);
        console.log(`[webhook] ✅ Invoice ${invoiceId} completed`);
      } catch (err) {
        console.error(`[webhook] SellAuth complete failed:`, err.message);
      }

      return send(res, 200, { received: true });
    }

    // Payment confirmation page
    if (path === "/payment-complete" && method === "GET") {
      const status = parsed.query.status ?? "unknown";
      const invoice = parsed.query.invoice ?? "";
      if (status === "success") return send(res, 200, PAGE.success(invoice));
      if (status === "cancelled") return send(res, 200, PAGE.cancelled());
      return send(res, 200, "<html><body style='background:#0a0a0f;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh'><h1>Processing…</h1></body></html>");
    }

    send(res, 404, { error: "Not found" });
  } catch (err) {
    console.error("[server] Error:", err.message);
    send(res, 500, { error: "Internal server error" });
  }
});

validateEnv();
server.listen(PORT, () => {
  console.log(`\n🚀 MoneyMotion × SellAuth bridge running on port ${PORT}`);
  console.log(`   Sandbox: ${SANDBOX === "true" ? "YES" : "NO"}`);
  console.log(`   Domain:  ${DOMAIN}\n`);
});
