/**
 * Designful catalog — the 7 SKUs.
 * id: stable product_id sent to checkout
 * price_cents: one-time, USD
 * pitch: the one-line promise (customer-facing)
 * teaser_desc: exactly what the free teaser gives you (honest, no inflation)
 * inputs: what the teaser form collects
 * deliverable: what the paid version contains
 * turnaround: honest SLA
 */
const DESIGNFUL_CATALOG = [
  {
    slug: "homepage-teardown",
    id: "designful-homepage-teardown",
    name: "Homepage Teardown",
    price_cents: 4900,
    pitch: "Find out in 60 seconds why your homepage isn't converting.",
    teaser_desc: "Paste your URL. Get an AI first-impression score (0–100), the single biggest conversion killer, and one line on how to fix it. Instant, free.",
    inputs: [
      { key: "url", type: "url", label: "Your homepage URL", placeholder: "https://your-site.com" }
    ],
    deliverable: "A 10-point annotated teardown — hero, headline, CTA, trust signals, visual hierarchy, copy, mobile, speed, social proof, friction — each with severity and a specific fix. Plus 3 prioritized rewrites. Designed PDF, usually within 15 minutes.",
    turnaround: "\u224815 min",
    kind: "single"
  },
  {
    slug: "logo-refresh",
    id: "designful-logo-refresh",
    name: "Logo Refresh",
    price_cents: 4900,
    pitch: "Your logo, reimagined — 3 directions in minutes.",
    teaser_desc: "Describe your brand. Get 1 AI restyle concept direction plus a watermarked preview render. Free.",
    inputs: [
      { key: "brand_name", type: "text", label: "Brand name", placeholder: "Corner Cup" },
      { key: "industry", type: "text", label: "Industry (optional)", optional: true, placeholder: "neighborhood coffee shop" },
      { key: "brand_blurb", type: "textarea", label: "Brand notes", placeholder: "Who you serve, the vibe — 2-3 sentences is plenty." },
      { key: "current_logo_desc", type: "textarea", label: "Current logo (optional)", optional: true, placeholder: "Describe your current logo, or what you dislike about it." }
    ],
    deliverable: "3 polished concepts in your brand colors, a mini usage sheet (clearspace, minimum sizes, the don'ts), and a high-res PNG pack.",
    turnaround: "\u224815 min",
    kind: "single"
  },
  {
    slug: "ad-creative-pack",
    id: "designful-ad-creative-pack",
    name: "Ad Creative Pack",
    price_cents: 4900,
    pitch: "5 scroll-stoppers for your next ad run.",
    teaser_desc: "Describe your product in a few lines. Get 1 ad image (1:1, watermarked) generated for it. Free.",
    inputs: [
      { key: "product", type: "textarea", label: "Describe your product", placeholder: "What it is, who it's for, why it's better. 2–3 sentences is plenty." }
    ],
    deliverable: "5 creatives in 2 ratios (1:1 + 9:16), 3 headline variants per creative. Ready to upload to Meta or TikTok.",
    turnaround: "\u224815 min",
    kind: "single"
  },
  {
    slug: "social-launch-kit",
    id: "designful-social-launch-kit",
    name: "Social Launch Kit",
    price_cents: 4900,
    pitch: "10 days of on-brand content, done.",
    teaser_desc: "Drop a short brand blurb. Get your 3 content pillars plus 1 finished post template with a watermarked preview visual. Free.",
    inputs: [
      { key: "brand_name", type: "text", label: "Brand name (optional)", optional: true, placeholder: "Ember & Oak" },
      { key: "brand", type: "textarea", label: "Brand blurb", placeholder: "What you sell, who it's for — 2-3 sentences." }
    ],
    deliverable: "10 Instagram templates (promo / educational / proof mix) plus a caption starter for each one.",
    turnaround: "\u224815 min",
    kind: "single"
  },
  {
    slug: "hero-rewrite",
    id: "designful-hero-rewrite",
    name: "Hero Rewrite",
    price_cents: 4900,
    pitch: "A hero section that actually sells.",
    teaser_desc: "Paste your current hero copy. Get 3 rewritten headlines back, instantly. Free.",
    inputs: [
      { key: "hero", type: "textarea", label: "Your current hero copy", placeholder: "Paste your headline, subhead, and CTA as they read today." }
    ],
    deliverable: "A full hero rewrite: 5 headlines, a subhead, CTA copy, trust bullets — with notes on why each choice converts.",
    turnaround: "\u224815 min",
    kind: "single"
  },
  {
    slug: "bundle-3",
    id: "designful-bundle-3",
    name: "Any 3 for $99",
    price_cents: 9900,
    pitch: "Pick any three features. Save $48.",
    teaser_desc: "Three full $49 deliverables for $99. You choose which three at checkout — or buy now and decide later.",
    inputs: [
      { key: "choices", type: "choices", label: "Pick 3 (optional now)", options: ["Homepage Teardown", "Logo Refresh", "Ad Creative Pack", "Social Launch Kit", "Hero Rewrite"], max: 3 }
    ],
    deliverable: "Three full deliverables of your choice, each produced in minutes.",
    turnaround: "\u224815 min each",
    kind: "bundle"
  },
  {
    slug: "studio-pass",
    id: "designful-studio-pass",
    name: "Full Studio Pass",
    price_cents: 14900,
    pitch: "All 5 features. Save $96.",
    teaser_desc: "Every deliverable in the catalog — teardowns, refresh, creatives, content, rewrite — for one flat $149.",
    inputs: [],
    deliverable: "All 5 full deliverables. Best for a rebrand or a launch week.",
    turnaround: "\u224815 min each",
    kind: "bundle"
  }
];

function designfulFind(slug) {
  return DESIGNFUL_CATALOG.find(p => p.slug === slug);
}

function designfulPrice(product) {
  return "$" + (product.price_cents / 100).toFixed(0);
}

/**
 * Required-input check, shared by the teaser form (app.js) and tests.
 * Exempt: choices-type inputs, notes, and anything flagged optional in the
 * catalog or labeled "(optional)". Returns the missing input defs.
 */
function findMissingInputs(product, data) {
  return (product.inputs || []).filter(function (input) {
    if (input.type === "choices" || input.key === "notes" || input.optional) return false;
    if (/\(optional\)/i.test(input.label || "")) return false;
    return !data[input.key];
  });
}
