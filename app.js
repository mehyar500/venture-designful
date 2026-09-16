/* Designful — shared app logic.
 *
 * PRODUCTION DEFAULT: buy buttons POST the real payload to
 * https://mehyar.us/api/pay/checkout and redirect to Stripe.
 * DEV MODE is opt-in ONLY via ?dev=1 (shows the payload modal instead of
 * charging). Never the default, never silent.
 */
"use strict";

/* Explicit opt-in: ?dev=1. Anything else = production checkout. */
const DEV_MODE = new URLSearchParams(window.location.search).get("dev") === "1";
const CHECKOUT_URL = "https://mehyar.us/api/pay/checkout";
const TEASER_URL = "/api/designful/teaser";
const GENERATE_URL = "/api/designful/generate";

/* Last submitted teaser inputs per product slug — folded into the checkout
 * params so the paid pipeline starts with the buyer's intake (see
 * catalog.js paramMap). */
window.__teaserInputs = window.__teaserInputs || {};

/* ---------- helpers ---------- */
function $(sel, root) {
  return (root || document).querySelector(sel);
}
function $all(sel, root) {
  return Array.from((root || document).querySelectorAll(sel));
}
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email).trim());
}

/* ---------- buy modal (dev stub) ---------- */
let currentProduct = null;

function openBuyModal(product) {
  currentProduct = product;
  const modal = $("#buy-modal");
  $("#buy-product-name").textContent = product.name;
  $("#buy-product-price").textContent = designfulPrice(product);
  $("#buy-product-pitch").textContent = product.pitch;

  /* Bundle-3: optional "pick now" chips — payload goes into params.choices */
  const choicesHost = $("#buy-bundle-choices");
  choicesHost.innerHTML = "";
  if (product.kind === "bundle" && product.id === "designful-bundle-3") {
    const label = document.createElement("div");
    label.className = "field";
    label.innerHTML = "<label>Pick 3 now (or decide later)</label>";
    const chips = document.createElement("div");
    chips.className = "choices";
    DESIGNFUL_CATALOG.filter(function (p) { return p.kind === "single"; }).forEach(function (p) {
      const chip = document.createElement("label");
      chip.className = "chip";
      chip.innerHTML = '<input type="checkbox" name="bundle_choice" value="' + esc(p.id) + '"> ' + esc(p.name);
      chips.appendChild(chip);
    });
    label.appendChild(chips);
    choicesHost.appendChild(label);
  }

  $("#buy-email").value = "";
  $("#buy-error").textContent = "";
  modal.hidden = false;
  $("#buy-email").focus();
}

function closeBuyModal() {
  $("#buy-modal").hidden = true;
  currentProduct = null;
}

function checkoutPayload(product, email, params) {
  const payload = {
    product_id: product.id,
    email: email,
    params: params || {}
  };
  if (DEV_MODE) payload.test = true; // dev checkout only ever hits test mode
  return payload;
}

function devCheckout(product, email, params) {
  /* DEV_MODE (?dev=1): never call the real endpoint. Show exactly what WOULD be sent. */
  const payload = checkoutPayload(product, email, params);
  $("#payload-pre").textContent = "POST " + CHECKOUT_URL + "\n\n" + JSON.stringify(payload, null, 2);
  $("#payload-modal").hidden = false;
}

/* Production checkout: POST the real payload, redirect to Stripe. */
async function liveCheckout(product, email, params) {
  const payload = checkoutPayload(product, email, params);
  let res;
  try {
    res = await fetch(CHECKOUT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return { ok: false, error: "Couldn't reach checkout — check your connection and try again." };
  }
  let data = null;
  try {
    data = await res.json();
  } catch { /* fall through */ }
  if (!res.ok || !data || data.ok !== true || !data.checkout_url) {
    const msg = (data && (data.message || data.error)) || ("Checkout failed (HTTP " + res.status + ").");
    return { ok: false, error: String(msg).slice(0, 200) };
  }
  try {
    localStorage.setItem("designful_last_product", product.id);
    /* success.html reads these after the Stripe redirect to offer the
       "any 3 for $99" / "Studio Pass" follow-ups against the real session. */
    if (params && params.choices) {
      localStorage.setItem("designful_bundle_choices", JSON.stringify(params.choices));
    }
  } catch { /* private mode */ }
  window.location.href = data.checkout_url;
  return { ok: true };
}

/* Wire all [data-buy] buttons on the page */
function wireBuyButtons() {
  $all("[data-buy]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      const product = designfulFind(btn.getAttribute("data-buy"));
      if (!product) return;
      openBuyModal(product);
    });
  });
}

/* ---------- teaser form (per feature) ---------- */
function buildTeaserForm(product, containerId) {
  const form = document.createElement("form");
  form.id = "teaser-form";
  form.noValidate = true;

  product.inputs.forEach(function (input) {
    const wrap = document.createElement("div");
    wrap.className = "field";

    const label = document.createElement("label");
    label.textContent = input.label;
    wrap.appendChild(label);

    let el;
    if (input.type === "textarea") {
      el = document.createElement("textarea");
      el.rows = 4;
      el.placeholder = input.placeholder || "";
    } else if (input.type === "file") {
      el = document.createElement("input");
      el.type = "file";
      if (input.accept) el.accept = input.accept;
    } else if (input.type === "choices") {
      el = document.createElement("div");
      el.className = "choices";
      input.options.forEach(function (opt) {
        const chip = document.createElement("label");
        chip.className = "chip";
        chip.innerHTML = '<input type="checkbox" name="' + esc(input.key) + '" value="' + esc(opt) + '"> ' + esc(opt);
        el.appendChild(chip);
      });
    } else {
      el = document.createElement("input");
      el.type = input.type;
      el.placeholder = input.placeholder || "";
    }
    if (el.tagName) {
      el.name = input.key;
      el.id = "teaser-" + input.key;
    }
    wrap.appendChild(el);
    form.appendChild(wrap);
  });

  const btn = document.createElement("button");
  btn.type = "submit";
  btn.className = "btn btn-primary";
  btn.textContent = "Get my free preview";
  form.appendChild(btn);

  const host = document.getElementById(containerId);
  if (host) host.appendChild(form);
  return form;
}

async function submitTeaser(product, form) {
  const resultEl = $("#teaser-result");
  const statusEl = $("#teaser-status");
  resultEl.innerHTML = "";
  statusEl.textContent = "Generating your teaser…";
  statusEl.className = "status busy";

  const data = {};
  product.inputs.forEach(function (input) {
    if (input.type === "choices") {
      const checked = $all('input[name="' + input.key + '"]:checked', form)
        .map(function (c) { return c.value; });
      data[input.key] = checked;
    } else if (input.type === "file") {
      const file = $("#teaser-" + input.key, form).files[0];
      data[input.key] = file ? file.name : "";
    } else {
      data[input.key] = $("#teaser-" + input.key, form).value.trim();
    }
  });

  /* Remember intake inputs so the buy modal can fold them into checkout params */
  window.__teaserInputs[product.slug] = data;

  /* Required-input check (shared helper in catalog.js). */
  const missing = findMissingInputs(product, data);
  if (missing.length) {
    statusEl.textContent = "Please fill in: " + missing.map(function (m) { return m.label; }).join(", ");
    statusEl.className = "status error";
    return;
  }

  /* Map catalog input keys to the backend's intake keys (INTAKE_PARAM_MAP);
   * the backend routes on `feature` (the catalog slug), not product_id. */
  const keyMap = INTAKE_PARAM_MAP[product.id] || {};
  const apiInputs = {};
  Object.keys(data).forEach(function (k) {
    if (data[k] === "" || data[k] == null) return;
    apiInputs[keyMap[k] || k] = data[k];
  });
  try {
    const res = await fetch(TEASER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feature: product.slug, inputs: apiInputs })
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const json = await res.json();
    renderTeaserResult(product, json);
    statusEl.textContent = "";
    statusEl.className = "status";
  } catch (err) {
    /* Graceful dev fallback — backend isn't running locally. */
    statusEl.textContent = "";
    statusEl.className = "status";
    resultEl.innerHTML =
      '<div class="dev-fallback">' +
      "<strong>Dev backend not running.</strong><br>" +
      "This is where your free preview would appear. The form would POST to " +
      "<code>" + esc(TEASER_URL) + "</code> with <code>product_id: " + esc(product.id) + "</code> " +
      "and your input, and render the AI result here." +
      "</div>";
  }
}

/* Renders the real teaser backend shape: {ok, feature, teaser: {...}}.
 * Image teasers (logo/ad/social) carry teaser.image as a data: URI — since
 * 2026-09-15 the teaser API server-composites the diagonal DESIGNFUL PREVIEW
 * watermark into an SVG derivative, so the client renders it as-is (previews,
 * never deliverables). Every gated output carries a FREE PREVIEW badge and
 * an upgrade CTA. */
function renderTeaserResult(product, json) {
  const resultEl = $("#teaser-result");
  const t = (json && json.teaser) || {};
  let html = '<div class="free-preview-banner" role="note">' +
    '<span class="free-preview-badge">FREE PREVIEW</span>' +
    '<span>This is a watermarked taste. <a href="#unlock-box">Unlock the full $49 deliverable</a> for clean, full-resolution files.</span>' +
    '</div>';
  function imgBlock(src) {
    if (!src) return "";
    return '<div class="gallery"><img src="' + esc(src) + '" alt="Free preview — watermarked DESIGNFUL PREVIEW" loading="lazy"></div>' +
      '<p class="preview-note">Server-watermarked free preview. The $49 deliverable ships clean, full-resolution files.</p>';
  }
  if (product.slug === "homepage-teardown") {
    html = "<h3>First-impression score: " + esc(String(t.score)) + "/100</h3>" +
      "<p><strong>Biggest conversion killer:</strong> " + esc(t.biggest_issue || "") + "</p>" +
      "<p><strong>The one fix:</strong> " + esc(t.one_fix || "") + "</p>";
  } else if (product.slug === "logo-refresh") {
    html = "<h3>" + esc(t.direction_name || "Concept direction") + "</h3>" +
      imgBlock(t.image) +
      "<div class='result-body'>" + esc(t.concept_description || "") + "</div>" +
      "<p><em>" + esc(t.why_it_works || "") + "</em></p>";
  } else if (product.slug === "ad-creative-pack") {
    html = "<h3>Your angle</h3><p>" + esc(t.angle || "") + "</p>" +
      imgBlock(t.image) +
      "<h4>3 headlines on this angle</h4><ul>" +
      (t.headline_options || []).map(function (h) { return "<li>" + esc(h) + "</li>"; }).join("") +
      "</ul><p><em>" + esc(t.why_this_angle || "") + "</em></p>";
  } else if (product.slug === "social-launch-kit") {
    html = "<h3>Your 3 content pillars</h3><ul>" +
      (t.content_pillars || []).map(function (p) {
        return "<li><strong>" + esc(p.name) + "</strong> (" + esc(p.job) + ") — " + esc(p.description) + "</li>";
      }).join("") + "</ul>";
    if (t.sample_template && t.sample_template.hook) {
      html += "<h4>Sample post</h4>" + imgBlock(t.image) +
        "<p><strong>" + esc(t.sample_template.hook) + "</strong></p>" +
        "<div class='result-body'>" + esc(t.sample_template.caption || "") + "</div>";
    }
  } else if (product.slug === "hero-rewrite") {
    html = "<h3>3 rewritten headlines</h3><ul>" +
      (t.headlines || []).map(function (h) {
        return "<li><strong>" + esc(h.text) + "</strong><br><span class='muted'>" +
          esc(h.structure) + " — " + esc(h.why) + "</span></li>";
      }).join("") + "</ul>";
  }
  if (t.note) html += "<p class='muted'>" + esc(t.note) + "</p>";
  resultEl.innerHTML = html || '<div class="dev-fallback">Empty response from teaser backend.</div>';
  /* Teaser images are previews, not deliverables — watermark them in place. */
  var C = window.DesignfulCompositor;
  if (C && C.applyWatermarkToImages) C.applyWatermarkToImages(resultEl);
}

/* Intake params for checkout: maps each catalog input key to the API's
 * intake field (see INTEGRATION.md checkout contract). File inputs can't
 * travel through checkout — they're re-collected after payment. */
const INTAKE_PARAM_MAP = {
  "designful-homepage-teardown": { url: "url" },
  "designful-hero-rewrite": { hero: "hero_copy" },
  "designful-ad-creative-pack": { product: "product_description" },
  "designful-social-launch-kit": { brand: "brand_blurb", brand_name: "brand_name" },
  "designful-logo-refresh": { brand_name: "brand_name", industry: "industry", brand_blurb: "brand_blurb", current_logo_desc: "current_logo_desc" }
};

function intakeParams(product) {
  const map = INTAKE_PARAM_MAP[product.id] || {};
  const saved = (window.__teaserInputs && window.__teaserInputs[product.slug]) || {};
  const params = {};
  Object.keys(map).forEach(function (formKey) {
    const v = saved[formKey];
    if (v && String(v).trim()) params[map[formKey]] = String(v).slice(0, 2000);
  });
  const bundle = collectBundleParams();
  if (bundle && bundle.choices && bundle.choices.length) params.choices = bundle.choices;
  return params;
}

/* ---------- global wiring (every page) ---------- */
document.addEventListener("DOMContentLoaded", function () {
  wireBuyButtons();
  initSubscribeForms();

  /* DEV_MODE banner — unmistakable when ?dev=1 is on. */
  if (DEV_MODE && document.body) {
    var banner = document.createElement("div");
    banner.className = "dev-notice";
    banner.style.cssText = "position:sticky;top:0;z-index:9999;text-align:center;padding:8px;font-weight:700";
    banner.textContent = "DEV MODE (?dev=1) — no real checkout, no charges. Remove ?dev=1 for production.";
    document.body.insertBefore(banner, document.body.firstChild);
  }

  var closeX = $("#buy-close");
  if (closeX) closeX.addEventListener("click", closeBuyModal);

  var buyForm = $("#buy-form");
  if (buyForm) {
    buyForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var email = $("#buy-email").value.trim();
      var err = $("#buy-error");
      if (!validEmail(email)) {
        err.textContent = "Enter a valid email — your deliverable goes there.";
        return;
      }
      err.textContent = "";
      var params = intakeParams(currentProduct);
      if (DEV_MODE) {
        devCheckout(currentProduct, email, params);
        closeBuyModal();
        return;
      }
      var btn = buyForm.querySelector('button[type="submit"]');
      if (btn) {
        btn.disabled = true;
        btn.textContent = "Starting secure checkout…";
      }
      liveCheckout(currentProduct, email, params).then(function (r) {
        if (!r.ok) {
          err.textContent = r.error;
          if (btn) {
            btn.disabled = false;
            btn.textContent = "Continue to checkout";
          }
        }
        /* on success the page redirects to Stripe — nothing else to do */
      });
    });
  }

  var payloadClose = $("#payload-close");
  if (payloadClose) payloadClose.addEventListener("click", function () {
    $("#payload-modal").hidden = true;
  });
});

/* Bundle "any 3" choice chips inside the buy modal, when relevant */
function collectBundleParams() {
  if (!currentProduct || currentProduct.kind !== "bundle") return {};
  var checked = $all('#buy-form input[name="bundle_choice"]:checked')
    .map(function (c) { return c.value; });
  return { choices: checked };
}

/* Footer newsletter subscribe: email required; phone + ZIP optional.
 * POSTs to /api/subscribe; shows inline success/error. Never blocks. */
function initSubscribeForms() {
  var forms = document.querySelectorAll("[data-subscribe-form]");
  forms.forEach(function (form) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var msg = form.querySelector(".subscribe-msg");
      var btn = form.querySelector('button[type="submit"]');
      var email = form.email ? form.email.value.trim() : "";
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        if (msg) { msg.hidden = false; msg.textContent = "Please enter a valid email address."; }
        return;
      }
      if (btn) { btn.disabled = true; btn.textContent = "Subscribing…"; }
      fetch("/api/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: email,
          phone: form.phone ? form.phone.value.trim() : "",
          zip: form.zip ? form.zip.value.trim() : "",
          sms_consent: form.sms_consent ? form.sms_consent.checked : false,
        }),
      }).then(function (r) { return r.json(); }).then(function (j) {
        if (msg) {
          msg.hidden = false;
          msg.textContent = j && j.ok
            ? "You're in — check your inbox to confirm."
            : "Hmm, that didn't go through. Try again in a bit.";
        }
        if (j && j.ok) form.reset();
      }).catch(function () {
        if (msg) { msg.hidden = false; msg.textContent = "Hmm, that didn't go through. Try again in a bit."; }
      }).finally(function () {
        if (btn) { btn.disabled = false; btn.textContent = "Subscribe"; }
      });
    });
  });
}

/* Recent work strip — injected above the footer on every page. */
function renderRecentWork() {
  var spots = document.querySelectorAll("[data-recent-work]");
  if (!spots.length) return;
  var items = [
    { src: "samples/ad-1.png", cap: "Ad Creative Pack" },
    { src: "samples/logo-1.png", cap: "Logo Refresh" },
    { src: "samples/social-1.png", cap: "Social Launch Kit" },
    { src: "samples/ad-4.jpg", cap: "Ad Creative Pack" },
    { src: "samples/logo-2.png", cap: "Logo Refresh" },
    { src: "samples/social-4.jpg", cap: "Social Launch Kit" }
  ];
  var html = '<div class="recent-work-head"><strong>Recent work</strong><a href="work.html">View the full collection &rarr;</a></div>' +
    '<div class="recent-strip">' +
    items.map(function (it) {
      return '<a class="recent-card" href="work.html"><img src="' + it.src + '" alt="Sample ' + it.cap + ' output" loading="lazy"><span>' + it.cap + ' · $49</span></a>';
    }).join("") + "</div>";
  spots.forEach(function (s) { s.innerHTML = html; });
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", renderRecentWork);
} else {
  renderRecentWork();
}
