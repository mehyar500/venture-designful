# Designful PWA — local dev scaffold

Static site. No build step, no bundler — open `index.html` in a browser
(or serve the folder with any static server: `python3 -m http.server 8000`).

## What's here

| File | What it is |
|---|---|
| `index.html` | Catalog: hero, 5 feature cards, 2 bundles, how-it-works, FAQ |
| `feature.html` | Per-feature page, driven by `?f=<slug>`. Teaser input form + teaser result area + $49 unlock CTA |
| `success.html` | Post-checkout landing: "check your email" + token entry box → `deliverable.html?token=…` |
| `deliverable.html` | Token-gated deliverable view. Renders a report + image gallery from a JSON manifest |
| `catalog.js` | All 7 SKUs: `id`, `name`, `price_cents`, `pitch`, `teaser_desc`, `inputs` spec, `deliverable` summary |
| `app.js` | Shared logic: buy modal, teaser form submit, email validation |
| `styles.css` | Mobile-first dark theme, shared across all pages |
| `manifest.json` | PWA manifest, name "Designful" |
| `sw.js` | Minimal service-worker stub: cache-first for same-origin GETs |

## What's stubbed in dev

- **`DEV_MODE = true` in `app.js`.** Flip to `false` for production.
- **Buy button does NOT call any API.** It opens a modal showing the *exact* JSON
  payload that production would `POST` to
  `https://mehyar.us/api/pay/checkout` —
  `{product_id, email, test: true, params}` —
  with a "dev mode — no real checkout" notice. No Stripe, no money moves.
- **Teaser forms `POST /api/designful/teaser`.** With no backend running, the
  fetch fails and the page shows a graceful
  "dev backend not running — this is where the teaser would appear" fallback.
  `renderTeaserResult()` handles the real backend response shape
  (`{html}` or `{title, body, images[]}`).
- **`deliverable.html` renders `SAMPLE_MANIFEST`** (inline sample content +
  inline-SVG placeholder images, no network). In production it fetches the
  manifest for the given token instead. Any `?token=…` value "works" in dev.
- **`sw.js` never caches `/api/*` traffic** and only handles same-origin GETs.

## Constraints honored

No wrangler, no deploy, no DNS changes, no real Stripe calls, no emails sent,
no secrets anywhere, no external network calls from the pages (dev images are
inline SVG data-URIs). The only "network" the pages attempt is the documented
dev-stubbed teaser POST to a relative `/api/...` path.

## Quality gates (2026-09-15 — all proven with real Workers AI)

The generation pipeline is not "prompt and pray". Every feature passes
deterministic gates before anything ships:

**Text (in `_lib/generate.js` via `ai.js runTextJson`, ≤3 repair retries):**
- `_lib/claims.js` — unsupported-claim detection: ratings, guarantees, scarcity,
  discounts, superlatives, gift-set and freebie claims must be grounded in the
  customer inputs or they are deleted and replaced via a repair nudge.
- `_lib/claims.js` `validateTeardownHonesty()` — teardown mobile/speed findings
  must say exactly "not assessable from inputs", severity ≤2.
- Schema validation per feature spec (real JSON, parsed by `ai.js`).

**Images (in `_lib/pipeline.js generateArtwork()`):**
- Flux renders text-free; one-image-per-call vision QC rejects any visible text;
  up to 3 regenerations; failed QC artwork is withheld, never shipped.
- Safe mode after 2 failures: abstract background, no products/labels (records
  `prompt_mode: "safe"` in the manifest).
- Flaky Flux 8007 safety-filter errors are retried ×3 without consuming a QC attempt.

**Delivery:** overlay-spec validation per composited item; token-gated manifests;
teaser watermarking. Fresh validation evidence:
`../test-outputs/round2/revalidation-2026-09-15/` (21/21 images QC-clean,
0 residual unsupported claims, 64/71 brutal gates in `verify.mjs`).
