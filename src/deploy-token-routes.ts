import type { Context, Hono } from "hono";
import { z } from "zod";
import type { App, Repo } from "./types";
import { roleRank } from "./access";
import { identity, jsonInput, workspaceAccess } from "./workspaces";
import { stepUp } from "./account";
import { digest, fail } from "./security";
import { unguardDatabase } from "./project-db";
import { deployInput, deployScopes, newDeploySecret } from "./deploy-tokens";
const fields =
  "id,name,username,scopes,created_by,created_at,expires_at,revision,revoked_at,last_used_at";
const metadata = (row: any) => ({
  ...row,
  scopes: JSON.parse(row.scopes),
  status:
    row.revoked_at !== null
      ? "revoked"
      : row.expires_at <= Date.now()
        ? "expired"
        : "active",
});
type Scope = { id: string; column: "repo_id" | "workspace_id"; repo?: Repo };
export function registerDeployTokenRoutes(
  app: Hono<App>,
  h: {
    access: (
      c: Context<App>,
      level?: "read" | "write" | "maintain",
    ) => Promise<Repo>;
  },
) {
  for (const workspace of [false, true]) {
    const base = workspace
      ? "/api/workspaces/:slug/deploy-tokens"
      : "/api/repos/:namespace/:repo/deploy-tokens";
    async function access(c: Context<App>): Promise<Scope> {
      identity(c);
      if (!["session", "pat"].includes(c.get("kind") || ""))
        fail(403, "User credential required");
      if (c.req.method !== "GET" && c.get("scope") !== "write")
        fail(403, "Write credential required");
      if (workspace)
        return {
          id: (await workspaceAccess(c, c.req.param("slug")!, 4)).id,
          column: "workspace_id",
        };
      const repo = await h.access(
        c,
        c.req.method === "GET" ? "read" : "maintain",
      );
      if (roleRank[c.get("repoRole")] < 3)
        fail(403, "Project maintainer required");
      return { id: repo.id, column: "repo_id", repo };
    }
    async function mutation(
      c: Context<App>,
      scope: Scope,
      statement: D1PreparedStatement,
      action: string,
      detail: unknown,
      condition: string,
      args: unknown[],
    ) {
      const db = unguardDatabase(c.env.DB),
        u = identity(c),
        guard = crypto.randomUUID();
      const authorization = workspace
        ? "EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=? AND m.user_id=u.id AND m.role='owner')"
        : "EXISTS(SELECT 1 FROM repositories r WHERE r.id=? AND r.lifecycle_revision=? AND r.deleted_at IS NULL AND ((r.workspace_id IS NULL AND r.owner_id=u.id) OR EXISTS(SELECT 1 FROM members m WHERE m.repo_id=r.id AND m.user_id=u.id AND m.role IN('maintainer','owner')) OR EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=r.workspace_id AND m.user_id=u.id AND m.role IN('maintainer','owner'))))";
      try {
        const result = await db.batch([
          db
            .prepare(
              `INSERT INTO mutation_guards(id,accepted) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM users u JOIN credentials c ON c.user_id=u.id WHERE u.id=? AND u.disabled=0 AND c.hash=? AND c.kind IN('session','pat') AND c.scope='write' AND c.expires_at>? AND ${authorization}) AND (${condition}) THEN 1 ELSE 0 END`,
            )
            .bind(
              guard,
              u.id,
              c.get("credential"),
              Date.now(),
              scope.id,
              ...(scope.repo ? [scope.repo.lifecycle_revision || 0] : []),
              ...args,
            ),
          statement,
          db
            .prepare(
              "INSERT INTO audit(repo_id,actor_id,action,detail) VALUES(?,?,?,?)",
            )
            .bind(
              scope.repo?.id || null,
              u.id,
              action,
              JSON.stringify({ [scope.column]: scope.id, detail }),
            ),
          db.prepare("DELETE FROM mutation_guards WHERE id=?").bind(guard),
        ]);
        return metadata(result[1].results[0]);
      } catch (e) {
        if (/CHECK constraint|UNIQUE constraint/.test(String(e)))
          fail(
            409,
            "Deploy token revision, quota or manager authorization changed",
          );
        throw e;
      }
    }
    app.get(base, async (c) => {
      const scope = await access(c),
        offset = z.coerce
          .number()
          .int()
          .min(0)
          .max(100000)
          .parse(c.req.query("offset") || 0);
      const rows = (
        await c.env.DB.prepare(
          `SELECT ${fields} FROM deploy_tokens WHERE ${scope.column}=? ORDER BY created_at DESC,id DESC LIMIT 51 OFFSET ?`,
        )
          .bind(scope.id, offset)
          .all()
      ).results;
      return c.json({
        tokens: rows.slice(0, 50).map(metadata),
        next_offset: rows.length > 50 ? offset + 50 : null,
        available_scopes: deployScopes,
        limit: 100,
      });
    });
    app.post(base, async (c) => {
      const scope = await access(c),
        b = deployInput.parse(await jsonInput(c));
      if (c.get("kind") === "session") await stepUp(c, b.otp);
      const id = crypto.randomUUID(),
        token = newDeploySecret(),
        hash = await digest(token),
        now = Date.now(),
        username = b.username || "onestorage+deploy-" + id;
      const row = await mutation(
        c,
        scope,
        unguardDatabase(c.env.DB)
          .prepare(
            `INSERT INTO deploy_tokens(id,hash,repo_id,workspace_id,name,username,scopes,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING ${fields}`,
          )
          .bind(
            id,
            hash,
            scope.repo ? scope.id : null,
            workspace ? scope.id : null,
            b.name,
            username,
            JSON.stringify(b.scopes),
            identity(c).id,
            now,
            now + b.days * 86400000,
          ),
        "deploy_token.create",
        { id, name: b.name, scopes: b.scopes },
        `(SELECT COUNT(*) FROM deploy_tokens WHERE ${scope.column}=? AND revoked_at IS NULL AND expires_at>?)<100`,
        [scope.id, now],
      );
      return c.json({ ...row, token }, 201);
    });
    app.post(base + "/:id/rotate", async (c) => {
      const scope = await access(c),
        id = z.uuid().parse(c.req.param("id")),
        b = z
          .object({
            revision: z.number().int().positive(),
            days: z.number().int().min(1).max(365).default(90),
            otp: z.string().max(64).default(""),
          })
          .strict()
          .parse(await jsonInput(c));
      if (c.get("kind") === "session") await stepUp(c, b.otp);
      const token = newDeploySecret(),
        hash = await digest(token);
      const row = await mutation(
        c,
        scope,
        unguardDatabase(c.env.DB)
          .prepare(
            `UPDATE deploy_tokens SET hash=?,expires_at=?,revision=revision+1,last_used_at=NULL WHERE id=? AND ${scope.column}=? RETURNING ${fields}`,
          )
          .bind(hash, Date.now() + b.days * 86400000, id, scope.id),
        "deploy_token.rotate",
        { id },
        `EXISTS(SELECT 1 FROM deploy_tokens WHERE id=? AND ${scope.column}=? AND revision=? AND revoked_at IS NULL AND (expires_at>? OR (SELECT COUNT(*) FROM deploy_tokens WHERE ${scope.column}=? AND revoked_at IS NULL AND expires_at>?)<100))`,
        [id, scope.id, b.revision, Date.now(), scope.id, Date.now()],
      );
      return c.json({ ...row, token });
    });
    app.delete(base + "/:id", async (c) => {
      const scope = await access(c),
        id = z.uuid().parse(c.req.param("id")),
        b = z
          .object({ revision: z.number().int().positive() })
          .strict()
          .parse(await jsonInput(c));
      const row = await mutation(
        c,
        scope,
        unguardDatabase(c.env.DB)
          .prepare(
            `UPDATE deploy_tokens SET revoked_at=?,revision=revision+1 WHERE id=? AND ${scope.column}=? RETURNING ${fields}`,
          )
          .bind(Date.now(), id, scope.id),
        "deploy_token.revoke",
        { id },
        `EXISTS(SELECT 1 FROM deploy_tokens WHERE id=? AND ${scope.column}=? AND revision=? AND revoked_at IS NULL)`,
        [id, scope.id, b.revision],
      );
      return c.json(row);
    });
  }
}
