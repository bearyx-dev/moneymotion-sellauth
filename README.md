# MoneyMotion × SellAuth Integration

**Built by [UXModz](https://discord.gg/em5ZU3QfBB)** | [Join Us!](https://discord.gg/em5ZU3QfBB)

Accept payments on your SellAuth shop through MoneyMotion. Fully automatic. Customer pays, SellAuth delivers the product.

---

## How It Works

1. Customer picks the MoneyMotion payment method at your SellAuth checkout.
2. SellAuth redirects them to your server at `/pay/{unique_id}`.
3. Your server fetches the invoice amount from SellAuth.
4. Your server creates a MoneyMotion checkout session with that amount.
5. Customer is redirected to MoneyMotion's hosted checkout page to pay.
6. Customer pays → MoneyMotion fires a webhook to your server.
7. Your server verifies the webhook signature (HMAC-SHA512).
8. Your server tells SellAuth to complete the invoice.
9. SellAuth delivers the product to the customer automatically.

Zero manual steps after setup.

---

## Requirements

- A [SellAuth](https://sellauth.com) account with a shop
- A [MoneyMotion](https://moneymotion.io) merchant account
- A hosting provider that supports Node.js 18+

**Recommended host:** [Railway](https://railway.app) Hobby plan ($5/month) — keeps the server alive 24/7. The free tier sleeps after inactivity and will miss payments.

---

## Setup

### 1. Deploy to Railway

1. Upload this project to a GitHub repository (or fork it).
2. Create a new project on [Railway](https://railway.app) and connect the repo.
3. Railway detects `package.json` and deploys automatically.

### 2. Get Your Public Domain

1. In Railway, click your service → **Settings → Networking**.
2. Click **Generate Domain**.
3. Copy the URL (e.g. `https://your-app.up.railway.app`). You need it below.

### 3. Set Environment Variables

In Railway go to **Variables** and add all five:

| Variable | Where to find it |
|---|---|
| `MONEYMOTION_API_KEY` | MoneyMotion dashboard → Development → API Keys |
| `MONEYMOTION_WEBHOOK_SECRET` | MoneyMotion dashboard → Webhooks (after you create one — see step 5) |
| `SELLAUTH_API_KEY` | SellAuth dashboard → Account → API Access |
| `SELLAUTH_SHOP_ID` | SellAuth dashboard → Account → API Access |
| `DOMAIN` | The Railway domain from step 2 (no trailing slash) |
| `SANDBOX` | `true` for testing, `false` (or remove) for live payments |

### 4. Configure SellAuth Payment Method

1. Go to your SellAuth dashboard → **Payment Methods** → Create new.
2. Set type to **Manual**.
3. Name it whatever you like (e.g. "MoneyMotion").
4. Set the **Redirect URL** to:
   ```
   https://your-domain.com/pay/{unique_id}
   ```
   Replace `your-domain.com` with your Railway domain. Keep `{unique_id}` exactly as written — SellAuth substitutes the real invoice ID automatically.
5. Save.

### 5. Configure MoneyMotion Webhook

1. Go to your MoneyMotion dashboard → **Webhooks** → Create New Webhook.
2. Set the URL to:
   ```
   https://your-domain.com/moneymotion-webhook
   ```
3. Subscribe to the event: **`checkout_session:complete`** (and optionally `checkout_session:new`, `checkout_session:expired`).
4. Save. Copy the **webhook secret** that appears — add it as `MONEYMOTION_WEBHOOK_SECRET` in Railway.

### 6. Test It

1. Use `SANDBOX=true` and MoneyMotion's test card `4242 4242 4242 4242`.
2. Go to your SellAuth shop, add a product, pick the MoneyMotion payment method.
3. You should land on MoneyMotion's checkout with the correct amount.
4. Complete the test payment.
5. Check MoneyMotion's Webhook Logs to confirm delivery.
6. Check SellAuth to confirm the invoice is marked complete.
7. Once confirmed, set `SANDBOX=false` and deploy for real.

---

## Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/` | GET | Health check — returns server status |
| `/pay/:invoiceId` | GET | Fetches invoice from SellAuth, creates MoneyMotion session, redirects customer |
| `/payment-complete` | GET | Confirmation page shown after payment (success or cancelled) |
| `/moneymotion-webhook` | POST | Receives MoneyMotion payment events, verifies signature, completes SellAuth order |

---

## Security

- **Webhook signature verification** — every incoming webhook is verified using HMAC-SHA512 with your secret. Any fake or tampered request is rejected with a 401.
- **No hardcoded credentials** — all keys are loaded from environment variables only.
- **Raw body preserved** — the server captures the raw request body before JSON parsing so the signature check is always accurate.

---

## Disclaimer

This integration was built and tested by UXModz. We are not responsible for any payments not coming through, failed transactions, lost funds, or any financial issues while using this script. Test everything thoroughly with sandbox mode before going live. Use small amounts for your first live test.

---

## Credits

Built by **[UXModz](https://discord.gg/em5ZU3QfBB)**.

---

## License

MIT — see [LICENSE](LICENSE).
