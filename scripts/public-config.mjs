import { parse } from "jsonc-parser";
/** Deployment systems replace resource IDs in-place; downloads must still expose templates only. */
export function publicConfig(file, content) {
  if (!/^wrangler(?:\.(?:apps|build))?\.jsonc$/.test(file)) return content;
  const c = parse(String(content));
  delete c.account_id;
  delete c.routes;
  delete c.vars;
  c.name =
    file === "wrangler.apps.jsonc"
      ? "onestorage-apps"
      : file === "wrangler.build.jsonc"
        ? "onestorage-build"
        : "onestorage";
  for (const d of c.d1_databases || []) {
    d.database_id = "00000000-0000-0000-0000-000000000000";
    d.database_name = "onestorage";
    delete d.preview_database_id;
  }
  for (const r of c.r2_buckets || []) {
    r.bucket_name =
      r.binding === "NPM_CACHE" ? "onestorage-npm-cache" : "onestorage-objects";
    delete r.preview_bucket_name;
  }
  for (const v of c.vectorize || []) v.index_name = "onestorage-code";
  for (const s of c.services || []) s.service = "onestorage-build";
  for (const q of [
    ...(c.queues?.producers || []),
    ...(c.queues?.consumers || []),
  ])
    q.queue = "onestorage-events";
  return Buffer.from(JSON.stringify(c, null, 2) + "\n");
}
