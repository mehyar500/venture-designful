// functions/api/designful/_lib/pipeline.js
// Typography pipeline + vision QC gate for Designful.
//
// ROOT CAUSE (proven 2026-09-15): flux-1-schnell bakes garbled pseudo-text
// into images ("hiGRNER CERlid", "Em ber Oak"). "No text" prompt instructions
// reduce but do NOT eliminate it. So the pipeline is:
//
//   LLM emits {flux_prompt (TEXT-FREE), overlay_text spec (exact words)}
//     → flux renders text-free artwork
//     → vision QC: ONE image per call, "transcribe all visible text; flag
//       gibberish or fake words" — auto-regenerate up to MAX_QC_RETRIES
//     → manifest carries {artwork, overlay_text}; the CLIENT composites the
//       real typography with actual fonts (Workers can't run PIL).
//
// All functions are pure except the env.AI calls, and everything is exported
// so the local Node harness can unit-test the logic with a mocked env.

import { runImage, runVision } from "./ai.js";

export const MAX_QC_RETRIES = 3; // total attempts per image: 1 + 3 regenerations

// ── vision QC ─────────────────────────────────────────────────────────────
// Ask for JSON; fall back to keyword heuristics because vision models don't
// always honor the format. A "clean" image has no visible text at all.
export const QC_VISION_PROMPT =
  `Look carefully at this AI-generated artwork. It was supposed to contain ZERO text, ` +
  `but image models sometimes bake in garbled pseudo-text, fake labels, or partial letters.\n\n` +
  `Transcribe ALL visible text, letters, letter fragments, and pseudo-typography shapes. ` +
  `If there is no text at all, say so.\n\n` +
  `Then give your verdict as JSON on its own line: ` +
  `{"visible_text": "<everything you found, or 'none'>", ` +
  `"gibberish": true|false, ` +
  `"notes": "<one sentence>"}\n\n` +
  `gibberish=true if ANY of: garbled pseudo-words, misspelled words, fake brand labels, ` +
  `partial/cropped letters that look like text, watermark-like text, or letter fragments ` +
  `shaped like typography. A decorative pattern that no one would read as letters is fine.`;

const GIBBERISH_KEYWORDS = [
  "gibberish",
  "pseudo-word",
  "pseudo-word",
  "pseudo word",
  "fake word",
  "misspelled",
  "garbled",
  "unreadable",
  "not real",
  "nonsense text",
  "random letters",
  "letter fragments",
  "partial letters",
];

/** Parse a vision QC response. Returns {clean, visible_text, gibberish, notes}.
 * STRICT zero-text rule: the artwork must contain no text at all, so ANY
 * transcribed visible text (other than "none") fails QC — even when the
 * vision model itself marks gibberish:false. Round-2 evidence: the vision
 * model transcribed "The Kinily Coffee ZERO" and "$59.99, $9.90, LUMPOCE"
 * while still claiming gibberish:false. Never trust the model's own flag
 * when its transcription says otherwise. */
const NO_TEXT_CLAIM = /^(none|no text|n\/a|nothing|no visible text)\.?$/i;
export function parseQCVerdict(raw) {
  const s = String(raw || "");
  // Try the JSON verdict line first.
  const m = /\{[^{}]*"gibberish"\s*:\s*(true|false)[^{}]*\}/i.exec(s);
  if (m) {
    try {
      const v = JSON.parse(m[0]);
      const seen = String(v.visible_text || "").trim();
      const hasText = seen.length > 0 && !NO_TEXT_CLAIM.test(seen);
      const gib = v.gibberish === true || hasText;
      return {
        clean: !gib,
        visible_text: seen,
        gibberish: gib,
        notes: String(v.notes || "").slice(0, 300),
      };
    } catch {
      /* fall through to keywords */
    }
  }
  // Keyword fallback: "no text" language means clean unless flagged.
  const low = s.toLowerCase();
  const flagged = GIBBERISH_KEYWORDS.some((k) => low.includes(k));
  const claimsNone = /no (visible |legible )?text|contains no text|zero text|text[-\s]?free/i.test(s);
  return {
    clean: !flagged && claimsNone,
    visible_text: flagged ? s.slice(0, 300) : "",
    gibberish: flagged,
    notes: flagged ? "keyword fallback flagged text" : "keyword fallback: no text claimed",
  };
}

/**
 * Vision-QC one image. imageUrl must be a data: URI (the vision model rejects
 * remote HTTPS URLs). Returns parseQCVerdict() of the response.
 */
export async function qcImage(env, imageUrl) {
  const raw = await runVision(env, imageUrl, QC_VISION_PROMPT, { max_tokens: 1024 });
  return parseQCVerdict(raw);
}

/**
 * Generate text-free artwork with QC gate: render → QC → regenerate on
 * failure, up to MAX_QC_RETRIES extra attempts. Returns
 * { base64, mime, ext, attempts, qc, ok }.
 * Throws when the image model itself errors; QC exhaustion is NOT a throw —
 * it returns ok:false so the caller can degrade gracefully (never ship a
 * gibberish image as if it were fine).
 *
 * Defense in depth: the zero-text rule is appended server-side to EVERY
 * flux prompt. Round-2 evidence: the model sometimes drops the rule from
 * flux_prompt even when the spec demands it, and Flux then bakes in fake
 * labels/prices. Never rely on model compliance for this.
 */
export const ZERO_TEXT_SUFFIX =
  " CRITICAL: the image must contain absolutely no text, letters, numbers, " +
  "words, labels, signs, prices, logos with lettering, or watermark-like " +
  "shapes anywhere. Pure imagery only.";
/**
 * Safe-mode fallback prompt. Used when the original scene fails QC twice:
 * Flux bakes fake labels onto product packaging no matter what the prompt
 * says, so the fallback removes the products entirely. An abstract
 * background + composited typography is still a shippable template/ad —
 * the overlay carries the message.
 */
const SAFE_MODE_PROMPT =
  "Abstract premium background, soft warm gradient tones, subtle film grain " +
  "and gentle light texture, generous empty negative space in the center, " +
  "minimal high-end aesthetic, no objects, no products, no packaging, " +
  "no bottles, no jars, no boxes, no paper, no books.";

/** Flux's safety filter false-positives (error 8007) on innocuous prompts —
 * "red circle on white" was flagged in validation. It is flaky: the same
 * prompt usually passes on retry. Treat it as transient, not fatal. */
function isTransientImageError(e) {
  return /8007|nsfw/i.test(String((e && e.message) || e));
}

async function runImageTransient(env, prompt, label) {
  let last = null;
  for (let i = 1; i <= 3; i++) {
    try {
      return await runImage(env, prompt, {});
    } catch (e) {
      last = e;
      if (!isTransientImageError(e) || i === 3) throw e;
      console.error(`designful/flux ${label}: transient error, retry ${i}/3`, String(e.message).slice(0, 120));
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
  throw last;
}

export async function generateArtwork(env, fluxPrompt, opts = {}) {
  // width/height are TARGET layout dims for the downstream compositor only —
  // they are NOT sent to the image model (flux returns 1024x1024 square;
  // runImage() documents why). actual_width/actual_height in the result are
  // sniffed from the bytes so manifests never claim a size they don't have.
  const { width = 1024, height = 1024, label = "artwork" } = opts;
  let last = null;
  for (let attempt = 1; attempt <= 1 + MAX_QC_RETRIES; attempt++) {
    // Attempts 1-2: the art-directed scene. Attempts 3+: safe mode — the
    // scene kept baking fake labels, so drop the products entirely rather
    // than burning the remaining retries on the same text magnet.
    const safeMode = attempt >= 3;
    const base = safeMode ? SAFE_MODE_PROMPT : String(fluxPrompt || "");
    const prompt = base.includes("no text") ? base : base + ZERO_TEXT_SUFFIX;
    // Transient model errors (flaky 8007 NSFW false-positives) are retried
    // inside runImageTransient; real QC verdicts below consume an attempt.
    const { base64, mime, ext, width: aw, height: ah } = await runImageTransient(env, prompt, label);
    const dataUri = `data:${mime};base64,${base64}`;
    const verdict = await qcImage(env, dataUri);
    last = { base64, mime, ext, attempts: attempt, qc: verdict,
             prompt_mode: safeMode ? "safe" : "original",
             target_width: width, target_height: height,
             actual_width: aw, actual_height: ah };
    if (verdict.clean) return { ...last, ok: true };
    console.error(`designful/qc ${label}: attempt ${attempt}${safeMode ? " (safe)" : ""} failed QC`, verdict.notes);
  }
  return { ...last, ok: false };
}

// ── overlay spec validation ───────────────────────────────────────────────
// The LLM supplies exact words to composite; garbage in = garbage out.
// Every field is length-capped because the client canvas has fixed space.

const FIELD_CAPS = {
  wordmark: 40,
  tagline: 80,
  headline: 90, // ~12 words
  hook: 90, // ~12 words
  brand: 40,
  cta: 40,
};

const SUPERLATIVES_RE = /\b(only|best|#1|number one|first ever|first)\b/i;
const BANNED_RE =
  /\b(visually stunning|visually appealing|seamless|c cutting-edge|state-of-the-art|leverage|elevate|take your \w+ to the next level|in today's fast-paced digital world|unlock the power of|game-changer|revolutionize|delve|tapestry|empower|robust|holistic|synergy|best-in-class|world-class|next-level)\b/i;

/** Shared SUPERLATIVES rule: returns the offending match or null. */
export function findSuperlative(text) {
  const m = SUPERLATIVES_RE.exec(String(text || ""));
  return m ? m[0] : null;
}

export function findBannedPhrase(text) {
  const m = BANNED_RE.exec(String(text || ""));
  return m ? m[0] : null;
}

/**
 * Validate an overlay_text spec for a feature. Returns {ok, errors[]}.
 * Required fields per feature: logo → wordmark; ad → headline + cta;
 * social → hook.
 */
export function validateOverlaySpec(spec, feature) {
  const errors = [];
  if (!spec || typeof spec !== "object") return { ok: false, errors: ["overlay_text missing"] };
  const required =
    feature === "logo-refresh" ? ["wordmark"]
    : feature === "ad-creative-pack" ? ["headline", "cta"]
    : feature === "social-launch-kit" ? ["hook"]
    : [];
  for (const f of required) {
    if (!spec[f] || !String(spec[f]).trim()) errors.push(`missing required overlay field: ${f}`);
  }
  for (const [field, cap] of Object.entries(FIELD_CAPS)) {
    const v = spec[field];
    if (v == null) continue;
    const s = String(v);
    if (s.length > cap) errors.push(`overlay.${field} too long (${s.length} > ${cap} chars)`);
    if (s && s !== s.trim()) errors.push(`overlay.${field} has leading/trailing whitespace`);
    const sup = findSuperlative(s);
    if (sup) errors.push(`overlay.${field} has unverified superlative "${sup}"`);
    const banned = findBannedPhrase(s);
    if (banned) errors.push(`overlay.${field} uses banned phrase "${banned}"`);
    if (/[A-Za-z]{9,}/.test(s) && /[A-Z]{5,}/.test(s) && !/\s/.test(s.replace(/[A-Z]{5,}/, ""))) {
      // single 9+ letter run with 5+ caps and no real word structure — likely
      // the LLM echoing model-style pseudo text into the spec.
      errors.push(`overlay.${field} looks like pseudo-text, not real words`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// ── client handoff shape ──────────────────────────────────────────────────
// What generate.js attaches to each manifest image entry so deliverable.html
// (compositor.js) can draw it. kind selects the canvas layout template.
export function overlayHandoff(feature, overlay, defaults = {}) {
  const kind =
    feature === "logo-refresh" ? "logo-lockup"
    : feature === "ad-creative-pack" ? "ad-creative"
    : feature === "social-launch-kit" ? "social-template"
    : "generic";
  // Backfill: the model sometimes returns brand:null even though the brand
  // is a known input. A missing footer is worse than a repeated known brand.
  const spec = overlay && typeof overlay === "object" ? { ...overlay } : {};
  if (!spec.brand && defaults.brand) spec.brand = defaults.brand;
  return { kind, feature, overlay: spec };
}
