import type { Env, Repo } from "./types";
import type { CIRun } from "./ci";
import {
  cacheSelectionSchema,
  cacheFilesSchema,
  cacheContains,
  CACHE_LIMIT,
  CACHE_QUOTA,
  CACHE_TTL,
  CLOUD_CACHE_LIMIT,
  type CacheSpec,
} from "./ci-cache-schema";
import { assertVariablesActive, variableLive } from "./ci-variables";
import { boundedBody, digest, fail } from "./security";
export interface CacheBinding {
  run_id: string;
  slot: string;
  generation: number;
  scope: string;
  keys: string;
  spec: string;
  format: string;
}
export interface CacheEntry {
  id: string;
  repo_id: string;
  run_id: string;
  slot: string;
  generation: number;
  scope: string;
  cache_key: string;
  format: string;
  object_key: string;
  size: number;
  checksum: string;
  created_at: number;
}
async function repository(env: Env, run: CIRun) {
  const r = await env.DB.prepare(
    "SELECT * FROM repositories WHERE id=? AND deleted_at IS NULL AND archived_at IS NULL",
  )
    .bind(run.repo_id)
    .first<Repo>();
  if (!r) fail(409, "Cache repository unavailable");
  return r;
}
async function engine(env: Env, run: CIRun, path: string) {
  const r = await repository(env, run);
  return env.REPOSITORIES.get(env.REPOSITORIES.idFromName(r.id)).fetch(
    new Request("http://repository" + path, {
      headers: {
        "x-repo-id": r.id,
        "x-default-branch": r.default_branch,
        "x-lifecycle-revision": String(r.lifecycle_revision || 0),
      },
    }),
  );
}
export async function assertCacheLive(env: Env, run: CIRun, b: CacheBinding) {
  await assertVariablesActive(env, run);
  const live = await env.DB.prepare(
    "SELECT repo_id FROM ci_cache_state WHERE repo_id=? AND generation=?",
  )
    .bind(run.repo_id, b.generation)
    .first();
  if (!live) fail(409, "Cache generation changed; start a new run");
}
export async function prepareCache(
  env: Env,
  run: CIRun,
  slot: string,
): Promise<CacheBinding> {
  const config = cacheSelectionSchema.parse(JSON.parse(run.config)),
    spec = config.caches?.find((c) => c.id === slot);
  if (!spec) fail(404, "Cache slot not configured");
  await assertVariablesActive(env, run);
  const old = await env.DB.prepare(
    "SELECT * FROM ci_run_caches WHERE run_id=? AND slot=?",
  )
    .bind(run.id, slot)
    .first<CacheBinding>();
  if (old) {
    await assertCacheLive(env, run, old);
    return old;
  }
  await env.DB.prepare(
    `INSERT OR IGNORE INTO ci_cache_state(repo_id) SELECT ? WHERE ${variableLive}`,
  )
    .bind(run.repo_id, run.id, run.lease_hash, Date.now())
    .run();
  const state = await env.DB.prepare(
    "SELECT generation FROM ci_cache_state WHERE repo_id=?",
  )
    .bind(run.repo_id)
    .first<{ generation: number }>();
  if (!state) fail(409, "Cache unavailable");
  const protectedBranch = !!(await env.DB.prepare(
    "SELECT 1 FROM branch_protections WHERE repo_id=? AND branch=? AND require_mr=1",
  )
    .bind(run.repo_id, run.ref)
    .first());
  const trusted = ["manual", "push", "schedule"].includes(
    run.source_trigger || "",
  );
  if (spec.scope === "protected" && (!trusted || !protectedBranch))
    fail(403, "Protected cache requires a trusted protected branch");
  const fingerprints: string[] = [];
  for (const path of spec.key_files) {
    const response = await engine(
      env,
      run,
      "/file?ref=" + run.sha + "&path=" + encodeURIComponent(path),
    );
    if (!response.ok) {
      await response.body?.cancel();
      fail(409, "Cache key file unavailable: " + path);
    }
    fingerprints.push(
      path + ":" + (await digest(await boundedBody(response, 1024 * 1024))),
    );
  }
  const key =
    spec.key +
    (fingerprints.length
      ? ":" + (await digest(JSON.stringify(fingerprints)))
      : "");
  const scope = await digest(
    JSON.stringify([
      spec.scope,
      protectedBranch,
      trusted ? "branch" : "review",
      spec.scope === "protected" ? "*" : run.ref,
      [...spec.paths].sort(),
    ]),
  );
  const keys = JSON.stringify(
    await Promise.all([key, ...spec.fallback_keys].map((k) => digest(k))),
  );
  await env.DB.prepare(
    `INSERT OR IGNORE INTO ci_run_caches(run_id,slot,generation,scope,keys,spec,format) SELECT ?,?,?,?,?,?,? WHERE ${variableLive} AND EXISTS(SELECT 1 FROM ci_cache_state WHERE repo_id=? AND generation=?)`,
  )
    .bind(
      run.id,
      slot,
      state.generation,
      scope,
      keys,
      JSON.stringify(spec),
      config.runner,
      run.id,
      run.lease_hash,
      Date.now(),
      run.repo_id,
      state.generation,
    )
    .run();
  const b = await env.DB.prepare(
    "SELECT * FROM ci_run_caches WHERE run_id=? AND slot=?",
  )
    .bind(run.id, slot)
    .first<CacheBinding>();
  if (!b) fail(409, "Cache binding changed");
  await assertCacheLive(env, run, b);
  return b;
}
export async function readCache(env: Env, run: CIRun, slot: string) {
  const binding = await prepareCache(env, run, slot),
    spec = JSON.parse(binding.spec) as CacheSpec;
  if (spec.policy === "push") return null;
  for (const key of JSON.parse(binding.keys) as string[]) {
    const candidates = (
      await env.DB.prepare(
        "SELECT * FROM ci_visible_caches WHERE repo_id=? AND generation=? AND scope=? AND cache_key=? AND format=? AND expires_at>? ORDER BY created_at DESC,id DESC LIMIT 5",
      )
        .bind(
          run.repo_id,
          binding.generation,
          binding.scope,
          key,
          binding.format,
          Date.now(),
        )
        .all<CacheEntry>()
    ).results;
    for (const entry of candidates) {
      const object = await env.OBJECTS.get(entry.object_key);
      if (!object || object.size !== entry.size) {
        await object?.body?.cancel();
        continue;
      }
      try {
        await assertCacheLive(env, run, binding);
      } catch (e) {
        await object.body?.cancel();
        throw e;
      }
      return { entry, object, binding };
    }
  }
  return null;
}
/** Reserve immutable R2 ownership before upload. Only successful jobs and parents become visible. */
export async function writeCache(
  env: Env,
  run: CIRun,
  slot: string,
  size: number,
  checksum: string,
  put: (key: string) => Promise<unknown>,
) {
  if (
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > CACHE_LIMIT ||
    !/^[a-f0-9]{64}$/.test(checksum)
  )
    fail(400, "Invalid cache size or checksum");
  const b = await prepareCache(env, run, slot),
    spec = JSON.parse(b.spec) as CacheSpec;
  if (spec.policy === "pull") fail(403, "Read-only cache policy");
  if (b.format === "worker" && size > CLOUD_CACHE_LIMIT)
    fail(413, "Cloud cache exceeds 4 MiB");
  if (["manual", "push", "schedule"].includes(run.source_trigger || "")) {
    const response = await engine(
      env,
      run,
      "/branch?branch=" + encodeURIComponent(run.ref),
    );
    if (!response.ok) {
      await response.body?.cancel();
      fail(409, "Cache writes require a current branch commit");
    }
    if (((await response.json()) as { sha: string }).sha !== run.sha)
      fail(409, "Cache writes require a current branch commit");
  }
  const id = crypto.randomUUID(),
    object_key = `ci/${run.repo_id}/cache/${id}`,
    now = Date.now();
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO ci_cache_entries(id,repo_id,run_id,slot,generation,scope,cache_key,format,label,paths,ref,object_key,size,checksum,created_at,expires_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${variableLive} AND EXISTS(SELECT 1 FROM ci_cache_state WHERE repo_id=? AND generation=?) AND (SELECT COUNT(*) FROM ci_cache_entries WHERE repo_id=?)<100 AND COALESCE((SELECT SUM(size) FROM ci_cache_entries WHERE repo_id=?),0)+?<=?`,
  )
    .bind(
      id,
      run.repo_id,
      run.id,
      slot,
      b.generation,
      b.scope,
      (JSON.parse(b.keys) as string[])[0],
      b.format,
      spec.key,
      JSON.stringify(spec.paths),
      run.ref,
      object_key,
      size,
      checksum,
      now,
      now + CACHE_TTL,
      run.id,
      run.lease_hash,
      Date.now(),
      run.repo_id,
      b.generation,
      run.repo_id,
      run.repo_id,
      size,
      CACHE_QUOTA,
    )
    .run();
  if (!result.meta.changes) {
    const existing = await env.DB.prepare(
      "SELECT id FROM ci_cache_entries WHERE run_id=? AND slot=? AND checksum=? AND state='ready'",
    )
      .bind(run.id, slot, checksum)
      .first();
    if (existing) {
      await assertCacheLive(env, run, b);
      return existing;
    }
    fail(409, "Cache quota, generation or upload slot unavailable");
  }
  try {
    await put(object_key);
    await assertCacheLive(env, run, b);
    const ready = await env.DB.prepare(
      `UPDATE ci_cache_entries SET state='ready' WHERE id=? AND state='uploading' AND ${variableLive} AND EXISTS(SELECT 1 FROM ci_cache_state WHERE repo_id=? AND generation=?)`,
    )
      .bind(id, run.id, run.lease_hash, Date.now(), run.repo_id, b.generation)
      .run();
    if (!ready.meta.changes) fail(409, "Cache publication revoked");
    return { id };
  } catch (e) {
    await env.DB.prepare(
      "UPDATE ci_cache_entries SET state='retired' WHERE id=?",
    )
      .bind(id)
      .run();
    await env.OBJECTS.delete(object_key);
    await env.DB.prepare("DELETE FROM ci_cache_entries WHERE id=?")
      .bind(id)
      .run();
    throw e;
  }
}
export async function cloudCacheInputs(env: Env, run: CIRun) {
  const slots = cacheSelectionSchema.parse(JSON.parse(run.config)).caches || [],
    files: Record<
      string,
      ReturnType<typeof cacheFilesSchema.parse>
    > = Object.create(null),
    events: string[] = [];
  let total = 0;
  for (const spec of slots) {
    files[spec.id] = {};
    try {
      const hit = await readCache(env, run, spec.id);
      if (!hit) {
        events.push("Cache MISS " + spec.id);
        continue;
      }
      const data = await boundedBody(
        new Response(hit.object.body),
        CLOUD_CACHE_LIMIT - total,
      );
      total += data.length;
      if ((await digest(data)) !== hit.entry.checksum)
        throw Error("Cache checksum mismatch");
      const value = cacheFilesSchema.parse(
        JSON.parse(new TextDecoder().decode(data)),
      );
      if (Object.keys(value).some((p) => !cacheContains(spec, p)))
        throw Error("Cache path outside configuration");
      await assertCacheLive(env, run, hit.binding);
      files[spec.id] = value;
      events.push("Cache HIT " + spec.id);
    } catch (e) {
      events.push(
        "Cache MISS " +
          spec.id +
          " (" +
          (e instanceof Error ? e.message : "unavailable") +
          ")",
      );
    }
  }
  return { files, events };
}
export async function saveCloudCaches(
  env: Env,
  run: CIRun,
  files: Record<string, unknown>,
) {
  const specs = cacheSelectionSchema.parse(JSON.parse(run.config)).caches || [],
    events: string[] = [];
  let total = 0;
  for (const [slot, value] of Object.entries(files)) {
    const spec = specs.find((s) => s.id === slot);
    if (!spec) throw Error("Unconfigured cache output");
    if (spec.policy === "pull") continue;
    const parsed = cacheFilesSchema.parse(value);
    if (Object.keys(parsed).some((p) => !cacheContains(spec, p)))
      throw Error("Cache output outside configured paths");
    if (!Object.keys(parsed).length) continue;
    const data = new TextEncoder().encode(JSON.stringify(parsed));
    total += data.length;
    if (total > CLOUD_CACHE_LIMIT) throw Error("Cloud caches exceed 4 MiB");
    try {
      await writeCache(env, run, slot, data.length, await digest(data), (key) =>
        env.OBJECTS.put(key, data),
      );
      events.push("Cache SAVED " + slot);
    } catch (e) {
      events.push(
        "Cache SKIP " +
          slot +
          " (" +
          (e instanceof Error ? e.message : "unavailable") +
          ")",
      );
    }
  }
  return events;
}
export async function collectCICaches(env: Env, repoId?: string) {
  const now = Date.now();
  const rows = (
    await env.DB.prepare(
      `SELECT e.* FROM ci_cache_entries e WHERE (? IS NULL OR e.repo_id=?) AND ((e.state='uploading' AND e.created_at<?) OR (e.state!='uploading' AND (e.state='retired' OR e.expires_at<? OR NOT EXISTS(SELECT 1 FROM ci_cache_state s JOIN repositories r ON r.id=s.repo_id WHERE s.repo_id=e.repo_id AND s.generation=e.generation AND r.deleted_at IS NULL AND r.archived_at IS NULL) OR EXISTS(SELECT 1 FROM ci_runs c WHERE c.id=e.run_id AND c.status IN('failed','canceled')) OR NOT EXISTS(SELECT 1 FROM ci_runs c WHERE c.id=e.run_id) OR EXISTS(SELECT 1 FROM ci_runs c JOIN ci_runs p ON p.id=c.parent_id WHERE c.id=e.run_id AND p.status IN('failed','canceled')) OR (EXISTS(SELECT 1 FROM ci_visible_caches newer WHERE newer.repo_id=e.repo_id AND newer.scope=e.scope AND newer.cache_key=e.cache_key AND newer.format=e.format AND newer.generation=e.generation AND newer.created_at>e.created_at)))) ) ORDER BY e.created_at LIMIT 100`,
    )
      .bind(repoId || null, repoId || null, now - 10 * 60 * 1000, now)
      .all<CacheEntry>()
  ).results;
  for (const row of rows) {
    // A stale uploader cannot publish after retirement; object deletion is retryable.
    await env.DB.prepare(
      "UPDATE ci_cache_entries SET state='retired' WHERE id=?",
    )
      .bind(row.id)
      .run();
    await env.OBJECTS.delete(row.object_key);
    await env.DB.prepare(
      "DELETE FROM ci_cache_entries WHERE id=? AND state='retired'",
    )
      .bind(row.id)
      .run();
  }
  return rows.length;
}
