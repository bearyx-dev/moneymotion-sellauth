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
  SANDBOX,
} = process.env;

// Strip trailing slash so DOMAIN never produces //path double-slashes
const DOMAIN = (process.env.DOMAIN || "").replace(/\/+$/, "");
// Optional: where to send the customer if they cancel. Falls back to DOMAIN.
const STORE_URL = (process.env.STORE_URL || DOMAIN).replace(/\/+$/, "");

const MM_BASE = SANDBOX === "true"
  ? "https://api.sandbox.moneymotion.io"
  : "https://api.moneymotion.io";

const MM_CHECKOUT_HOST = SANDBOX === "true"
  ? "https://sandbox.moneymotion.io"
  : "https://moneymotion.io";

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

// Effect RPC over NDJSON — MoneyMotion's real wire format
function moneyMotionRpc(tag, payload, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const envelope = JSON.stringify({
      _tag: "Request",
      id: "0",
      tag,
      payload,
      headers: [],
    }) + "\n";

    const parsed = new URL(`${MM_BASE}/rpc`);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: "/rpc",
      method: "POST",
      headers: {
        "Content-Type": "application/ndjson",
        "Accept": "application/ndjson",
        "x-api-key": MONEYMOTION_API_KEY,
        ...extraHeaders,
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        const lines = data.split("\n").filter((l) => l.trim());
        for (const line of lines) {
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg._tag === "Exit" && msg.exit) {
            if (msg.exit._tag === "Success") return resolve(msg.exit.value);
            if (msg.exit._tag === "Failure") {
              const cause = msg.exit.cause;
              const text = cause?.error?.message
                ?? (typeof cause === "string" ? cause : JSON.stringify(cause));
              return reject(new Error(`MoneyMotion RPC ${tag} failed: ${text}`));
            }
          }
          if (msg._tag === "Defect") {
            return reject(new Error(`MoneyMotion RPC ${tag} defect: ${JSON.stringify(msg)}`));
          }
        }
        if (res.statusCode >= 400) {
          return reject(new Error(`MoneyMotion HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
        }
        reject(new Error(`MoneyMotion RPC ${tag}: no Exit in response. Body: ${data.slice(0, 300)}`));
      });
    });
    req.on("error", reject);
    req.write(envelope);
    req.end();
  });
}

// ─── Checkout session creator ────────────────────────────────────────────────────
async function createCheckoutSession(invoiceId) {
  const invoice = await sellAuth("GET", `/invoices/${invoiceId}`);
  console.log(`[pay] Invoice: ${JSON.stringify(invoice)}`);

  const priceUsd = invoice.price_usd ?? invoice.price ?? invoice.total_price_usd ?? invoice.total ?? null;
  if (priceUsd === null) throw new Error("Could not determine invoice price from SellAuth response.");

  const totalInCents = Math.round(parseFloat(priceUsd) * 100);
  const currency = invoice.currency ?? "USD";
  const email = invoice.email ?? invoice.customer_email ?? invoice.buyer_email ?? "customer@unknown.com";
  const productName = invoice.product_title ?? invoice.product?.title ?? invoice.title ?? `Order ${invoiceId}`;

  console.log(`[pay] Amount: $${priceUsd} (${currency}) → ${totalInCents} cents | email: ${email}`);

  const sessionValue = await moneyMotionRpc(
    "CheckoutSessionsCreateCheckoutSession",
    {
      description: productName,
      urls: {
        success: `${DOMAIN}/payment-complete?status=success&invoice=${invoiceId}`,
        cancel:  STORE_URL || `${DOMAIN}/payment-complete?status=cancelled&invoice=${invoiceId}`,
        failure: `${DOMAIN}/payment-complete?status=cancelled&invoice=${invoiceId}`,
      },
      userInfo: { email },
      lineItems: [
        {
          name: productName,
          description: `SellAuth invoice ${invoiceId}`,
          pricePerItemInCents: totalInCents,
          quantity: 1,
        },
      ],
      metadata: { invoiceId, sellAuthShopId: SELLAUTH_SHOP_ID },
    },
    { "x-currency": currency }
  );

  console.log(`[pay] MM session: ${JSON.stringify(sessionValue)}`);

  const sessionId = sessionValue?.checkoutSessionId;
  if (!sessionId) throw new Error(`MoneyMotion did not return a checkoutSessionId. Response: ${JSON.stringify(sessionValue)}`);

  return `${MM_CHECKOUT_HOST}/checkout/${sessionId}`;
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
function loadingPage(invoiceId) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Redirecting to checkout…</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0a0a0f;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh}@keyframes spin{to{transform:rotate(360deg)}}.spinner{width:48px;height:48px;border:4px solid #ffffff18;border-top-color:#22d3ee;border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 1.5rem}.card{text-align:center}.title{font-size:1.25rem;font-weight:600;margin-bottom:.5rem;color:#fff}.sub{color:#71717a;font-size:.875rem}</style></head><body><div class="card"><div class="spinner"></div><div class="title">Preparing your checkout…</div><div class="sub">You'll be redirected in a moment.</div></div><script>fetch('/pay-redirect/${invoiceId}').then(r=>r.json()).then(d=>{if(d.url){window.location.href=d.url;}else{document.querySelector('.title').textContent='Something went wrong';document.querySelector('.sub').textContent=d.error||'Please go back and try again.';document.querySelector('.spinner').style.display='none';}}).catch(()=>{document.querySelector('.title').textContent='Something went wrong';document.querySelector('.sub').textContent='Please go back and try again.';document.querySelector('.spinner').style.display='none';});</script></body></html>`;
}

const PAGE = {
  success: (invoice) => `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment Successful</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0a0a0f;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:2rem}.card{background:#13131a;border:1px solid #ffffff18;border-radius:16px;padding:2.5rem;text-align:center;max-width:420px;width:100%}.icon{font-size:3rem;margin-bottom:1rem}h1{font-size:1.5rem;font-weight:700;margin-bottom:.5rem;color:#4ade80}p{color:#a1a1aa;line-height:1.6;margin-bottom:1rem}small{color:#52525b;font-size:.75rem;display:block;margin-bottom:1.5rem}a.btn{display:inline-block;background:#22d3ee;color:#020617;font-weight:700;padding:.625rem 1.5rem;border-radius:8px;text-decoration:none;font-size:.9rem}a.btn:hover{background:#67e8f9}</style></head><body><div class="card"><div class="icon">✅</div><h1>Payment Successful</h1><p>Your payment was confirmed. Check your email for delivery — it should arrive within a few minutes.</p><small>Order ref: ${invoice}</small>${STORE_URL ? `<a class="btn" href="${STORE_URL}">Back to store</a>` : ""}</div></body></html>`,
  cancelled: () => `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment Cancelled</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0a0a0f;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:2rem}.card{background:#13131a;border:1px solid #ffffff18;border-radius:16px;padding:2.5rem;text-align:center;max-width:420px;width:100%}.icon{font-size:3rem;margin-bottom:1rem}h1{font-size:1.5rem;font-weight:700;margin-bottom:.5rem;color:#f87171}p{color:#a1a1aa;line-height:1.6;margin-bottom:1.5rem}a.btn{display:inline-block;background:#22d3ee;color:#020617;font-weight:700;padding:.625rem 1.5rem;border-radius:8px;text-decoration:none;font-size:.9rem}a.btn:hover{background:#67e8f9}</style></head><body><div class="card"><div class="icon">❌</div><h1>Payment Cancelled</h1><p>Your payment was not completed.</p>${STORE_URL ? `<a class="btn" href="${STORE_URL}">Back to store</a>` : ""}</div></body></html>`,
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

    // Step 1: SellAuth redirects here — respond with loading page IMMEDIATELY
    const payMatch = path.match(/^\/pay\/(.+)$/);
    if (payMatch && method === "GET") {
      const invoiceId = payMatch[1];
      console.log(`[pay] Loading page for invoice: ${invoiceId}`);
      return send(res, 200, loadingPage(invoiceId));
    }

    // Step 2: Loading page fetches this — does the API work, returns JSON
    const payRedirectMatch = path.match(/^\/pay-redirect\/(.+)$/);
    if (payRedirectMatch && method === "GET") {
      const invoiceId = payRedirectMatch[1];
      console.log(`[pay-redirect] Creating session for invoice: ${invoiceId}`);
      const checkoutUrl = await createCheckoutSession(invoiceId);
      return send(res, 200, { url: checkoutUrl });
    }

    // Webhook — MoneyMotion posts here on payment events
    if (path === "/moneymotion-webhook" && method === "POST") {
      const rawBody = await readBody(req);

      // Signature header per MoneyMotion's actual header names
      const sig = req.headers["x-webhook-signature"]
        ?? req.headers["x-signature"]
        ?? req.headers["x-moneymotion-signature"]
        ?? "";

      const valid = await verifySignature(rawBody, sig);
      if (!valid) {
        console.warn("[webhook] Bad signature, header:", sig ? sig.slice(0, 20) + "..." : "(missing)");
        return send(res, 401, { error: "Invalid signature" });
      }

      const event = JSON.parse(rawBody);
      console.log(`[webhook] Event: ${event.event}`);

      if (event.event !== "checkout_session:complete") {
        return send(res, 200, { received: true });
      }

      const session = event.checkoutSession;
      if (!session) {
        console.error("[webhook] No checkoutSession in payload");
        return send(res, 400, { error: "Missing checkoutSession" });
      }

      // status is "completed" per MoneyMotion's actual webhook shape
      if (session.status !== "completed") {
        console.log(`[webhook] Session status is "${session.status}", skipping`);
        return send(res, 200, { received: true });
      }

      const invoiceId = session.metadata?.invoiceId;
      if (!invoiceId) {
        console.error("[webhook] No invoiceId in metadata:", session.metadata);
        return send(res, 400, { error: "Missing invoiceId in metadata" });
      }

      console.log(`[webhook] Completing SellAuth invoice: ${invoiceId}`);
      try {
        await sellAuth("POST", `/invoices/${invoiceId}/complete`);
        console.log(`[webhook] ✅ Invoice ${invoiceId} completed`);
      } catch (err) {
        console.error(`[webhook] SellAuth complete failed:`, err.message);
        // Still return 200 so MoneyMotion doesn't keep retrying
      }

      return send(res, 200, { received: true });
    }

    // Payment confirmation page
    if (path === "/payment-complete" && method === "GET") {
      const status = parsed.query.status ?? "unknown";
      const invoice = parsed.query.invoice ?? "";
      if (status === "success") return send(res, 200, PAGE.success(invoice));
      return send(res, 200, PAGE.cancelled());
    }

    send(res, 404, { error: "Not found" });
  } catch (err) {
    console.error("[server] Error:", err.message);
    send(res, 500, { error: err.message });
  }
});

validateEnv();
server.listen(PORT, () => {
  console.log(`\n🚀 MoneyMotion × SellAuth bridge running on port ${PORT}`);
  console.log(`   Sandbox: ${SANDBOX === "true" ? "YES" : "NO"}`);
  console.log(`   Domain:  ${DOMAIN}`);
  console.log(`   Store:   ${STORE_URL || "(not set)"}\n`);
});
