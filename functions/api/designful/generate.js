// functions/api/designful/generate.js
// POST /api/designful/generate — build the FULL paid deliverable for one feature.
// Body: { order_token: "<designful_orders.access_token>", feature: "<feature-id>",
//         inputs: { ... } }  // inputs merge over the intake inputs stored at checkout
//
// Auth: the order's access_token is the capability. Single-feature orders may
// only generate their own feature; bundle orders may generate any feature
// until their slot count is consumed (tracked in inputs_json.used_features).
// Re-requesting an already-generated feature returns the stored manifest
// instead of burning AI budget again (idempotent generate).
//
// Storage: when env.DESIGNFUL_R2 is bound (prod), images are generated with
// flux-1-schnell and written to R2 at designful/<token>/<file>; the manifest
// lists storage as "r2:designful/<token>/<file>". When the binding is absent
// (local dev), NO images are generated and a dev-manifest is returned with
// the full text deliverables inline plus the exact flux_prompts that WOULD
// run — so prompt quality is reviewable without spending a neuron.
//
// On success the order row is updated: status='ready', output_json=manifest,
// ready_at=now (and used_features appended for bundles).

import { runTextJson, boundedMap, MODELS } from "./_lib/ai.js";
import { cleanText, cleanUrl, isSafeFetchUrl, fetchPageText } from "./_lib/inputs.js";
import { FEATURES, PRODUCT_FEATURE } from "./_lib/prompts.js";
import { generateArtwork, validateOverlaySpec, overlayHandoff } from "./_lib/pipeline.js";
import { findUnsupportedClaims, claimRepairNudge, validateTeardownHonesty } from "./_lib/claims.js";

/**
 * Compose a schema validator with the deterministic unsupported-claim gate.
 * Returns true when both pass, or a repair string naming the problem.
 * Prompt preflights alone don't stop invented ratings/guarantees/scarcity
 * (proven in validation); this is the enforcement layer.
 */
function withClaims(schemaValidate, inputs) {
  return (d) => {
    if (!schemaValidate(d)) return false;
    const hits = findUnsupportedClaims(d, inputs);
    if (hits.length) return claimRepairNudge(hits);
    return true;
  };
}

const nowSql = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── deliverable builders (text parts; images handled separately) ──────────

async function buildTeardown(env, inputs) {
  const url = cleanUrl(inputs.url);
  if (!isSafeFetchUrl(url)) throw Object.assign(new Error("invalid_url"), { status: 400 });
  const page = await fetchPageText(url);
  if (!page.ok) throw Object.assign(new Error(page.error), { status: 422 });
  const spec = FEATURES["homepage-teardown"].full({ url, page_text: page.text, visual_notes: "" });
  const { parsed: audit } = await runTextJson(env, MODELS[spec.model], [
    { role: "system", content: spec.system },
    { role: "user", content: spec.user },
  ], { max_tokens: 4000, temperature: 0.5, retries: 2, label: "teardown",
       validate: (d) => {
         if (!(d && typeof d.score === "number" && Array.isArray(d.findings) && d.findings.length >= 8)) return false;
         return validateTeardownHonesty(d);
       } });
  const html = renderTeardownHtml(url, audit);
  return {
    files: [
      { name: "teardown.html", mime: "text/html", kind: "text", content: html },
      { name: "teardown.json", mime: "application/json", kind: "text", content: JSON.stringify(audit, null, 2) },
    ],
    images: [],
    summary: `10-point teardown of ${url}: score ${audit.score}/100, ${audit.findings.length} findings, ${audit.rewrites ? audit.rewrites.length : 0} rewrites.`,
  };
}

async function buildLogo(env, inputs) {
  const brand_name = cleanText(inputs.brand_name, 120);
  if (!brand_name) throw Object.assign(new Error("missing_brand_name"), { status: 400 });
  const spec = FEATURES["logo-refresh"].full({
    brand_name,
    industry: cleanText(inputs.industry, 120),
    brand_blurb: cleanText(inputs.brand_blurb, 2000),
    current_logo_desc: cleanText(inputs.current_logo_desc, 1000),
  });
  const { parsed: data } = await runTextJson(env, MODELS[spec.model], [
    { role: "system", content: spec.system },
    { role: "user", content: spec.user },
  ], { max_tokens: 4000, temperature: 0.7, retries: 2, label: "logo",
       validate: withClaims((d) => d && Array.isArray(d.directions) && d.directions.length >= 3, inputs) });
  const md = renderUsageSheet(brand_name, data);
  const images = data.directions.slice(0, 3).map((d, i) => ({
    name: `logo-concept-${i + 1}.png`,
    flux_prompt: String(d.flux_prompt || d.concept || "").slice(0, 2000),
    overlay_text: (d.overlay_text && typeof d.overlay_text === "object") ? d.overlay_text : {},
    overlay_kind: "logo-lockup",
    width: 1024,
    height: 1024,
    label: d.name,
  }));
  // Overlay validation is advisory at build time: a broken spec never ships
  // silently — it is logged and the compositor falls back to no text.
  for (const img of images) {
    const v = validateOverlaySpec(img.overlay_text, "logo-refresh");
    if (!v.ok) console.error("designful/logo overlay spec invalid", img.label, v.errors.join("; "));
    img.overlay_valid = v.ok;
    img.overlay_errors = v.errors;
  }
  return {
    files: [
      { name: "concepts.json", mime: "application/json", kind: "text", content: JSON.stringify(data.directions, null, 2) },
      { name: "usage-sheet.md", mime: "text/markdown", kind: "text", content: md },
    ],
    images,
    brand: brand_name,
    summary: `3 logo concepts for ${brand_name} + usage sheet.`,
  };
}

async function buildAdPack(env, inputs) {
  const product_description = cleanText(inputs.product_description, 2000);
  if (!product_description) throw Object.assign(new Error("missing_product_description"), { status: 400 });
  const spec = FEATURES["ad-creative-pack"].full({
    product_description,
    audience: cleanText(inputs.audience, 500),
    positioning: cleanText(inputs.positioning, 500),
    brand_look: cleanText(inputs.brand_look, 500),
  });
  const { parsed: data } = await runTextJson(env, MODELS[spec.model], [
    { role: "system", content: spec.system },
    { role: "user", content: spec.user },
  ], { max_tokens: 4000, temperature: 0.8, retries: 2, label: "adpack",
       validate: withClaims((d) => d && Array.isArray(d.creatives) && d.creatives.length >= 5 &&
         d.creatives.every((c) => c.overlay_text && typeof c.overlay_text.headline === "string"), inputs) });
  const images = [];
  data.creatives.slice(0, 5).forEach((c, i) => {
    const fp = String(c.flux_prompt || c.visual_concept || "").slice(0, 2000);
    const ov = (c.overlay_text && typeof c.overlay_text === "object") ? c.overlay_text : {};
    const v = validateOverlaySpec(ov, "ad-creative-pack");
    if (!v.ok) console.error("designful/ad overlay spec invalid", `creative ${i + 1}`, v.errors.join("; "));
    const base = { flux_prompt: fp, overlay_text: ov, overlay_kind: "ad-creative", overlay_valid: v.ok, overlay_errors: v.errors, label: `Creative ${i + 1}` };
    images.push(Object.assign({ name: `ad-${i + 1}-1x1.png`, width: 1024, height: 1024, label: `Creative ${i + 1} (1:1)` }, base));
    images.push(Object.assign({ name: `ad-${i + 1}-9x16.png`, width: 768, height: 1344, label: `Creative ${i + 1} (9:16)` }, base));
  });
  return {
    files: [
      { name: "headlines.json", mime: "application/json", kind: "text", content: JSON.stringify(data.creatives, null, 2) },
    ],
    images,
    summary: `5 ad creatives × 2 ratios (1:1 + 9:16), each with curiosity/proof/objection-killer headline variants.`,
  };
}

async function buildSocialKit(env, inputs) {
  const brand_blurb = cleanText(inputs.brand_blurb, 2000);
  if (!brand_blurb) throw Object.assign(new Error("missing_brand_blurb"), { status: 400 });
  const spec = FEATURES["social-launch-kit"].full({
    brand_name: cleanText(inputs.brand_name, 120),
    brand_blurb,
    audience: cleanText(inputs.audience, 500),
    brand_look: cleanText(inputs.brand_look, 500),
    pillars_summary: cleanText(inputs.pillars_summary, 500),
  });
  const { parsed: data } = await runTextJson(env, MODELS[spec.model], [
    { role: "system", content: spec.system },
    { role: "user", content: spec.user },
  ], { max_tokens: 6000, temperature: 0.7, retries: 2, label: "social",
       validate: withClaims((d) => d && Array.isArray(d.templates) && d.templates.length >= 10 &&
         d.templates.every((t) => t.overlay_text && typeof t.overlay_text.hook === "string"), inputs) });
  const images = data.templates.slice(0, 10).map((t, i) => {
    const ov = (t.overlay_text && typeof t.overlay_text === "object") ? t.overlay_text : {};
    const v = validateOverlaySpec(ov, "social-launch-kit");
    const label = `Day ${i + 1} — ${t.pillar || t.job || ""}`;
    if (!v.ok) console.error("designful/social overlay spec invalid", label, v.errors.join("; "));
    return {
      name: `template-day-${String(i + 1).padStart(2, "0")}.png`,
      flux_prompt: String(t.flux_prompt || t.visual_concept || "").slice(0, 2000),
      overlay_text: ov,
      overlay_kind: "social-template",
      overlay_valid: v.ok,
      overlay_errors: v.errors,
      width: 1024,
      height: 1280, // 4:5 portrait, IG-friendly
      label,
    };
  });
  return {
    files: [
      { name: "captions.json", mime: "application/json", kind: "text", content: JSON.stringify(data.templates, null, 2) },
    ],
    images,
    brand: cleanText(inputs.brand_name, 120) || undefined,
    summary: `10 social templates (4 attract / 3 teach / 3 convert) with hooks, visuals, and caption starters.`,
  };
}

async function buildHero(env, inputs) {
  const hero_copy = cleanText(inputs.hero_copy, 2000);
  if (!hero_copy) throw Object.assign(new Error("missing_hero_copy"), { status: 400 });
  const spec = FEATURES["hero-rewrite"].full({
    hero_copy,
    product_description: cleanText(inputs.product_description, 1000),
    audience: cleanText(inputs.audience, 500),
    proof: cleanText(inputs.proof, 1000),
  });
  const { parsed: data } = await runTextJson(env, MODELS[spec.model], [
    { role: "system", content: spec.system },
    { role: "user", content: spec.user },
  ], { max_tokens: 3000, temperature: 0.7, retries: 2, label: "hero",
       validate: withClaims((d) => d && Array.isArray(d.headlines) && d.headlines.length >= 3, inputs) });
  const md = renderHeroMd(inputs, data);
  return {
    files: [
      { name: "hero-rewrite.md", mime: "text/markdown", kind: "text", content: md },
      { name: "hero.json", mime: "application/json", kind: "text", content: JSON.stringify(data, null, 2) },
    ],
    images: [],
    summary: `Full hero rewrite: 5 headlines, subhead, CTA copy, trust bullets + conversion notes.`,
  };
}

const BUILDERS = {
  "homepage-teardown": buildTeardown,
  "logo-refresh": buildLogo,
  "ad-creative-pack": buildAdPack,
  "social-launch-kit": buildSocialKit,
  "hero-rewrite": buildHero,
};

// ── renderers ─────────────────────────────────────────────────────────────

function renderTeardownHtml(url, audit) {
  const sevLabel = { 1: "Nitpick", 2: "Worth fixing", 3: "Hurting conversions", 4: "Major leak", 5: "Critical" };
  const sevColor = { 1: "#6b7280", 2: "#2563eb", 3: "#d97706", 4: "#dc2626", 5: "#7f1d1d" };
  const findings = (audit.findings || [])
    .map((f) => `
      <div class="finding">
        <div class="finding-head"><span class="area">${esc(f.area)}</span>
        <span class="sev" style="background:${sevColor[f.severity] || "#6b7280"}">${esc(sevLabel[f.severity] || f.severity)} · ${esc(f.severity)}/5</span></div>
        <p><strong>Observed:</strong> ${esc(f.observation)}</p>
        <p><strong>Fix:</strong> ${esc(f.fix)}</p>
      </div>`)
    .join("");
  const rewrites = (audit.rewrites || [])
    .map((r) => `
      <div class="rewrite">
        <div class="finding-head"><span class="area">${esc(r.element)} — priority ${esc(r.priority)}</span></div>
        <p><strong>Before:</strong> ${esc(r.original)}</p>
        <p><strong>After:</strong> ${esc(r.rewrite)}</p>
        <p class="why">${esc(r.why)}</p>
      </div>`)
    .join("");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Homepage Teardown — ${esc(url)}</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:820px;margin:40px auto;padding:0 20px;color:#111827;line-height:1.6}
h1{font-size:28px}h2{margin-top:36px;border-bottom:2px solid #111827;padding-bottom:6px}
.score{font-size:56px;font-weight:800}.finding,.rewrite{border:1px solid #e5e7eb;border-radius:10px;padding:16px;margin:14px 0}
.finding-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.area{font-weight:700;text-transform:capitalize}.sev{color:#fff;font-size:12px;padding:3px 10px;border-radius:999px}
.why{color:#4b5563;font-style:italic}.foot{margin-top:40px;color:#6b7280;font-size:13px}</style></head>
<body><h1>Homepage Teardown</h1><p>${esc(url)}</p>
<div class="score">${esc(audit.score)}<span style="font-size:20px;color:#6b7280">/100</span></div>
<p>${esc(audit.verdict)}</p>
<h2>Findings (by severity)</h2>${findings}
<h2>Prioritized rewrites</h2>${rewrites}
<p class="foot">Generated by Designful · designful.mehyar.us</p></body></html>`;
}

function renderUsageSheet(brand, data) {
  const dirs = (data.directions || [])
    .map((d, i) => `## Direction ${i + 1}: ${d.name}\n**Archetype:** ${d.archetype}\n\n${d.concept}\n\n**Palette:**\n${(d.palette || []).map((p) => `- \`${p.hex}\` — ${p.role} (${p.usage})`).join("\n")}\n\n**Typography:** ${d.typography}\n\n**Why it works:** ${d.why_it_works}\n`)
    .join("\n---\n\n");
  const u = data.usage_sheet || {};
  return `# Logo Refresh — ${brand}\n\n${dirs}\n\n---\n\n# Usage sheet\n\n**Clearspace:** ${u.clearspace || ""}\n\n**Minimum sizes:** print ${u.min_sizes && u.min_sizes.print}; digital ${u.min_sizes && u.min_sizes.digital}\n\n**Don'ts:**\n${(u.donts || []).map((x) => `- ${x}`).join("\n")}\n\n---\n_Generated by Designful · designful.mehyar.us_`;
}

function renderHeroMd(inputs, data) {
  const heads = (data.headlines || [])
    .map((h, i) => `### ${i + 1}. ${h.text}\n_Structure: ${h.structure}_ — ${h.why}\n`)
    .join("\n");
  return `# Hero Rewrite\n\n${inputs.product_description ? `**Product:** ${inputs.product_description}\n` : ""}${inputs.audience ? `**Audience:** ${inputs.audience}\n` : ""}\n## Headlines\n\n${heads}\n## Subhead\n\n${data.subhead}\n\n## CTAs\n\n- **Primary:** ${data.cta_primary}\n- **Secondary:** ${data.cta_secondary}\n\n## Trust bullets\n\n${(data.trust_bullets || []).map((b) => `- ${b}`).join("\n")}\n\n## Why this converts\n\n${(data.why_this_converts || []).map((w) => `- ${w}`).join("\n")}\n\n---\n_Generated by Designful · designful.mehyar.us_`;
}

// ── main handler ──────────────────────────────────────────────────────────
export async function onRequestPost({ request, env }) {
  try {
    const db = env.LEADS_DB;
    if (!db) return json({ ok: false, error: "no_db" }, 503);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "bad_json" }, 400);
    }
    const order_token = body && body.order_token;
    const feature = body && body.feature;
    if (!order_token || !feature) return json({ ok: false, error: "missing_params" }, 400);
    if (!FEATURES[feature]) return json({ ok: false, error: "unknown_feature" }, 400);

    const order = await db
      .prepare("SELECT * FROM designful_orders WHERE access_token = ?")
      .bind(String(order_token))
      .first();
    if (!order) return json({ ok: false, error: "unknown_order" }, 404);
    if (!["paid", "ready", "failed"].includes(order.status)) {
      return json({ ok: false, error: "order_not_payable", status: order.status }, 403);
    }

    // ── authorization: which features may this order generate? ──
    let state = {};
    try {
      state = JSON.parse(order.inputs_json || "{}");
    } catch {}
    const used = Array.isArray(state.used_features) ? state.used_features : [];
    const singleFeature = PRODUCT_FEATURE[order.product_id];
    if (singleFeature) {
      if (feature !== singleFeature) {
        return json({ ok: false, error: "feature_not_covered" }, 403);
      }
      // Idempotent replay: already generated → return the stored manifest.
      if (used.includes(feature) && order.status === "ready" && order.output_json) {
        return json({ ok: true, feature, manifest: JSON.parse(order.output_json), replay: true });
      }
    } else {
      // Bundle: any feature until slots run out.
      const slots = Number(order.bundle_slots) || 0;
      if (used.includes(feature) && order.status === "ready" && order.output_json) {
        // Return just this feature's slice if we stored per-feature manifests.
        const prior = JSON.parse(order.output_json);
        const slice = (prior.manifests || {})[feature];
        if (slice) return json({ ok: true, feature, manifest: slice, replay: true });
      }
      if (used.length >= slots) {
        return json({ ok: false, error: "slots_exhausted", used, slots }, 403);
      }
    }

    // ── build the deliverable ──
    const builder = BUILDERS[feature];
    if (!builder) return json({ ok: false, error: "no_builder" }, 500);
    const mergedInputs = Object.assign({}, state.inputs || {}, body.inputs || {});
    let built;
    try {
      built = await builder(env, mergedInputs);
    } catch (e) {
      const status = (e && e.status) || 500;
      console.error("designful/generate build failed", feature, e && e.message);
      if (status !== 500) return json({ ok: false, error: String(e.message || "build_failed") }, status);
      await db.prepare(`UPDATE designful_orders SET status='failed' WHERE id=?`).bind(order.id).run();
      return json({ ok: false, error: "build_failed" }, 500);
    }

    // ── images → R2 in prod; dev-manifest otherwise ──
    const canStore = !!env.DESIGNFUL_R2;
    const prefix = `designful/${order.access_token}/${feature}`;
    const files = [];

    for (const f of built.files) {
      if (canStore) {
        const key = `${prefix}/${f.name}`;
        await env.DESIGNFUL_R2.put(key, new TextEncoder().encode(f.content), {
          httpMetadata: { contentType: f.mime },
        });
        files.push({ name: f.name, mime: f.mime, storage: "r2:" + key });
      } else {
        files.push({
          name: f.name,
          mime: f.mime,
          storage: "dev:inline",
          content_preview: String(f.content).slice(0, 4000),
        });
      }
    }

    if (canStore && built.images.length) {
      // Bounded fan-out: 3 concurrent image pipelines (lesson: 1 image per
      // AI call). Each pipeline = flux render + vision QC gate, with
      // auto-regenerate up to MAX_QC_RETRIES on gibberish-text failures.
      const results = await boundedMap(built.images, 3, async (img) => {
        const art = await generateArtwork(env, img.flux_prompt, {
          width: img.width,
          height: img.height,
          label: img.label || img.name,
        });
        if (!art.ok) {
          // QC gate exhausted: never ship a gibberish image as if it were
          // fine. The manifest records the failure; the buyer is owed a
          // re-render (see INTEGRATION.md retry policy).
          return {
            name: img.name,
            error: "image_qc_failed",
            attempts: art.attempts,
            qc_notes: art.qc && art.qc.notes,
            flux_prompt: img.flux_prompt,
          };
        }
        const key = `${prefix}/${img.name.replace(/\.png$/i, "")}.${art.ext}`;
        const bytes = Uint8Array.from(atob(art.base64), (c) => c.charCodeAt(0));
        await env.DESIGNFUL_R2.put(key, bytes, { httpMetadata: { contentType: art.mime } });
        const entry = {
          name: key.split("/").pop(),
          mime: art.mime,
          storage: "r2:" + key,
          label: img.label,
          qc_attempts: art.attempts,
          overlay: overlayHandoff(feature, img.overlay_text, { brand: built.brand }),
        };
        // Only hand valid overlay specs to the client compositor.
        if (img.overlay_valid === false) {
          entry.overlay.warnings = img.overlay_errors || ["overlay spec invalid"];
        }
        return entry;
      });
      for (const r of results) {
        if (r.ok) files.push(r.value);
        else files.push({ name: "image_failed", storage: "r2:failed", error: String(r.error).slice(0, 120) });
      }
    } else {
      for (const img of built.images) {
        const entry = {
          name: img.name,
          mime: "image/png",
          storage: canStore ? "r2:pending" : "dev:skipped-no-r2",
          flux_prompt: img.flux_prompt, // prompt reviewable without spending neurons
          label: img.label,
          dims: `${img.width}x${img.height}`,
          overlay: overlayHandoff(feature, img.overlay_text, { brand: built.brand }),
        };
        if (img.overlay_valid === false) entry.overlay.warnings = img.overlay_errors || ["overlay spec invalid"];
        files.push(entry);
      }
    }

    const manifest = {
      ok: true,
      feature,
      order_id: order.id,
      files,
      summary: built.summary,
      generated_at: new Date().toISOString(),
      mode: canStore ? "prod" : "dev",
    };

    // ── persist: order → ready; bundles append used_features ──
    const nextUsed = used.includes(feature) ? used : [...used, feature];
    const nextState = Object.assign({}, state, { used_features: nextUsed });
    if (singleFeature) {
      await db
        .prepare(`UPDATE designful_orders SET status='ready', output_json=?, ready_at=${nowSql}, inputs_json=? WHERE id=?`)
        .bind(JSON.stringify(manifest), JSON.stringify(nextState), order.id)
        .run();
    } else {
      // Bundles accumulate one manifest per feature under manifests{}.
      let prior = {};
      try {
        prior = JSON.parse(order.output_json || "{}");
      } catch {}
      const manifests = Object.assign({}, prior.manifests || {}, { [feature]: manifest });
      await db
        .prepare(`UPDATE designful_orders SET status='ready', output_json=?, ready_at=${nowSql}, inputs_json=? WHERE id=?`)
        .bind(JSON.stringify({ manifests, slots: Number(order.bundle_slots) || 0 }), JSON.stringify(nextState), order.id)
        .run();
    }

    return json({ ok: true, feature, manifest });
  } catch (e) {
    console.error("designful/generate failed", e && e.message);
    return json({ ok: false, error: "generate_failed" }, 500);
  }
}
