// functions/api/designful/asset.js
// GET /api/designful/asset?token=<access_token>&file=<name>
// Token-gated image download from the DESIGNFUL_R2 bucket. The token must
// belong to an order whose manifest actually contains the requested file —
// a valid token for one order cannot pull another order's assets.

export function findAssetFile(manifests, fileName) {
  // Pure logic, unit-tested.
  for (const m of Object.values(manifests || {})) {
    for (const f of m.files || []) {
      if (f.name === fileName && f.storage && String(f.storage).startsWith("r2:")) {
        return f;
      }
    }
  }
  return null;
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || "";
  const fileName = url.searchParams.get("file") || "";
  if (token.length < 16 || !fileName || /[/\\]/.test(fileName)) {
    return Response.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }
  if (!env.DESIGNFUL_R2) {
    return Response.json({ ok: false, error: "no_storage" }, { status: 503 });
  }
  const order = await env.LEADS_DB.prepare(
    "SELECT * FROM designful_orders WHERE access_token = ?"
  )
    .bind(token)
    .first();
  if (!order || !order.output_json) {
    return Response.json({ ok: false, error: "unknown_order" }, { status: 404 });
  }
  let payload;
  try {
    payload = JSON.parse(order.output_json);
  } catch {
    return Response.json({ ok: false, error: "manifest_corrupt" }, { status: 500 });
  }
  const manifests = order.bundle_slots ? payload.manifests || {} : { single: payload };
  const file = findAssetFile(manifests, fileName);
  if (!file) return Response.json({ ok: false, error: "not_found" }, { status: 404 });

  const key = String(file.storage).slice(3); // strip "r2:"
  const obj = await env.DESIGNFUL_R2.get(key);
  if (!obj) return Response.json({ ok: false, error: "not_found" }, { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("content-disposition", `attachment; filename="${fileName}"`);
  headers.set("cache-control", "private, max-age=3600");
  return new Response(obj.body, { headers });
}
