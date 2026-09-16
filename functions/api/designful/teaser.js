// functions/api/designful/teaser.js
// POST /api/designful/teaser — free teaser per feature (real partial value).
// Body: { feature: "homepage-teardown"|"logo-refresh"|"ad-creative-pack"|
//          "social-launch-kit"|"hero-rewrite",
//          inputs: { ...per-feature inputs... } }
//
// Returns per feature:
//   teardown -> {score, biggest_issue, one_fix}
//   logo     -> {concept_description, direction_name, why_it_works, image?, note}
//   ad       -> {angle, headline_options[3], why_this_angle, image?, note}
//   social   -> {content_pillars[3], sample_template{hook, caption}, image?, note}
// image is a QC-gated text-free render as a data: URI (null when QC exhausts);
// the client watermarks it via canvas before display.
//   hero     -> {headlines[3]}
//
// Notes:
// - Teasers are free/unauthenticated, so abuse control is a KV-backed
//   per-IP hourly cap (fail-open when no KV binding) + Turnstile on the
//   frontend at go-live (see INTEGRATION.md). Never rely on client checks.
// - Inputs are sanitized: HTML stripped, length-capped. URLs are validated
//   and SSRF-screened (blocks private/metadata hosts; full protection needs
//   DNS pinning — flagged as a hardening TODO in INTEGRATION.md).

import { runText, runVision, parseJson, MODELS } from "./_lib/ai.js";
import { cleanText, cleanUrl, isSafeFetchUrl, fetchPageText } from "./_lib/inputs.js";
import { FEATURES } from "./_lib/prompts.js";
import { generateArtwork } from "./_lib/pipeline.js";

const RL_CAP = 20; // teasers per IP per hour
const RL_WINDOW_S = 3600;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}


// Teaser artwork: one QC-gated text-free render per image teaser, composited
// SERVER-SIDE into a watermarked, display-size-limited SVG derivative.
// The free path never serves the clean master: the response carries a
// data:image/svg+xml URI with the artwork embedded at 512px display size and
// a diagonal "DESIGNFUL PREVIEW" text overlay baked in by this function.
// Paid deliverables (generate.js/deliverable.js) serve clean full-res files.
const PREVIEW_LABEL = "DESIGNFUL PREVIEW";
const PREVIEW_DISPLAY = 512; // px — free previews render at half the master size

function b64encodeChunked(str) {
  // btoa on one giant string can blow the arg/buffer limits; chunk it.
  let out = "";
  for (let i = 0; i < str.length; i += 100000) {
    out += btoa(str.slice(i, i + 100000));
  }
  return out;
}

function watermarkedPreviewSvg(jpegDataUri) {
  const W = PREVIEW_DISPLAY, H = PREVIEW_DISPLAY;
  const cx = W / 2, cy = H / 2;
  const fontSize = 34, rowGap = 88;
  let rows = "";
  for (let y = -H / 2; y < H * 1.6; y += rowGap) {
    rows += `<text x="${cx}" y="${Math.round(y)}" text-anchor="middle">${PREVIEW_LABEL} · ${PREVIEW_LABEL}</text>`;
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<image href="${jpegDataUri}" xlink:href="${jpegDataUri}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice"/>` +
    `<g transform="rotate(-24 ${cx} ${cy})" font-family="Arial,Helvetica,sans-serif" font-size="${fontSize}" font-weight="bold" letter-spacing="4" fill="#ffffff" fill-opacity="0.30" stroke="#000000" stroke-opacity="0.35" stroke-width="1" style="paint-order:stroke">${rows}</g>` +
    `</svg>`;
  return "data:image/svg+xml;base64," + b64encodeChunked(svg);
}

async function teaserArtwork(env, fluxPrompt, label) {
  if (!fluxPrompt) return null;
  try {
    const art = await generateArtwork(env, fluxPrompt, { label: "teaser:" + label });
    if (!art.ok) return null; // QC exhausted: ship the text teaser, not a dirty image
    return watermarkedPreviewSvg(`data:${art.mime};base64,${art.base64}`);
  } catch (e) {
    console.error("teaser artwork failed (non-fatal)", label, e && e.message);
    return null;
  }
}

// ── rate limit (fail-open without KV) ─────────────────────────────────────
async function checkRateLimit(env, request) {
  if (!env.DESIGNFUL_KV) return { ok: true };
  const ip =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for") ||
    "unknown";
  const key = "rl:teaser:" + ip;
  try {
    const cur = Number((await env.DESIGNFUL_KV.get(key)) || 0);
    if (cur >= RL_CAP) return { ok: false };
    await env.DESIGNFUL_KV.put(key, String(cur + 1), { expirationTtl: RL_WINDOW_S });
    return { ok: true };
  } catch {
    return { ok: true }; // fail open — never break the funnel on KV hiccups
  }
}

// ── per-feature teaser builders ───────────────────────────────────────────
async function teaserHomepageTeardown(env, inputs) {
  const url = cleanUrl(inputs.url);
  if (!isSafeFetchUrl(url)) return { error: "invalid_url", status: 400 };
  const page = await fetchPageText(url);
  if (!page.ok) return { error: page.error, status: 422 };

  // Optional vision pass: if the Browser Rendering binding exists, screenshot
  // the page and let the vision model (ONE image per call) add visual notes.
  // Text-only is the default path and is fine for the teaser.
  let visual_notes = "";
  if (env.BROWSER) {
    try {
      const browser = await env.BROWSER.launch?.();
      // Guarded: Browser Rendering API shape varies; best-effort only.
      if (browser && typeof browser.newPage === "function") {
        const pg = await browser.newPage();
        await pg.goto(url, { waitUntil: "networkidle0", timeout: 20000 }).catch(() => {});
        const shot = await pg.screenshot({ type: "jpeg", quality: 60, fullPage: false }).catch(() => null);
        await browser.close().catch(() => {});
        if (shot) {
          const b64 = btoa(String.fromCharCode(...new Uint8Array(shot).slice(0, 250000)));
          visual_notes = await runVision(
            env,
            "data:image/jpeg;base64," + b64,
            "Describe this homepage screenshot's above-the-fold visual hierarchy in 5 terse bullets: what the eye hits first, headline legibility, CTA visibility, trust signals visible, biggest visual friction. Concrete only — no generic praise."
          );
        }
      }
    } catch (e) {
      console.error("teaser vision pass failed (non-fatal)", e && e.message);
    }
  }

  const spec = FEATURES["homepage-teardown"].teaser({
    url,
    page_text: page.text,
    visual_notes,
  });
  const raw = await runText(env, MODELS[spec.model], [
    { role: "system", content: spec.system },
    { role: "user", content: spec.user },
  ], { jsonMode: spec.json, max_tokens: 1200, temperature: 0.5 });
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed.score !== "number") {
    return { error: "model_parse_failed", status: 502 };
  }
  return {
    ok: true,
    data: {
      score: Math.max(0, Math.min(100, Math.round(parsed.score))),
      biggest_issue: String(parsed.biggest_issue || "").slice(0, 500),
      one_fix: String(parsed.one_fix || "").slice(0, 500),
      url,
      vision: visual_notes ? "screenshot" : "text-only",
    },
  };
}

async function teaserLogoRefresh(env, inputs) {
  const brand_name = cleanText(inputs.brand_name, 120);
  if (!brand_name) return { error: "missing_brand_name", status: 400 };
  const spec = FEATURES["logo-refresh"].teaser({
    brand_name,
    industry: cleanText(inputs.industry, 120),
    brand_blurb: cleanText(inputs.brand_blurb, 2000),
    current_logo_desc: cleanText(inputs.current_logo_desc, 1000),
  });
  const raw = await runText(env, MODELS[spec.model], [
    { role: "system", content: spec.system },
    { role: "user", content: spec.user },
  ], { jsonMode: spec.json, max_tokens: 1000, temperature: 0.7 });
  const parsed = parseJson(raw);
  if (!parsed || !parsed.concept_description) return { error: "model_parse_failed", status: 502 };
  const image = await teaserArtwork(env, parsed.flux_prompt, "logo");
  return {
    ok: true,
    data: {
      concept_description: String(parsed.concept_description).slice(0, 1200),
      direction_name: String(parsed.direction_name || "").slice(0, 120),
      why_it_works: String(parsed.why_it_works || "").slice(0, 400),
      image, // watermarked client-side; null when QC exhausted
      note: "This is 1 of 3 directions. The full deliverable includes all 3 polished concepts + usage sheet.",
    },
  };
}

async function teaserAdPack(env, inputs) {
  const product_description = cleanText(inputs.product_description, 2000);
  if (!product_description) return { error: "missing_product_description", status: 400 };
  const spec = FEATURES["ad-creative-pack"].teaser({
    product_description,
    audience: cleanText(inputs.audience, 500),
    positioning: cleanText(inputs.positioning, 500),
  });
  const raw = await runText(env, MODELS[spec.model], [
    { role: "system", content: spec.system },
    { role: "user", content: spec.user },
  ], { jsonMode: spec.json, max_tokens: 1000, temperature: 0.8 });
  const parsed = parseJson(raw);
  if (!parsed || !Array.isArray(parsed.headline_options)) return { error: "model_parse_failed", status: 502 };
  const image = await teaserArtwork(env, parsed.flux_prompt, "ad");
  return {
    ok: true,
    data: {
      angle: String(parsed.angle || "").slice(0, 300),
      headline_options: parsed.headline_options.slice(0, 3).map((h) => String(h).slice(0, 200)),
      why_this_angle: String(parsed.why_this_angle || "").slice(0, 400),
      image, // watermarked client-side; null when QC exhausted
      note: "1 angle shown. The full pack ships 5 creatives × 2 ratios (1:1 + 9:16), each with 3 headline variants.",
    },
  };
}

async function teaserSocialKit(env, inputs) {
  const brand_blurb = cleanText(inputs.brand_blurb, 2000);
  if (!brand_blurb) return { error: "missing_brand_blurb", status: 400 };
  const spec = FEATURES["social-launch-kit"].teaser({
    brand_name: cleanText(inputs.brand_name, 120),
    brand_blurb,
    audience: cleanText(inputs.audience, 500),
    url: inputs.url ? cleanUrl(inputs.url) : "",
  });
  const raw = await runText(env, MODELS[spec.model], [
    { role: "system", content: spec.system },
    { role: "user", content: spec.user },
  ], { jsonMode: spec.json, max_tokens: 1000, temperature: 0.7 });
  const parsed = parseJson(raw);
  if (!parsed || !Array.isArray(parsed.content_pillars)) return { error: "model_parse_failed", status: 502 };
  const tpl = parsed.sample_template || {};
  const image = await teaserArtwork(env, tpl.flux_prompt, "social");
  return {
    ok: true,
    data: {
      content_pillars: parsed.content_pillars.slice(0, 3).map((p) => ({
        name: String(p.name || "").slice(0, 120),
        job: String(p.job || "").slice(0, 40),
        description: String(p.description || "").slice(0, 500),
      })),
      sample_template: {
        hook: String(tpl.hook || "").slice(0, 200),
        caption: String(tpl.caption || "").slice(0, 600),
      },
      image, // watermarked client-side; null when QC exhausted
      note: "Pillars + 1 finished template shown. The full kit ships 10 done-for-you templates (visuals + captions) across these pillars.",
    },
  };
}

async function teaserHeroRewrite(env, inputs) {
  const hero_copy = cleanText(inputs.hero_copy, 2000);
  if (!hero_copy) return { error: "missing_hero_copy", status: 400 };
  const spec = FEATURES["hero-rewrite"].teaser({
    hero_copy,
    product_description: cleanText(inputs.product_description, 1000),
    audience: cleanText(inputs.audience, 500),
  });
  const raw = await runText(env, MODELS[spec.model], [
    { role: "system", content: spec.system },
    { role: "user", content: spec.user },
  ], { jsonMode: spec.json, max_tokens: 1000, temperature: 0.7 });
  const parsed = parseJson(raw);
  if (!parsed || !Array.isArray(parsed.headlines)) return { error: "model_parse_failed", status: 502 };
  return {
    ok: true,
    data: {
      headlines: parsed.headlines.slice(0, 3).map((h) => ({
        text: String(h.text || "").slice(0, 200),
        structure: String(h.structure || "").slice(0, 40),
        why: String(h.why || "").slice(0, 300),
      })),
      note: "3 headline rewrites shown. The full deliverable ships 5 headlines + subhead + CTA copy + trust bullets + conversion notes.",
    },
  };
}

const TEASER_HANDLERS = {
  "homepage-teardown": teaserHomepageTeardown,
  "logo-refresh": teaserLogoRefresh,
  "ad-creative-pack": teaserAdPack,
  "social-launch-kit": teaserSocialKit,
  "hero-rewrite": teaserHeroRewrite,
};

export async function onRequestPost({ request, env }) {
  try {
    const rl = await checkRateLimit(env, request);
    if (!rl.ok) return json({ ok: false, error: "rate_limited" }, 429);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "bad_json" }, 400);
    }
    const feature = body && body.feature;
    const inputs = (body && body.inputs) || {};
    const handler = TEASER_HANDLERS[feature];
    if (!handler) {
      return json({ ok: false, error: "unknown_feature", features: Object.keys(TEASER_HANDLERS) }, 400);
    }
    // Required-input precheck (cheap fail before any AI spend).
    for (const req of FEATURES[feature].requiredInputs) {
      if (!inputs[req] || !String(inputs[req]).trim()) {
        return json({ ok: false, error: "missing_input", input: req }, 400);
      }
    }
    const result = await handler(env, inputs);
    if (result.error) return json({ ok: false, error: result.error }, result.status || 400);
    return json({
      ok: true,
      feature,
      teaser: result.data,
      preview: {
        tier: "free",
        watermarked: true,
        // Free image previews are server-composited SVG derivatives
        // (diagonal DESIGNFUL PREVIEW overlay, 512px display). The clean
        // full-resolution master is only served on the paid path.
        upgrade: "Unlock the full $49 deliverable for clean, full-resolution files.",
      },
    });
  } catch (e) {
    console.error("designful/teaser failed", e && e.message);
    return json({ ok: false, error: "teaser_failed" }, 500);
  }
}
