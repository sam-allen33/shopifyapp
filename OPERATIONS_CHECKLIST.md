# Shipwise Rate Pull: Post-Deploy Operations Checklist

## 1) GitHub web verification (no code reading required)
Use **Ctrl+F** (Windows) or **Command+F** (Mac) in each file page.

1. Open `shopify.app.toml` and search for:
   - `customers/data_request`
   - `customers/redact`
   - `shop/redact`
   - `https://live-rate-shop.onrender.com/auth/callback`
2. Open `app/routes/webhooks.app.uninstalled.tsx` and search for:
   - `db.shipwiseConfig.deleteMany`
3. Open `app/routes/webhooks.shop.redact.tsx` and search for:
   - `db.shipwiseConfig.deleteMany`
4. Open `app/routes/api.shipwise.rates.ts` and search for:
   - `SHIPWISE_DEBUG_VERBOSE`
   - `Full Shipwise response body` (should not be present)
   - `body: shipwiseJson` (should not be present)
5. Open `public/privacy-policy.html` and search for:
   - `We do not collect credit card information through this app.`

## 2) Render (low-cost)
1. Open Render dashboard -> your service for this app.
2. Go to **Environment** and set:
   - `SHIPWISE_DEBUG_VERBOSE=false`
3. Go to **Logs** or service settings and set log retention to the lowest practical period (target 7 days if available on your current plan).
4. Redeploy the latest commit.

## 3) Shopify Partner Dashboard
1. Open your app in Shopify Partner Dashboard.
2. Go to **App setup** or **Configuration**.
3. Confirm webhook subscriptions include:
   - `app/uninstalled`
   - `app/scopes_update`
   - `customers/data_request`
   - `customers/redact`
   - `shop/redact`
4. Set the privacy policy URL to:
   - `https://live-rate-shop.onrender.com/privacy-policy.html`
5. Ensure app listing text does **not** mention billing or charging.

## 4) Azure (only if used)
If any data or logs are routed to Azure, provide this before Azure-specific steps:
- Screenshot of the Azure resource list page showing the service type(s), or
- Exact resource type names (for example: App Service, Container Apps, Log Analytics Workspace, PostgreSQL Flexible Server).
Without that, do not change Azure settings.

## 5) Final spot-check after deploy
1. Install or re-open the app in a test store.
2. Save Shipwise token in app settings.
3. Run a checkout shipping-rate test.
4. In Render logs, verify logs show operational fields (correlationId, status, latency, counts) and do not show full request/response bodies, tokens, or full address/contact fields.
