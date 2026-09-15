// functions/api/designful/deliverable.js
// GET /api/designful/deliverable?token=<access_token>
// Returns the buyer's manifest (report files + image assets with overlay
// specs for client-side compositing). The access token is the capability —
// no other auth. Text files are returned inline; image assets are returned
// as token-gated /api/designful/asset URLs (never raw R2 keys).

export function resolveManifest(order) {
  // Pure logic, unit-tested. order: designful_orders row.
  if (!order) return { error: "unknown_order" };
  const single = !order.bundle_slots;
  let payload;
  try {
    payload = JSON.parse(order.output_json || "{}");
  } catch {
    return { error: "manifest_corrupt" };
  }
  const manifests = single ? { [guessFeature(order)]: payload } : payload.manifests || {};
  return {
    ok: true,
    status: order.status,
    product_id: order.product_id,
    manifests,
    ready_at: order.ready_at,
  };
}

function guessFeature(order) {
  // Single-feature orders store one manifest; derive the feature from product_id.
  const m = /^designful-(.+)$/.exec(order.product_id || "");
  return m ? m[1] : "unknown";
}

/** Rewrite an r2: storage ref into a token-gated asset URL. */
export function assetUrl(token, file) {
  return `/api/designful/asset?token=${encodeURIComponent(token)}&file=${encodeURIComponent(file.name)}`;
}

export async function onRequestGet({ request, env }) {
  const token = new URL(request.url).searchParams.get("token") || "";
  if (token.length < 16) {
    return Response.json({ ok: false, error: "invalid_token" }, { status: 403 });
  }
  const order = await env.LEADS_DB.prepare(
    "SELECT * FROM designful_orders WHERE access_token = ?"
  )
    .bind(token)
    .first();
  const resolved = resolveManifest(order);
  if (resolved.error) {
    const status = resolved.error === "unknown_order" ? 404 : 500;
    return Response.json({ ok: false, error: resolved.error }, { status });
  }
  if (order.status !== "ready") {
    return Response.json({ ok: false, error: "not_ready", status: order.status }, { status: 409 });
  }
  // Attach download URLs for image assets; inline text files stay inline.
  const manifests = {};
  for (const [feature, m] of Object.entries(resolved.manifests || {})) {
    const files = (m.files || []).map((f) => {
      if (f.storage && String(f.storage).startsWith("r2:")) {
        return { ...f, url: assetUrl(token, f) };
      }
      return f;
    });
    manifests[feature] = { ...m, files };
  }
  return Response.json({ ...resolved, manifests }, { headers: { "cache-control": "no-store" } });
}
