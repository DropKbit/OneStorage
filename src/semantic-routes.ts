import type { Hono, Context } from "hono";
import type { App } from "./types";
import { z } from "zod";
import { jsonInput } from "./workspaces";
import { fail } from "./security";
import {
  semanticConfigured,
  semanticSettings,
  publishSemantic,
  EMBEDDING_MODEL,
  SEMANTIC_LIMITS,
} from "./semantic";
async function admin(c: Context<App>, write = false) {
  if (c.get("delegation") || c.get("deploy"))
    fail(403, "User credentials required");
  const u = c.get("user");
  if (!u) fail(401, "Sign in required");
  const live = await c.env.DB.prepare(
    `SELECT u.id FROM users u JOIN credentials c ON c.user_id=u.id WHERE u.id=? AND u.admin=1 AND u.disabled=0 AND c.hash=? AND c.expires_at>? AND c.kind IN('pat','session') AND (?=0 OR c.kind='session' OR c.scope='write')`,
  )
    .bind(u.id, c.get("credential") || "", Date.now(), write ? 1 : 0)
    .first();
  if (!live) fail(403, "Current administrator credentials required");
  return u;
}
function writeGuard(c: Context<App>, guard: string) {
  return c.env.DB.prepare(
    `INSERT INTO mutation_guards(id,accepted) SELECT ?,CASE WHEN EXISTS(
    SELECT 1 FROM users u JOIN credentials t ON t.user_id=u.id WHERE u.id=? AND u.admin=1 AND u.disabled=0 AND t.hash=? AND t.expires_at>? AND (t.kind='session' OR (t.kind='pat' AND t.scope='write'))
  ) THEN 1 ELSE 0 END`,
  ).bind(guard, c.get("user")!.id, c.get("credential") || "", Date.now());
}
async function mutation(c: Context<App>, statements: D1PreparedStatement[]) {
  const guard = crypto.randomUUID();
  try {
    await c.env.DB.batch([
      writeGuard(c, guard),
      ...statements,
      c.env.DB.prepare("DELETE FROM mutation_guards WHERE id=?").bind(guard),
    ]);
  } catch (error) {
    await admin(c, true);
    throw error;
  }
}
export function registerSemanticRoutes(app: Hono<App>) {
  app.get("/api/admin/semantic", async (c) => {
    await admin(c);
    const settings = await semanticSettings(c.env);
    const [usage, rows] = await Promise.all([
      c.env.DB.prepare("SELECT * FROM semantic_usage WHERE day=?")
        .bind(new Date().toISOString().slice(0, 10))
        .first(),
      c.env.DB.prepare(
        `SELECT r.id,r.namespace,r.name,s.status,s.chunks,s.skipped,s.error,s.checked_at,s.generation IS NOT c.generation AS stale,c.indexed_sha,c.indexed_branch FROM repositories r LEFT JOIN semantic_state s ON s.repo_id=r.id LEFT JOIN code_index_state c ON c.repo_id=r.id WHERE r.deleted_at IS NULL ORDER BY r.namespace,r.name LIMIT 200`,
      ).all(),
    ]);
    return c.json({
      configured: semanticConfigured(c.env),
      settings,
      model: EMBEDDING_MODEL,
      limits: SEMANTIC_LIMITS,
      usage: usage || {
        index_chars: 0,
        query_chars: 0,
        index_requests: 0,
        query_requests: 0,
      },
      repositories: rows.results,
    });
  });
  app.patch("/api/admin/semantic", async (c) => {
    const b = z
      .object({
        enabled: z.boolean(),
        daily_chars: z.number().int().min(1000).max(50000000),
      })
      .strict()
      .parse(await jsonInput(c));
    const u = await admin(c, true);
    await mutation(c, [
      c.env.DB.prepare(
        "UPDATE semantic_settings SET enabled=?,daily_chars=? WHERE id=1",
      ).bind(b.enabled ? 1 : 0, b.daily_chars),
      c.env.DB.prepare(
        "INSERT INTO audit(actor_id,action,detail) VALUES(?,'semantic.settings',?)",
      ).bind(u.id, JSON.stringify(b)),
    ]);
    if (b.enabled)
      c.executionCtx.waitUntil(publishSemantic(c.env).catch(() => {}));
    return c.json({ ok: true });
  });
  app.post("/api/admin/semantic/rebuild", async (c) => {
    const b = z
      .object({ repo_id: z.string().min(1).max(128) })
      .strict()
      .parse(await jsonInput(c));
    const u = await admin(c, true);
    if (
      !(await c.env.DB.prepare(
        "SELECT id FROM repositories WHERE id=? AND deleted_at IS NULL",
      )
        .bind(b.repo_id)
        .first())
    )
      fail(404, "Repository not found");
    await mutation(c, [
      c.env.DB.prepare(
        `INSERT INTO semantic_state(repo_id) VALUES(?) ON CONFLICT(repo_id) DO UPDATE SET generation=NULL,cursor_blob='',chunk_offset=0,chunks=0,skipped=0,status='queued',retry_at=0,error=NULL,lease=NULL,lease_until=0`,
      ).bind(b.repo_id),
      c.env.DB.prepare(
        "UPDATE semantic_chunks SET ready=0 WHERE repo_id=?",
      ).bind(b.repo_id),
      c.env.DB.prepare(
        "INSERT INTO audit(actor_id,repo_id,action,detail) VALUES(?,?,'semantic.rebuild','{}')",
      ).bind(u.id, b.repo_id),
    ]);
    c.executionCtx.waitUntil(publishSemantic(c.env).catch(() => {}));
    return c.json({ scheduled: true }, 202);
  });
}
