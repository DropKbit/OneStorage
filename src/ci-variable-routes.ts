import type { Hono, Context } from "hono";
import type { App, Repo } from "./types";
import { z } from "zod";
import { identity, jsonInput } from "./workspaces";
import { variableSchema } from "./ci-variable-schema";
import { seal, unseal } from "./sync-config";
import { variableContext } from "./ci-variables";
import { fail } from "./security";
const authority = `(r.workspace_id IS NULL AND r.owner_id=u.id) OR EXISTS(SELECT 1 FROM members m WHERE m.repo_id=r.id AND m.user_id=u.id AND m.role IN('maintainer','owner')) OR EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=r.workspace_id AND m.user_id=u.id AND m.role IN('maintainer','owner'))`;
const publicFields =
  "id,key,environment,secret,protected,refs,enabled,revision,owner_id,created_at,updated_at";
const metadata = (r: any) => ({ ...r, refs: JSON.parse(r.refs) });
export function registerVariableRoutes(
  app: Hono<App>,
  h: {
    access: (
      c: Context<App>,
      level?: "read" | "write" | "maintain",
    ) => Promise<Repo>;
  },
) {
  const base = "/api/repos/:namespace/:repo/ci/variables";
  async function mutation(
    c: Context<App>,
    repo: Repo,
    stmt: D1PreparedStatement,
    action: string,
    id: string,
    condition = "1",
    args: unknown[] = [],
  ) {
    const actor = identity(c),
      guard = crypto.randomUUID();
    try {
      await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO mutation_guards(id,accepted) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM repositories r JOIN users u ON u.id=? WHERE r.id=? AND r.deleted_at IS NULL AND r.archived_at IS NULL AND u.disabled=0 AND (${authority})) AND (${condition}) THEN 1 ELSE 0 END`,
        ).bind(guard, actor.id, repo.id, ...args),
        stmt,
        c.env.DB.prepare(
          "INSERT INTO audit(repo_id,actor_id,action,detail) VALUES(?,?,?,?)",
        ).bind(repo.id, actor.id, action, id),
        c.env.DB.prepare("DELETE FROM mutation_guards WHERE id=?").bind(guard),
      ]);
    } catch (e) {
      if (
        e instanceof Error &&
        /CHECK constraint|UNIQUE constraint/.test(e.message)
      )
        fail(409, "Variable version, key scope or permissions changed; reload");
      throw e;
    }
  }
  app.get(base, async (c) => {
    const repo = await h.access(c, "maintain");
    const rows = (
      await c.env.DB.prepare(
        `SELECT ${publicFields} FROM ci_variables WHERE repo_id=? ORDER BY key,environment`,
      )
        .bind(repo.id)
        .all<any>()
    ).results;
    return c.json({
      variables: rows.map(metadata),
    });
  });
  app.post(base, async (c) => {
    const repo = await h.access(c, "maintain"),
      b = variableSchema.parse(await jsonInput(c)),
      id = crypto.randomUUID();
    if (b.value === undefined) fail(400, "Variable value required");
    const encrypted = await seal(c.env, variableContext(repo.id, id), b.value);
    await mutation(
      c,
      repo,
      c.env.DB.prepare(
        "INSERT INTO ci_variables(id,repo_id,owner_id,key,environment,encrypted,secret,protected,refs,enabled) VALUES(?,?,?,?,?,?,?,?,?,?)",
      ).bind(
        id,
        repo.id,
        identity(c).id,
        b.key,
        b.environment,
        encrypted,
        Number(b.secret),
        Number(b.protected),
        JSON.stringify(b.refs),
        Number(b.enabled),
      ),
      "ci.variable.create",
      id,
      "(SELECT COUNT(*) FROM ci_variables WHERE repo_id=?)<100",
      [repo.id],
    );
    return c.json(
      metadata(
        await c.env.DB.prepare(
          `SELECT ${publicFields} FROM ci_variables WHERE id=?`,
        )
          .bind(id)
          .first(),
      ),
      201,
    );
  });
  app.put(base + "/:variable", async (c) => {
    const repo = await h.access(c, "maintain"),
      id = c.req.param("variable") || "",
      raw = await jsonInput(c),
      revision = z.number().int().nonnegative().parse(raw.revision),
      { revision: _, ...value } = raw,
      b = variableSchema.parse(value);
    const old = await c.env.DB.prepare(
      "SELECT * FROM ci_variables WHERE id=? AND repo_id=?",
    )
      .bind(id, repo.id)
      .first<any>();
    if (!old) fail(404, "Variable not found");
    const text =
      b.value ??
      (await unseal<string>(
        c.env,
        variableContext(repo.id, id),
        old.encrypted,
      ));
    variableSchema.parse({ ...b, value: text });
    const encrypted = await seal(c.env, variableContext(repo.id, id), text);
    await mutation(
      c,
      repo,
      c.env.DB.prepare(
        "UPDATE ci_variables SET key=?,environment=?,encrypted=?,secret=?,protected=?,refs=?,enabled=?,revision=revision+1,updated_at=datetime('now') WHERE id=?",
      ).bind(
        b.key,
        b.environment,
        encrypted,
        Number(b.secret),
        Number(b.protected),
        JSON.stringify(b.refs),
        Number(b.enabled),
        id,
      ),
      "ci.variable.update",
      id,
      "EXISTS(SELECT 1 FROM ci_variables WHERE id=? AND repo_id=? AND revision=?) AND (?=0 OR EXISTS(SELECT 1 FROM ci_variables v JOIN repositories r ON r.id=v.repo_id JOIN users u ON u.id=v.owner_id WHERE v.id=? AND u.disabled=0 AND (" +
        authority +
        ")))",
      [id, repo.id, revision, Number(b.enabled), id],
    );
    return c.json(
      metadata(
        await c.env.DB.prepare(
          `SELECT ${publicFields} FROM ci_variables WHERE id=?`,
        )
          .bind(id)
          .first(),
      ),
    );
  });
  app.post(base + "/:variable/take-ownership", async (c) => {
    const repo = await h.access(c, "maintain"),
      id = c.req.param("variable") || "",
      b = z
        .object({ revision: z.number().int().nonnegative() })
        .strict()
        .parse(await jsonInput(c));
    await mutation(
      c,
      repo,
      c.env.DB.prepare(
        "UPDATE ci_variables SET owner_id=?,enabled=0,revision=revision+1,updated_at=datetime('now') WHERE id=?",
      ).bind(identity(c).id, id),
      "ci.variable.take-ownership",
      id,
      "EXISTS(SELECT 1 FROM ci_variables WHERE id=? AND repo_id=? AND revision=?)",
      [id, repo.id, b.revision],
    );
    return c.json({ ok: true });
  });
  app.delete(base + "/:variable", async (c) => {
    const repo = await h.access(c, "maintain"),
      id = c.req.param("variable") || "",
      b = z
        .object({ revision: z.number().int().nonnegative() })
        .strict()
        .parse(await jsonInput(c));
    await mutation(
      c,
      repo,
      c.env.DB.prepare("DELETE FROM ci_variables WHERE id=?").bind(id),
      "ci.variable.delete",
      id,
      "EXISTS(SELECT 1 FROM ci_variables WHERE id=? AND repo_id=? AND revision=?)",
      [id, repo.id, b.revision],
    );
    return c.json({ ok: true });
  });
}
