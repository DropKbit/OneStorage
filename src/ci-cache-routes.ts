import type { Hono, Context } from "hono";
import type { App, Repo } from "./types";
import type { CIRun } from "./ci";
import { z } from "zod";
import { fail } from "./security";
import { jsonInput, identity } from "./workspaces";
import { readCache, writeCache } from "./ci-cache";
import { CACHE_LIMIT, CACHE_QUOTA, CACHE_TTL } from "./ci-cache-schema";
const authority = `(r.workspace_id IS NULL AND r.owner_id=u.id) OR EXISTS(SELECT 1 FROM members m WHERE m.repo_id=r.id AND m.user_id=u.id AND m.role IN('maintainer','owner')) OR EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=r.workspace_id AND m.user_id=u.id AND m.role IN('maintainer','owner'))`;
export function registerCacheRoutes(
  app: Hono<App>,
  h: {
    access: (
      c: Context<App>,
      level?: "read" | "write" | "maintain",
    ) => Promise<Repo>;
    lease: (c: Context<App>) => Promise<{ run: CIRun }>;
  },
) {
  const base = "/api/repos/:namespace/:repo/ci/caches";
  app.get(base, async (c) => {
    const r = await h.access(c);
    const state = await c.env.DB.prepare(
      "SELECT generation FROM ci_cache_state WHERE repo_id=?",
    )
      .bind(r.id)
      .first<{ generation: number }>();
    const entries = (
      await c.env.DB.prepare(
        "SELECT id,run_id,slot,label,paths,ref,format,size,created_at,expires_at FROM ci_visible_caches WHERE repo_id=? AND expires_at>? ORDER BY created_at DESC LIMIT 100",
      )
        .bind(r.id, Date.now())
        .all<any>()
    ).results;
    const used = await c.env.DB.prepare(
      "SELECT COALESCE(SUM(size),0) bytes,COUNT(*) entries FROM ci_cache_entries WHERE repo_id=?",
    )
      .bind(r.id)
      .first();
    return c.json({
      generation: state?.generation || 0,
      entries: entries.map((e) => ({ ...e, paths: JSON.parse(e.paths) })),
      used,
      limits: {
        bytes: CACHE_QUOTA,
        entries: 100,
        entry_bytes: CACHE_LIMIT,
        ttl_ms: CACHE_TTL,
      },
    });
  });
  app.post(base + "/clear", async (c) => {
    const r = await h.access(c, "maintain"),
      b = z
        .object({ generation: z.number().int().nonnegative() })
        .strict()
        .parse(await jsonInput(c)),
      actor = identity(c),
      guard = crypto.randomUUID();
    try {
      await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO mutation_guards(id,accepted) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM repositories r JOIN users u ON u.id=? WHERE r.id=? AND r.deleted_at IS NULL AND r.archived_at IS NULL AND u.disabled=0 AND (${authority})) AND COALESCE((SELECT generation FROM ci_cache_state WHERE repo_id=?),0)=? THEN 1 ELSE 0 END`,
        ).bind(guard, actor.id, r.id, r.id, b.generation),
        c.env.DB.prepare(
          "INSERT INTO ci_cache_state(repo_id,generation) VALUES(?,1) ON CONFLICT(repo_id) DO UPDATE SET generation=generation+1",
        ).bind(r.id),
        c.env.DB.prepare(
          "INSERT INTO audit(repo_id,actor_id,action,detail) VALUES(?,?,?,?)",
        ).bind(r.id, actor.id, "ci.cache.clear", String(b.generation)),
        c.env.DB.prepare("DELETE FROM mutation_guards WHERE id=?").bind(guard),
      ]);
    } catch (e) {
      if (e instanceof Error && /CHECK constraint/.test(e.message))
        fail(409, "Cache generation or permission changed");
      throw e;
    }
    if (c.env.EVENTS)
      try {
        await c.env.EVENTS.send({ id: "ci-cache-gc:" + r.id });
      } catch {}
    return c.json({ generation: b.generation + 1, cleanup: "scheduled" });
  });
  app.get("/api/runner/runs/:id/caches/:slot", async (c) => {
    const { run } = await h.lease(c),
      hit = await readCache(c.env, run, c.req.param("slot"));
    await h.lease(c);
    c.header("Cache-Control", "no-store");
    if (!hit) return c.json({ hit: false });
    return new Response(hit.object.body, {
      headers: {
        "content-type": "application/gzip",
        "cache-control": "no-store",
        "content-length": String(hit.entry.size),
        "x-cache-sha256": hit.entry.checksum,
        "x-cache-id": hit.entry.id,
      },
    });
  });
  app.put("/api/runner/runs/:id/caches/:slot", async (c) => {
    const { run } = await h.lease(c),
      size = Number(c.req.header("content-length")),
      checksum = c.req.header("x-cache-sha256") || "";
    if (
      !c.req.raw.body ||
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      size > CACHE_LIMIT
    )
      fail(400, "Cache Content-Length must be 1..64 MiB");
    const result = await writeCache(
      c.env,
      run,
      c.req.param("slot"),
      size,
      checksum,
      async (key) => {
        const stream = new FixedLengthStream(size),
          abort = new AbortController(),
          timer = setTimeout(
            () => abort.abort(Error("Cache upload timed out")),
            90000,
          );
        try {
          const results = await Promise.allSettled([
            c.req.raw.body!.pipeTo(stream.writable, { signal: abort.signal }),
            c.env.OBJECTS.put(key, stream.readable, { sha256: checksum }).catch(
              (e) => {
                abort.abort(e);
                throw e;
              },
            ),
          ]);
          for (const r of results) if (r.status === "rejected") throw r.reason;
        } finally {
          clearTimeout(timer);
        }
      },
    );
    return c.json(result, 201);
  });
}
