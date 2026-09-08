import type { Hono, Context } from "hono";
import type { App } from "./types";
import { z } from "zod";
import { identity, jsonInput, workspaceAccess } from "./workspaces";
import { variableSchema } from "./ci-variable-schema";
import { seal, unseal } from "./sync-config";
import { workspaceVariableContext } from "./ci-variables";
import { fail } from "./security";
const fields =
  "id,key,environment,secret,protected,refs,enabled,revision,owner_id,created_at,updated_at";
const metadata = (r: any) => ({ ...r, refs: JSON.parse(r.refs) });
export function registerWorkspaceVariableRoutes(app: Hono<App>) {
  const base = "/api/workspaces/:slug/ci/variables";
  async function access(c: Context<App>) {
    if (c.req.method !== "GET" && c.get("scope") !== "write")
      fail(403, "Write scope required");
    return workspaceAccess(c, c.req.param("slug")!, 4);
  }
  async function mutate(
    c: Context<App>,
    workspace: string,
    statement: D1PreparedStatement,
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
          `INSERT INTO mutation_guards(id,accepted) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM workspace_members m JOIN users u ON u.id=m.user_id JOIN credentials c ON c.user_id=u.id WHERE m.workspace_id=? AND m.user_id=? AND m.role='owner' AND u.disabled=0 AND c.hash=? AND c.kind IN ('session','pat') AND c.scope='write' AND c.expires_at>?) AND (${condition}) THEN 1 ELSE 0 END`,
        ).bind(
          guard,
          workspace,
          actor.id,
          c.get("credential"),
          Date.now(),
          ...args,
        ),
        statement,
        c.env.DB.prepare(
          "INSERT INTO audit(actor_id,action,detail) VALUES(?,?,?)",
        ).bind(actor.id, action, JSON.stringify({ workspace, variable: id })),
        c.env.DB.prepare("DELETE FROM mutation_guards WHERE id=?").bind(guard),
      ]);
    } catch (e) {
      if (
        e instanceof Error &&
        /CHECK constraint|UNIQUE constraint/.test(e.message)
      )
        fail(
          409,
          "Variable revision, scope or current workspace owner authorization changed",
        );
      throw e;
    }
  }
  async function row(c: Context<App>, id: string) {
    return metadata(
      await c.env.DB.prepare(
        `SELECT ${fields} FROM ci_workspace_variables WHERE id=?`,
      )
        .bind(id)
        .first(),
    );
  }
  app.get(base, async (c) => {
    const w = await access(c);
    return c.json({
      variables: (
        await c.env.DB.prepare(
          `SELECT ${fields} FROM ci_workspace_variables WHERE workspace_id=? ORDER BY key,environment`,
        )
          .bind(w.id)
          .all()
      ).results.map(metadata),
    });
  });
  app.post(base, async (c) => {
    const w = await access(c),
      b = variableSchema.parse(await jsonInput(c)),
      id = "wcv_" + crypto.randomUUID();
    if (b.value === undefined) fail(400, "Variable value required");
    const encrypted = await seal(
      c.env,
      workspaceVariableContext(w.id, id),
      b.value,
    );
    await mutate(
      c,
      w.id,
      c.env.DB.prepare(
        "INSERT INTO ci_workspace_variables(id,workspace_id,owner_id,key,environment,encrypted,secret,protected,refs,enabled) VALUES(?,?,?,?,?,?,?,?,?,?)",
      ).bind(
        id,
        w.id,
        identity(c).id,
        b.key,
        b.environment,
        encrypted,
        Number(b.secret),
        Number(b.protected),
        JSON.stringify(b.refs),
        Number(b.enabled),
      ),
      "workspace.ci.variable.create",
      id,
      "(SELECT count(*) FROM ci_workspace_variables WHERE workspace_id=?)<100",
      [w.id],
    );
    return c.json(await row(c, id), 201);
  });
  app.put(base + "/:variable", async (c) => {
    const w = await access(c),
      id = c.req.param("variable")!,
      raw = await jsonInput(c),
      revision = z.number().int().nonnegative().parse(raw.revision),
      { revision: _, ...input } = raw,
      b = variableSchema.parse(input);
    const old = await c.env.DB.prepare(
      "SELECT * FROM ci_workspace_variables WHERE id=? AND workspace_id=?",
    )
      .bind(id, w.id)
      .first<any>();
    if (!old) fail(404, "Variable not found");
    const value =
      b.value ??
      (await unseal<string>(
        c.env,
        workspaceVariableContext(w.id, id),
        old.encrypted,
      ));
    variableSchema.parse({ ...b, value });
    const encrypted = await seal(
      c.env,
      workspaceVariableContext(w.id, id),
      value,
    );
    await mutate(
      c,
      w.id,
      c.env.DB.prepare(
        "UPDATE ci_workspace_variables SET key=?,environment=?,encrypted=?,secret=?,protected=?,refs=?,enabled=?,revision=revision+1,updated_at=datetime('now') WHERE id=?",
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
      "workspace.ci.variable.update",
      id,
      "EXISTS(SELECT 1 FROM ci_workspace_variables WHERE id=? AND workspace_id=? AND revision=?) AND (?=0 OR EXISTS(SELECT 1 FROM ci_workspace_variables v JOIN users u ON u.id=v.owner_id JOIN workspace_members m ON m.workspace_id=v.workspace_id AND m.user_id=v.owner_id WHERE v.id=? AND u.disabled=0 AND m.role='owner'))",
      [id, w.id, revision, Number(b.enabled), id],
    );
    return c.json(await row(c, id));
  });
  for (const operation of ["delete", "take-ownership"]) {
    const handler = async (c: Context<App>) => {
      const w = await access(c),
        id = c.req.param("variable")!,
        b = z
          .object({ revision: z.number().int().nonnegative() })
          .strict()
          .parse(await jsonInput(c));
      const statement =
        operation === "delete"
          ? c.env.DB.prepare(
              "DELETE FROM ci_workspace_variables WHERE id=?",
            ).bind(id)
          : c.env.DB.prepare(
              "UPDATE ci_workspace_variables SET owner_id=?,enabled=0,revision=revision+1,updated_at=datetime('now') WHERE id=?",
            ).bind(identity(c).id, id);
      await mutate(
        c,
        w.id,
        statement,
        "workspace.ci.variable." + operation,
        id,
        "EXISTS(SELECT 1 FROM ci_workspace_variables WHERE id=? AND workspace_id=? AND revision=?)",
        [id, w.id, b.revision],
      );
      return c.json({ ok: true });
    };
    if (operation === "delete") app.delete(base + "/:variable", handler);
    else app.post(base + "/:variable/take-ownership", handler);
  }
}
