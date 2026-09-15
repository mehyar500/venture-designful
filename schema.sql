-- pwa/schema.sql — Designful PWA schema + billing catalog seed.
-- Apply to the shared mehyar-jobs D1. Safe to re-run (IF NOT EXISTS / upserts).
-- NOTE: nothing in ~/workspace/repos/mehyar-web is touched by this file.

-- ── orders: one row per paid Designful purchase ────────────────────────────
CREATE TABLE IF NOT EXISTS designful_orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id    INTEGER NOT NULL,          -- billing_payments.id (unique: idempotent fulfill)
  product_id    TEXT NOT NULL,             -- billing_products.id
  email         TEXT NOT NULL,
  inputs_json   TEXT NOT NULL DEFAULT '{}',-- {inputs:{...intake}, feature, used_features:[]}
  bundle_slots  INTEGER,                   -- 3 | 5 for bundles, NULL for single features
  status        TEXT NOT NULL DEFAULT 'paid', -- paid|ready|failed
  output_json   TEXT,                      -- deliverable manifest (or {manifests:{}} for bundles)
  access_token  TEXT NOT NULL,             -- unguessable buyer capability token
  created_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ready_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_designful_orders_token ON designful_orders(access_token);
-- Idempotency key for the webhook fulfillment hook (one order per payment).
CREATE UNIQUE INDEX IF NOT EXISTS idx_designful_orders_payment ON designful_orders(payment_id);

-- ── billing catalog: 7 SKUs, fulfillment='designful' ───────────────────────
-- success_url_template: Stripe {access_token} is the designful_orders token,
-- written by fulfillDesignful at webhook time (see pwa/fulfill-designful.js).

INSERT INTO billing_products
  (id, name, brand, price_cents, currency, fulfillment, description, success_url_template, cancel_url, allowed_return_hosts, active, digital_file)
VALUES
  ('designful-homepage-teardown', 'Homepage Teardown — AI Audit', 'designful', 4900, 'usd', 'designful',
   '10-point AI conversion teardown of your homepage: severity-scored findings, specific fixes, and 3 prioritized rewrites.',
   'https://designful.mehyar.us/success.html?token={access_token}',
   'https://designful.mehyar.us/#features', 'designful.mehyar.us', 1, NULL),
  ('designful-logo-refresh', 'Logo Refresh — 3 AI Concepts', 'designful', 4900, 'usd', 'designful',
   'Three polished logo restyle concepts in your brand colors, plus a mini usage sheet (clearspace, sizes, donts).',
   'https://designful.mehyar.us/success.html?token={access_token}',
   'https://designful.mehyar.us/#features', 'designful.mehyar.us', 1, NULL),
  ('designful-ad-creative-pack', 'Ad Creative Pack — 5 Creatives', 'designful', 4900, 'usd', 'designful',
   'Five scroll-stopping ad creatives in 1:1 and 9:16, each with 3 headline variants. Ready for Meta/TikTok.',
   'https://designful.mehyar.us/success.html?token={access_token}',
   'https://designful.mehyar.us/#features', 'designful.mehyar.us', 1, NULL),
  ('designful-social-launch-kit', 'Social Launch Kit — 10 Templates', 'designful', 4900, 'usd', 'designful',
   'Ten on-brand social templates with caption starters — 10 days of content, done.',
   'https://designful.mehyar.us/success.html?token={access_token}',
   'https://designful.mehyar.us/#features', 'designful.mehyar.us', 1, NULL),
  ('designful-hero-rewrite', 'Hero Rewrite — Conversion Copy', 'designful', 4900, 'usd', 'designful',
   'A full hero-section rewrite: 5 headlines, subhead, CTA copy, trust bullets, and why-this-converts notes.',
   'https://designful.mehyar.us/success.html?token={access_token}',
   'https://designful.mehyar.us/#features', 'designful.mehyar.us', 1, NULL),
  ('designful-bundle-3', 'Designful — Any 3 Features', 'designful', 9900, 'usd', 'designful',
   'Pick any 3 Designful features. One payment, three full AI deliverables.',
   'https://designful.mehyar.us/success.html?token={access_token}',
   'https://designful.mehyar.us/#features', 'designful.mehyar.us', 1, NULL),
  ('designful-studio-pass', 'Designful — Full Studio Pass (All 5)', 'designful', 14900, 'usd', 'designful',
   'All 5 Designful features unlocked — the complete AI design studio in one pass.',
   'https://designful.mehyar.us/success.html?token={access_token}',
   'https://designful.mehyar.us/#features', 'designful.mehyar.us', 1, NULL)
ON CONFLICT(id) DO UPDATE SET
  name=excluded.name, price_cents=excluded.price_cents, fulfillment=excluded.fulfillment,
  description=excluded.description, success_url_template=excluded.success_url_template,
  cancel_url=excluded.cancel_url, allowed_return_hosts=excluded.allowed_return_hosts,
  active=excluded.active;
