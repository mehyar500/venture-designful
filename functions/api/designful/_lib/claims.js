/**
 * claims.js — deterministic unsupported-claim detection.
 *
 * Prompt preflights tell the model not to invent ratings, guarantees,
 * discounts, scarcity, or superlatives, but validation showed the model
 * still does ("5-Star Chef Meals", "Cozy Ambiance Guaranteed",
 * "Limited stock alert", "Gift sets available"). Natural-language
 * instructions are not a gate. This module is.
 *
 * findUnsupportedClaims(parsed, inputs) scans every string in the parsed
 * output for claim patterns and checks each hit against the raw intake
 * inputs: a claim is allowed only if the inputs actually support it.
 * Returns an array of { category, phrase, grounded } for ungrounded hits.
 *
 * Wire into runTextJson as a composed validator: schema failures and claim
 * failures both trigger a repair retry, with the repair nudge naming the
 * exact offending phrases so the model can fix them.
 */

// Each rule: pattern to find in output, and the input-evidence patterns
// that would ground it. A hit is ungrounded when NONE of the evidence
// patterns match the serialized inputs.
const RULES = [
  {
    category: "rating",
    pattern: /\b\d(?:\.\d)?\s*-?\s*stars?\b|\bfive[-\s]?star\b|\b\d[\d,]*\s+(?:reviews?|ratings?|testimonials?)\b/i,
    evidence: [/star/i, /rating/i, /review/i, /testimonial/i, /\b4\.\d\b|\b5\.0\b/],
    hint: "a star rating or review count",
  },
  {
    category: "guarantee",
    pattern: /\bguarantee[ds]?\b/i,
    evidence: [/guarantee/i, /warranty/i, /money[-\s]?back/i],
    hint: "a guarantee or warranty",
  },
  {
    category: "scarcity",
    pattern: /\blimited\s+(?:stock|quantity|time|offer|edition|supply)\b|\bonly\s+\d+\s+left\b|\bselling\s+fast\b|\balmost\s+gone\b|\bwhile\s+supplies\s+last\b|\bhurry\b|\bdon'?t\s+miss\s+out\b/i,
    evidence: [/limited/i, /scarc/i, /only \d+ left/i, /selling fast/i, /deadline/i, /ends /i],
    hint: "scarcity or a deadline",
  },
  {
    category: "discount",
    pattern: /\b\d+\s*%\s*off\b|\bon\s+sale\b|\bclearance\b|\bdiscount(?:ed)?\b|\bpromo(?:tion)?(?:al)?\s+code\b|\bcoupon\b|\bbogo\b|\bmarked\s+down\b/i,
    evidence: [/%/, /discount/i, /coupon/i, /promo/i, /clearance/i, /marked down/i, /sale price/i, /\bon sale\b/i],
    hint: "a discount, sale, or promo",
  },
  {
    category: "superlative",
    pattern: /\bthe\s+best\b|\b#1\b|\bnumber\s+one\b|\bworld[-\s]?class\b|\bindustry[-\s]?leading\b|\bonly\s+(?:one|place|shop|store)\b|\bfirst\s+ever\b/i,
    evidence: [/best/i, /#1/, /number one/i, /world.?class/i, /industry.?lead/i, /award/i, /only one/i],
    hint: "a best/#1/only claim",
  },
  {
    category: "gift",
    pattern: /\bgift\s+sets?\b|\bperfect\s+gift\b|\bgreat\s+gift\b/i,
    // "gift buyers" (audience) does NOT ground a gift-set product claim —
    // need product-offering language.
    evidence: [/gift set/i, /gift box/i, /gift wrap/i, /perfect gift/i, /great gift/i, /\bgifted\b/i, /giftable/i],
    hint: "gift sets",
  },
  {
    category: "freebie",
    pattern: /\bfree\s+(?:shipping|trial|sample|consultation|gift|ebook|guide)\b/i,
    evidence: null, // special-cased below: the same freebie must be in inputs
    hint: "something free",
  },
];

/** Collect every string value in a nested object/array, with a label path. */
function collectStrings(value, out = []) {
  if (typeof value === "string") {
    if (value.length > 1) out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectStrings(v, out);
  }
  return out;
}

/**
 * Scan parsed output for ungrounded claims.
 * @returns {Array<{category, phrase, hint}>} — empty when clean.
 */
export function findUnsupportedClaims(parsed, inputs) {
  const inputText = JSON.stringify(inputs || {});
  const hits = [];
  const seen = new Set();
  for (const str of collectStrings(parsed)) {
    for (const rule of RULES) {
      const m = rule.pattern.exec(str);
      if (!m) continue;
      const key = rule.category + "|" + m[0].toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      let grounded;
      if (rule.evidence === null) {
        // freebie: the exact freebie phrase must appear in the inputs
        grounded = new RegExp(m[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(inputText);
      } else {
        grounded = rule.evidence.some((re) => re.test(inputText));
      }
      if (!grounded) hits.push({ category: rule.category, phrase: m[0], hint: rule.hint });
    }
  }
  return hits;
}

/** True when the parsed output has no ungrounded claims. */
export function claimsClean(parsed, inputs) {
  return findUnsupportedClaims(parsed, inputs).length === 0;
}

/** Repair nudge naming the exact offending phrases. */
export function claimRepairNudge(hits) {
  const items = hits.map((h) => `"${h.phrase}" (${h.category}: no ${h.hint} in the customer inputs)`).join("; ");
  return (
    `Unsupported claims detected: ${items}. ` +
    `Delete each of these claims. Then replace it with a vivid, specific alternative ` +
    `grounded ONLY in the customer inputs — keep the copy punchy and concrete, ` +
    `never generic filler. Do not rephrase around the banned claim.`
  );
}

/**
 * Teardown honesty gate (deterministic). The audit only receives a TEXT
 * EXTRACT, so mobile/speed findings MUST use exactly "not assessable from
 * inputs" with severity ≤2 — the prompt says this, but validation proved the
 * model paraphrases ("Not visible in inputs"). Returns true or a repair string.
 */
const HONESTY_PHRASE = "not assessable from inputs";
export function validateTeardownHonesty(audit) {
  const problems = [];
  for (const f of (audit && audit.findings) || []) {
    if (f.area !== "mobile" && f.area !== "speed") continue;
    if (String(f.observation || "").trim().toLowerCase() !== HONESTY_PHRASE) {
      problems.push(`${f.area}.observation must be exactly "${HONESTY_PHRASE}" (got "${String(f.observation || "").slice(0, 60)}")`);
    }
    if (!(f.severity <= 2)) {
      problems.push(`${f.area}.severity must be ≤2 for unassessable areas (got ${f.severity})`);
    }
  }
  if (!problems.length) return true;
  return (
    `Teardown honesty failures: ${problems.join("; ")}. ` +
    `You cannot grade mobile rendering or load speed from a text extract — ` +
    `set the observation to exactly "${HONESTY_PHRASE}", severity 1 or 2.`
  );
}
