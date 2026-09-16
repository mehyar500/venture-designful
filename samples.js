/* Designful sample outputs — real validation-run output used for
 * before/after and gallery blocks on feature pages.
 * Text samples are verbatim preview outputs; images are clean renders
 * (free previews are watermarked). */
const DESIGNFUL_SAMPLES = {
  "homepage-teardown": {
    caption: "Real preview output from a validation run.",
    before: {
      label: "Before",
      html: '<p style="margin:0"><span class="score-ring">40</span><span style="color:var(--muted)">/100</span></p>' +
        '<p class="ba-meta">First-impression score for a real homepage. Biggest conversion killer: repetitive, lengthy copy — sections repeat so often the value proposition gets buried.</p>'
    },
    after: {
      label: "After — Teardown preview",
      html: '<blockquote style="text-decoration:none;color:var(--text)">Cut the repeated sections, lead with the one line a first-time visitor needs: what you get, who it\'s for, what to do next.</blockquote>' +
        '<p class="ba-meta">Free preview: the score, the single biggest killer, and one fix. The $49 unlock: the full 10-point annotated teardown with specific fixes and 3 prioritized rewrites. Mobile and speed are labeled "not assessable from inputs" — we don\'t guess.</p>'
    },
    gallery: []
  },
  "logo-refresh": {
    caption: "Three concept directions from one validation run.",
    before: null,
    after: null,
    gallery: [
      { src: "samples/logo-1.png", cap: "Concept 1 — neighborhood mark" },
      { src: "samples/logo-2.png", cap: "Concept 2 — alternate direction" },
      { src: "samples/logo-3.png", cap: "Concept 3 — alternate direction" }
    ]
  },
  "ad-creative-pack": {
    caption: "Creatives from one validation run.",
    before: null,
    after: null,
    gallery: [
      { src: "samples/ad-1.png", cap: "Angle 1 — 1:1 creative" },
      { src: "samples/ad-2.png", cap: "Angle 2 — 1:1 creative" },
      { src: "samples/ad-3.png", cap: "Angle 3 — 1:1 creative" },
      { src: "samples/ad-4.jpg", cap: "Angle 4 — price angle" },
      { src: "samples/ad-5.jpg", cap: "Angle 5 — self-care angle" }
    ]
  },
  "social-launch-kit": {
    caption: "Templates from one validation run.",
    before: null,
    after: null,
    gallery: [
      { src: "samples/social-1.png", cap: "Promo template" },
      { src: "samples/social-2.png", cap: "Educational template" },
      { src: "samples/social-3.png", cap: "Proof template" },
      { src: "samples/social-4.jpg", cap: "Promo template · day 4" },
      { src: "samples/social-5.jpg", cap: "Story template · day 5" },
      { src: "samples/social-6.jpg", cap: "Proof template · day 9" },
      { src: "samples/social-7.jpg", cap: "Promo template · day 10" }
    ]
  },
  "hero-rewrite": {
    caption: "Real preview output from a validation run.",
    before: {
      label: "Before",
      html: '<blockquote>"Experience the Flavor of BROOKLYN"<br><span style="font-size:14px">Delicious, innovative, culturally-sensitive meals delivered to your door.</span></blockquote>' +
        '<p class="ba-meta">A real hero section, pasted in as-is.</p>'
    },
    after: {
      label: "After — Hero Rewrite preview",
      html: '<ul>' +
        '<li><strong>"Get Dietitian-Approved Meals Delivered to Your NY Home"</strong><span class="why">Outcome-first — states the specific result for the audience.</span></li>' +
        '<li><strong>"Chef-Inspired Meals, Delivered from Brooklyn to Your Door"</strong><span class="why">Mechanism — the Brooklyn origin matters to this buyer.</span></li>' +
        '<li><strong>"No Cooking Required: Free Meals for NY Medicaid Members, Delivered"</strong><span class="why">Objection-flip — removes the cooking barrier up front.</span></li>' +
        '</ul><p class="ba-meta">Free preview gives 3 headlines. The $49 unlock adds the full rewrite: subhead, CTA copy, trust bullets, and the reasoning.</p>'
    },
    gallery: []
  }
};
