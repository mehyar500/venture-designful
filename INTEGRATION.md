# Designful PWA — Go-Live Integration Guide (mehyar-web)

**Scope: LOCAL DEV ONLY so far.** Nothing below has been applied. Do NOT run
any of these steps without the go-ahead — several touch the production
mehyar-web worker and the shared D1.

File map (all under `~/workspace/designful/pwa/`):

| File | Purpose |
|---|---|
| `functions/api/designful/_lib/ai.js` | Workers AI helpers: runText / runImage (magic-byte sniff) / runVision (1 image/call) |
| `functions/api/designful/_lib/prompts.js` | Prompt library + feature registry + product/feature maps |
| `functions/api/designful/_lib/inputs.js` | Shared sanitization, URL SSRF screen, page-text fetch |
| `functions/api/designful/teaser.js` | POST free teaser per feature (KV rate-limited) |
| `functions/api/designful/generate.js` | POST full deliverable; R2 in prod, dev-manifest without R2 |
| `schema.sql` | `designful_orders` DDL + 7 billing_products seed rows |
| `fulfill-designful.js` | Standalone Stripe fulfillment module (imported by the webhook) |

---

## Step A — Apply the schema to the shared D1

The shared DB is the `mehyar-jobs` D1 (same one `billing_products`/`billing_payments`
live in). From `~/workspace/designful`:

```bash
wrangler d1 execute mehyar-jobs --remote --file=pwa/schema.sql
```

Safe to re-run: DDL uses `IF NOT EXISTS`, the seed uses `ON CONFLICT(id) DO UPDATE`.
Verify: `wrangler d1 execute mehyar-jobs --remote --command="SELECT id, price_cents FROM billing_products WHERE brand='designful'"` → 7 rows.

## Step B — Seed is included in schema.sql

No separate step. The 7 SKUs (`designful-homepage-teardown`, `designful-logo-refresh`,
`designful-ad-creative-pack`, `designful-social-launch-kit`, `designful-hero-rewrite`,
`designful-bundle-3` @ $99, `designful-studio-pass` @ $149) all carry
`fulfillment='designful'`, `brand='designful'`, and
`success_url_template='https://designful.mehyar.us/success.html?token={access_token}'`.

## Step C — Wire the webhook fulfillment hook (mehyar-web)

1. Copy the module (do not edit in place — keep the pwa copy canonical):
   ```bash
   cp ~/workspace/designful/pwa/fulfill-designful.js \
      ~/workspace/repos/mehyar-web/functions/api/_shared/fulfillDesignful.js
   ```
2. In `~/workspace/repos/mehyar-web/functions/api/pay/webhook.js`, add this entry
   to `fulfillHooks` (next to `digital`):
   ```js
   // Designful AI design deliverables. Creates the designful_orders row
   // (idempotent on payment_id via idx_designful_orders_payment), unifies the
   // access token onto the billing_payments row, then hands off to the
   // standalone module for background generation + buyer email.
   async designful({ db, env, waitUntil }, payment) {
     const { fulfillDesignful } = await import("../_shared/fulfillDesignful.js");
     const sendEmail = (e, msg) => sendCloudflareEmail(e, msg);
     await fulfillDesignful({ db, env, waitUntil, sendEmail }, payment);
   },
   ```
   `sendCloudflareEmail` is already imported at the top of webhook.js and its
   signature `(env, {from, fromName, to, replyTo, subject, text, html})` matches
   the injected `sendEmail` contract exactly.
3. No signature/secret changes: the shared webhook + existing Stripe secrets are reused.

## Step D — Deploy the Designful PWA (separate Pages project)

mehyar-web only needs Steps A–C (+F). The buyer-facing app is a NEW Pages project:

1. Scaffold the project (frontend: `index.html` catalog + teaser widgets,
   `success.html` — doubles as the bundle feature-picker, `deliverable.html` —
   manifest viewer with status polling + retry). **Frontend is not built yet —
   this task covered backend only.**
2. Copy `pwa/functions/` → the new project's `functions/` directory.
3. DNS: `designful.mehyar.us` → the new Pages project (use the venture-launch
   skill's DNS flow).
4. ⚠️ **DEPLOY SAFETY (AGENTS.md lesson):** NEVER `wrangler pages deploy` from a
   directory containing a `wrangler.toml` with `[vars]` — it wipes dashboard env
   vars. Deploy from a clean staging dir (no toml) or via the standard venture
   `deploy.py` pattern. If `[vars]` are needed, inject secrets at deploy time
   from GitHub Actions secrets, never from a committed toml.

## Step E — Environment variables / bindings

On the **designful.mehyar.us** Pages project:

| Binding / var | Type | Required | Notes |
|---|---|---|---|
| `AI` | Workers AI binding | yes | `env.AI.run()` — no keys |
| `LEADS_DB` | D1 binding → mehyar-jobs | yes | shared ledger + designful_orders |
| `DESIGNFUL_R2` | R2 bucket binding | prod only | absent → dev-manifest mode (no images generated) |
| `DESIGNFUL_BASE_URL` | plain var | yes | `https://designful.mehyar.us` (no trailing slash) |
| `DESIGNFUL_KV` | KV namespace | no | teaser rate limiting; fail-open without it |

On **mehyar-web** (existing worker):

| Var | Required | Notes |
|---|---|---|
| `DESIGNFUL_BASE_URL` | yes | webhook's background POST target for `/api/designful/generate` |
| `DESIGNFUL_FROM_EMAIL` | no | defaults to `team@mehyar.us` (see ESP note below) |

**ESP rule (standing):** every new sending domain must be onboarded on BOTH ESPs
before anything sends from it. Until `designful.mehyar.us` / its sender domain
is onboarded, fulfillment mail sends from `team@mehyar.us` as "Designful". Set
`DESIGNFUL_FROM_EMAIL` only after onboarding completes.

## Step F — (Recommended) intake validation at checkout (mehyar-web)

Without this, checkout still works: `billing_payments.metadata_json` stores
`body.params` flat, and `fulfillDesignful` reads them as the intake inputs. But
adding a `designful` orderHook to `orderHooks` in
`functions/api/pay/checkout.js` validates required inputs BEFORE Stripe:

```js
// Designful intake validation. params: per-feature inputs, e.g.
// { url } for homepage-teardown, { brand_name, brand_blurb } for logo-refresh.
async designful(db, product, { email, params }) {
  const need = {
    "designful-homepage-teardown": ["url"],
    "designful-logo-refresh": ["brand_name"],
    "designful-ad-creative-pack": ["product_description"],
    "designful-social-launch-kit": ["brand_blurb"],
    "designful-hero-rewrite": ["hero_copy"],
    "designful-bundle-3": [],
    "designful-studio-pass": [],
  }[product.id] || [];
  for (const k of need) {
    if (!params[k] || !String(params[k]).trim()) return { error: "missing_input:" + k };
  }
  return { orderExtra: { accessToken: randomHex(32) }, metadataExtra: {} };
},
```

**Checkout contract for the PWA frontend:** POST `/api/pay/checkout` with
`{ product_id, email, params: { <intake inputs> } }`. Limits enforced by
checkout.js: `params` ≤ 2048 bytes JSON, each string ≤ 2000 chars — keep intake
fields tight (URL, short blurbs; no giant pastes).

---

## Local dev loop (no deploy, no live Stripe, no real email)

```bash
cd ~/workspace/designful/pwa
# D1 local: wrangler dev --d1 LEADS_DB=mehyar-jobs  (apply schema.sql first)
# AI binding works in wrangler dev (runs via the account).
# Leave DESIGNFUL_R2 unbound -> generate.js returns dev-manifests:
#   text deliverables inline (content_preview), flux_prompts listed but NOT run.
```

Fulfillment test without Stripe: insert a fake `billing_payments` row locally,
then import `fulfill-designful.js` in a node script with a stub `sendEmail`
that logs instead of sending. Idempotency check: call twice with the same
`payment.id` → second call returns `{replay:true}`, no duplicate order.

## Bundle mechanics (how "any 3" works)

- `designful_orders.bundle_slots` = 3 (bundle-3) or 5 (studio-pass); NULL for singles.
- `inputs_json.used_features` accumulates generated features.
- `success.html?token=` renders a feature picker for bundles; each pick POSTs
  `/api/designful/generate {order_token, feature}`.
- `generate.js` enforces: unknown feature → 403; already-generated → returns the
  stored manifest slice (no re-spend); `used_features.length >= slots` → 403
  `slots_exhausted`. Per-feature manifests accumulate under
  `output_json.manifests[feature]`.
- Studio-pass (5 slots = all 5) uses the same picker; the UI may offer
  "generate all" which just fires 5 sequential generate calls.

## Hardening TODOs (before real traffic)

1. **SSRF:** `isSafeFetchUrl` blocks obvious internal hosts; add DNS pinning or an
   egress allowlist before the teaser fetches arbitrary buyer-supplied URLs.
2. **Teaser abuse:** KV cap is 20/hr/IP (fail-open). Add Turnstile on the teaser
   form at go-live.
3. **Teaser watermark images:** the validation spec wanted watermarked teaser
   images (logo/ad/social). Current teasers are text-only per the build spec —
   when image teasers ship, watermark SERVER-SIDE at serve time (overlay), not
   via flux prompt text (unreliable). Never ship unwatermarked full-res previews.
4. **Worker limits:** ad-pack/social-kit generate 10 flux images each (~minutes).
   Always trigger via `waitUntil` (webhook) or client polling — never block a
   user-facing request on full generation.
5. **Retries:** `generate.js` sets `status='failed'` on build errors; the
   deliverable page must expose a retry button (re-POST with the same token —
   idempotent, no double-charge).

## Rollback

- Webhook: remove the `designful` hook entry (products fall back to `none` —
  payments still recorded as paid, no fulfillment).
- Catalog: `UPDATE billing_products SET active=0 WHERE brand='designful'`
  (checkout rejects inactive products).
- Schema: `designful_orders` is additive; leave it (no other table depends on it).
