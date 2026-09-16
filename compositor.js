/* Designful compositor — client-side typography compositing.
 *
 * PRODUCTION TYPOGRAPHY PATH. The image model renders TEXT-FREE artwork;
 * every word the buyer sees is drawn here with real fonts on <canvas>.
 * (Workers can't run PIL, so this runs in the buyer's browser.)
 *
 * Exports (ESM + window.DesignfulCompositor for classic scripts):
 *   layoutOverlay(spec, kind, W, H) -> [{text,x,y,size,weight,family,color,
 *       align,maxWidth,style}]            pure layout math, unit-testable
 *   renderComposite(canvas, {artwork, overlay, kind}) -> Promise<void>
 *   watermarkPreview(canvas, text)        diagonal PREVIEW watermark
 *   downloadCanvas(canvas, filename)
 *   applyWatermarkToImages(container)     watermark every <img> in a node
 *
 * overlay kinds: "logo-lockup" | "ad-creative" | "social-template"
 * overlay specs come from the manifest: {kind, feature, overlay:{...}}.
 */

const FONT_STACKS = {
  display: '"Archivo", "Arial Black", Impact, system-ui, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  sans: '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif',
};

const MAX_WORDS_HEADLINE = 12;

/* ---------- pure layout ---------- */

function fitSize(ctx, text, maxWidth, startSize, minSize) {
  let size = startSize;
  ctx.font = `800 ${size}px ${FONT_STACKS.display}`;
  while (size > minSize && ctx.measureText(text).width > maxWidth) size -= 2;
  return size;
}

/* Wrap text to maxLines within maxWidth; returns {lines, size}. */
function wrapLines(ctx, text, maxWidth, startSize, weight, family, maxLines) {
  let size = startSize;
  for (;;) {
    ctx.font = `${weight} ${size}px ${family}`;
    const words = String(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = "";
    for (const w of words) {
      const t = cur ? cur + " " + w : w;
      if (ctx.measureText(t).width <= maxWidth || !cur) cur = t;
      else {
        lines.push(cur);
        cur = w;
      }
    }
    if (cur) lines.push(cur);
    if (lines.length <= maxLines || size <= 18) return { lines: lines.slice(0, maxLines), size };
    size -= 4;
  }
}

/**
 * Pure layout: given an overlay spec + canvas size, return draw ops.
 * No DOM, no canvas — unit-testable in Node.
 * Each op: {text, x, y, size, weight, family, color, align, maxWidth,
 *            maxLines, style: "headline"|"body"|"pill"|"footer"}
 */
export function layoutOverlay(spec, kind, W, H) {
  const ops = [];
  const s = spec || {};
  const cx = W / 2;

  if (kind === "logo-lockup") {
    // Mark image occupies the top ~62%; wordmark + tagline typeset below.
    const markH = Math.round(H * 0.58);
    const wordmark = String(s.wordmark || "").trim();
    const tagline = String(s.tagline || "").trim();
    if (wordmark) {
      ops.push({
        text: wordmark, x: cx, y: markH + Math.round(H * 0.10),
        size: Math.round(W * 0.075), weight: 800, family: FONT_STACKS.display,
        color: "#111827", align: "center", maxWidth: Math.round(W * 0.88),
        maxLines: 1, style: "headline",
      });
    }
    if (tagline) {
      ops.push({
        text: tagline.toUpperCase(), x: cx, y: markH + Math.round(H * 0.19),
        size: Math.round(W * 0.032), weight: 600, family: FONT_STACKS.sans,
        color: "#4b5563", align: "center", maxWidth: Math.round(W * 0.8),
        maxLines: 1, style: "footer", tracking: Math.round(W * 0.004),
      });
    }
    return ops;
  }

  if (kind === "ad-creative") {
    const headline = String(s.headline || "").trim();
    const brand = String(s.brand || "").trim();
    const cta = String(s.cta || "").trim();
    if (headline) {
      ops.push({
        text: headline, x: cx, y: Math.round(H * 0.08),
        size: Math.round(W * 0.085), weight: 800, family: FONT_STACKS.display,
        color: "#ffffff", align: "center", maxWidth: Math.round(W * 0.86),
        maxLines: 3, style: "headline", shadow: true,
      });
    }
    if (brand) {
      ops.push({
        text: brand.toUpperCase(), x: Math.round(W * 0.06), y: Math.round(H * 0.90),
        size: Math.round(W * 0.034), weight: 700, family: FONT_STACKS.sans,
        color: "#ffffff", align: "left", maxWidth: Math.round(W * 0.5),
        maxLines: 1, style: "footer", shadow: true,
      });
    }
    if (cta) {
      ops.push({
        text: cta, x: cx, y: Math.round(H * 0.88),
        size: Math.round(W * 0.042), weight: 700, family: FONT_STACKS.sans,
        color: "#111827", align: "center", maxWidth: Math.round(W * 0.6),
        maxLines: 1, style: "pill",
      });
    }
    return ops;
  }

  if (kind === "social-template") {
    const hook = String(s.hook || "").trim();
    const brand = String(s.brand || "").trim();
    const cta = String(s.cta || "").trim();
    if (hook) {
      ops.push({
        text: hook, x: cx, y: Math.round(H * 0.62),
        size: Math.round(W * 0.075), weight: 800, family: FONT_STACKS.display,
        color: "#ffffff", align: "center", maxWidth: Math.round(W * 0.84),
        maxLines: 3, style: "headline", shadow: true,
      });
    }
    const foot = [brand, cta].filter(Boolean).join("  ·  ");
    if (foot) {
      ops.push({
        text: foot, x: cx, y: Math.round(H * 0.93),
        size: Math.round(W * 0.034), weight: 600, family: FONT_STACKS.sans,
        color: "#ffffff", align: "center", maxWidth: Math.round(W * 0.88),
        maxLines: 1, style: "footer", shadow: true,
      });
    }
    return ops;
  }

  return ops;
}

/* ---------- rendering (browser) ---------- */

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("artwork_load_failed"));
    img.src = src;
  });
}

/* Draw artwork: logo gets a clean backdrop; ads/social get cover + scrims. */
function drawArtwork(ctx, img, kind, W, H) {
  if (kind === "logo-lockup") {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
    const markH = Math.round(H * 0.58);
    const scale = Math.min((W * 0.7) / img.width, markH / img.height);
    const dw = img.width * scale, dh = img.height * scale;
    ctx.drawImage(img, (W - dw) / 2, (markH - dh) / 2 + 8, dw, dh);
    return;
  }
  // cover-fill
  const scale = Math.max(W / img.width, H / img.height);
  const dw = img.width * scale, dh = img.height * scale;
  ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
  // legibility scrims
  if (kind === "ad-creative") {
    const g = ctx.createLinearGradient(0, 0, 0, H * 0.45);
    g.addColorStop(0, "rgba(0,0,0,0.55)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H * 0.45);
    const g2 = ctx.createLinearGradient(0, H * 0.75, 0, H);
    g2.addColorStop(0, "rgba(0,0,0,0)");
    g2.addColorStop(1, "rgba(0,0,0,0.5)");
    ctx.fillStyle = g2;
    ctx.fillRect(0, H * 0.75, W, H * 0.25);
  } else if (kind === "social-template") {
    const g = ctx.createLinearGradient(0, H * 0.45, 0, H);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0,0.62)");
    ctx.fillStyle = g;
    ctx.fillRect(0, H * 0.45, W, H * 0.55);
  }
}

function drawOp(ctx, op) {
  const { lines, size } = wrapLines(ctx, op.text, op.maxWidth, op.size, op.weight, op.family, op.maxLines);
  ctx.font = `${op.weight} ${size}px ${op.family}`;
  ctx.textAlign = op.align;
  ctx.textBaseline = "top";
  const lineH = size * 1.18;
  const totalH = lineH * lines.length;

  if (op.style === "pill") {
    const padX = size * 0.9, padY = size * 0.45;
    const tw = ctx.measureText(lines[0]).width;
    const bw = tw + padX * 2, bh = size + padY * 2;
    const bx = op.x - bw / 2, by = op.y - padY;
    ctx.save();
    if (op.shadow) {
      ctx.shadowColor = "rgba(0,0,0,0.35)";
      ctx.shadowBlur = 12;
    }
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, bh / 2);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = op.color;
    ctx.fillText(lines[0], op.x, by + padY);
    return;
  }

  let y = op.y;
  if (op.style === "headline" && op.align === "center") y = op.y; // top-anchored by layout
  ctx.save();
  if (op.shadow) {
    ctx.shadowColor = "rgba(0,0,0,0.55)";
    ctx.shadowBlur = Math.max(6, size * 0.12);
    ctx.shadowOffsetY = 2;
  }
  ctx.fillStyle = op.color;
  if (op.tracking) {
    // letterspaced footer: draw char by char
    const chars = lines[0].split("");
    const widths = chars.map((c) => ctx.measureText(c).width);
    const total = widths.reduce((a, b) => a + b, 0) + op.tracking * (chars.length - 1);
    let cx = op.x - total / 2;
    const prevAlign = ctx.textAlign;
    ctx.textAlign = "left";
    chars.forEach((c, i) => {
      ctx.fillText(c, cx, y);
      cx += widths[i] + op.tracking;
    });
    ctx.textAlign = prevAlign;
  } else {
    lines.forEach((ln) => {
      ctx.fillText(ln, op.x, y);
      y += lineH;
    });
  }
  ctx.restore();
}

/**
 * Render one composite: artwork + overlay typography.
 * canvas is sized by the caller (ratio from the manifest entry dims).
 */
export async function renderComposite(canvas, { artwork, overlay, kind }) {
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  const img = await loadImage(artwork);
  // Wait for webfonts so the first paint isn't fallback type.
  if (document.fonts && document.fonts.ready) {
    try {
      await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1500))]);
    } catch { /* fall back to system stacks */ }
  }
  drawArtwork(ctx, img, kind, W, H);
  const ops = layoutOverlay((overlay && overlay.overlay) || {}, kind, W, H);
  ops.forEach((op) => drawOp(ctx, op));
}

/** Diagonal semi-transparent PREVIEW watermark, in place. */
export function watermarkPreview(canvas, text = "DESIGNFUL — PREVIEW") {
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.save();
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "rgba(0,0,0,0.25)";
  ctx.lineWidth = 1;
  const size = Math.max(20, Math.round(W / 18));
  ctx.font = `800 ${size}px ${FONT_STACKS.sans}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.translate(W / 2, H / 2);
  ctx.rotate(-Math.PI / 7);
  for (let i = -2; i <= 2; i++) {
    const y = (i * H) / 4;
    ctx.fillText(text, 0, y);
  }
  ctx.restore();
}

/**
 * Watermark every <img> inside container: swaps each for a watermarked
 * canvas of the same intrinsic size. Used for teaser images.
 */
export function applyWatermarkToImages(container, text) {
  const imgs = Array.from(container.querySelectorAll("img"));
  imgs.forEach((img) => {
    /* Server-watermarked SVG previews (data:image/svg+xml) already carry the
     * diagonal DESIGNFUL PREVIEW overlay baked in by the teaser API — skip. */
    const src = img.getAttribute("src") || "";
    if (src.indexOf("data:image/svg+xml") === 0) return;
    const swap = () => {
      try {
        const c = document.createElement("canvas");
        c.width = img.naturalWidth || 800;
        c.height = img.naturalHeight || 800;
        c.style.maxWidth = "100%";
        c.style.height = "auto";
        c.setAttribute("role", "img");
        c.setAttribute("aria-label", img.alt || "Teaser preview");
        const ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0, c.width, c.height);
        watermarkPreview(c, text);
        img.replaceWith(c);
      } catch { /* leave the original img */ }
    };
    if (img.complete && img.naturalWidth) swap();
    else img.addEventListener("load", swap, { once: true });
  });
}

export function downloadCanvas(canvas, filename) {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename || "designful.png";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 4000);
  }, "image/png");
}

/* Classic-script interop: window.DesignfulCompositor */
if (typeof window !== "undefined") {
  window.DesignfulCompositor =
    window.DesignfulCompositor ||
    { layoutOverlay, renderComposite, watermarkPreview, applyWatermarkToImages, downloadCanvas };
}
