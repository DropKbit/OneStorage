import type { Hono, Context } from "hono";
import { z } from "zod";
import type { App, Repo } from "./types";
import { slug, fail, boundedBody, passwordHash } from "./security";
import { roleRank } from "./access";
export async function jsonInput(c: Context<App>) {
  try {
    return JSON.parse(
      new TextDecoder().decode(await boundedBody(c.req.raw, 128 * 1024)),
    );
  } catch {
    fail(400, "Invalid JSON");
  }
}
export function identity(c: Context<App>) {
  if (c.get("delegation")) fail(403, "Use a user session or personal token");
  return c.get("user") || fail(401, "Sign in required");
}
async function record(c: Context<App>, action: string, detail: unknown) {
  await c.env.DB.prepare(
    "INSERT INTO audit(actor_id,action,detail) VALUES(?,?,?)",
  )
    .bind(c.get("user")!.id, action, JSON.stringify(detail))
    .run();
}
export async function workspaceAccess(c: Context<App>, name: string, rank = 1) {
  const u = identity(c);
  const workspace = await c.env.DB.prepare(
    "SELECT w.*,m.role FROM workspaces w LEFT JOIN workspace_members m ON m.workspace_id=w.id AND m.user_id=? WHERE w.slug=?",
  )
    .bind(u.id, name)
    .first<any>();
  if (!workspace || !workspace.role) fail(404, "Workspace not found");
  if (roleRank[workspace.role] < rank)
    fail(403, "Insufficient workspace permissions");
  return workspace;
}
export function registerWorkspaceRoutes(
  app: Hono<App>,
  h: {
    engine: (
      c: Context<App>,
      repo: Repo,
      path: string,
      options?: any,
    ) => Promise<Response>;
  },
) {
  app.get("/api/workspaces", async (c) => {
    const u = identity(c);
    const rows = await c.env.DB.prepare(
      "SELECT w.*,m.role FROM workspaces w JOIN workspace_members m ON m.workspace_id=w.id WHERE m.user_id=? ORDER BY w.name LIMIT 200",
    )
      .bind(u.id)
      .all();
    return c.json({
      workspaces: [
        {
          id: null,
          slug: u.username,
          name: u.username,
          role: "owner",
          personal: true,
        },
        ...rows.results,
      ],
    });
  });
  app.post("/api/workspaces", async (c) => {
    const u = identity(c),
      b = z
        .object({
          slug,
          name: z.string().trim().min(1).max(80),
          description: z.string().max(1000).default(""),
        })
        .parse(await jsonInput(c));
    const id = crypto.randomUUID();
    try {
      await c.env.DB.batch([
        c.env.DB.prepare(
          "INSERT INTO workspaces(id,slug,name,description) VALUES(?,?,?,?)",
        ).bind(id, b.slug, b.name, b.description),
        c.env.DB.prepare(
          "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(?,?,'owner')",
        ).bind(id, u.id),
      ]);
    } catch {
      fail(409, "Namespace unavailable");
    }
    await record(c, "workspace.create", { id, ...b });
    return c.json({ id, ...b, role: "owner" }, 201);
  });
  app.get("/api/workspaces/:slug", async (c) =>
    c.json(await workspaceAccess(c, c.req.param("slug"))),
  );
  app.patch("/api/workspaces/:slug", async (c) => {
    const w = await workspaceAccess(c, c.req.param("slug"), 3),
      b = z
        .object({
          name: z.string().trim().min(1).max(80),
          description: z.string().max(1000).default(""),
        })
        .parse(await jsonInput(c));
    await c.env.DB.prepare(
      "UPDATE workspaces SET name=?,description=? WHERE id=?",
    )
      .bind(b.name, b.description, w.id)
      .run();
    await record(c, "workspace.update", { id: w.id, ...b });
    return c.json({ ok: true });
  });
  app.get("/api/workspaces/:slug/members", async (c) => {
    const w = await workspaceAccess(c, c.req.param("slug"));
    return c.json({
      members: (
        await c.env.DB.prepare(
          "SELECT u.id,u.username,u.disabled,m.role FROM workspace_members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? ORDER BY u.username",
        )
          .bind(w.id)
          .all()
      ).results,
    });
  });
  app.put("/api/workspaces/:slug/members", async (c) => {
    const w = await workspaceAccess(c, c.req.param("slug"), 4),
      b = z
        .object({
          username: slug,
          role: z.enum(["reader", "developer", "maintainer", "owner"]),
        })
        .parse(await jsonInput(c));
    const u = await c.env.DB.prepare(
      "SELECT id FROM users WHERE username=? AND disabled=0",
    )
      .bind(b.username)
      .first<{ id: string }>();
    if (!u) fail(404, "Active user not found");
    try {
      await c.env.DB.prepare(
        "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(?,?,?) ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=excluded.role",
      )
        .bind(w.id, u.id, b.role)
        .run();
    } catch {
      fail(409, "Workspace needs at least one owner");
    }
    await record(c, "workspace.member.update", { workspace: w.slug, ...b });
    return c.json({ ok: true });
  });
  app.delete("/api/workspaces/:slug/members/:username", async (c) => {
    const w = await workspaceAccess(c, c.req.param("slug"), 4);
    try {
      await c.env.DB.prepare(
        "DELETE FROM workspace_members WHERE workspace_id=? AND user_id=(SELECT id FROM users WHERE username=?)",
      )
        .bind(w.id, c.req.param("username"))
        .run();
    } catch {
      fail(409, "Workspace needs at least one owner");
    }
    await record(c, "workspace.member.remove", {
      workspace: w.slug,
      username: c.req.param("username"),
    });
    return c.json({ ok: true });
  });
  app.delete("/api/workspaces/:slug", async (c) => {
    const w = await workspaceAccess(c, c.req.param("slug"), 4);
    // Archived repositories still refer to their namespace. Keep it reserved until a separate retention policy removes them.
    if (
      await c.env.DB.prepare(
        "SELECT id FROM repositories WHERE workspace_id=? LIMIT 1",
      )
        .bind(w.id)
        .first()
    )
      fail(409, "Workspace still contains repositories");
    await c.env.DB.prepare("DELETE FROM workspaces WHERE id=?")
      .bind(w.id)
      .run();
    await record(c, "workspace.delete", { slug: w.slug });
    return c.json({ ok: true });
  });
  app.use("/api/admin/*", async (c, next) => {
    const u = identity(c);
    if (!u.admin) fail(403, "Administrator required");
    await next();
  });
  app.get("/api/admin/overview", async (c) =>
    c.json(
      await c.env.DB.prepare(
        "SELECT (SELECT COUNT(*) FROM users) AS users,(SELECT COUNT(*) FROM users WHERE disabled=1) AS disabled_users,(SELECT COUNT(*) FROM workspaces) AS workspaces,(SELECT COUNT(*) FROM repositories WHERE deleted_at IS NULL) AS repositories,(SELECT COUNT(*) FROM ci_runs WHERE status IN ('queued','running')) AS active_runs",
      ).first(),
    ),
  );
  app.get("/api/admin/users", async (c) => {
    const q = "%" + (c.req.query("q") || "").slice(0, 100) + "%";
    return c.json({
      users: (
        await c.env.DB.prepare(
          "SELECT id,username,admin,disabled,created_at FROM users WHERE username LIKE ? ORDER BY username LIMIT 200",
        )
          .bind(q)
          .all()
      ).results,
    });
  });
  app.patch("/api/admin/users/:id", async (c) => {
    const b = z
      .object({
        admin: z.boolean().optional(),
        disabled: z.boolean().optional(),
        password: z.string().min(12).max(128).optional(),
        revoke_sessions: z.boolean().optional(),
      })
      .parse(await jsonInput(c));
    const u = await c.env.DB.prepare(
      "SELECT id,admin,disabled FROM users WHERE id=?",
    )
      .bind(c.req.param("id"))
      .first<any>();
    if (!u) fail(404, "User not found");
    if (u.id === c.get("user")!.id && (b.disabled || b.admin === false))
      fail(409, "Cannot disable or demote your own session");
    const statements = [
      c.env.DB.prepare("UPDATE users SET admin=?,disabled=? WHERE id=?").bind(
        b.admin === undefined ? u.admin : Number(b.admin),
        b.disabled === undefined ? u.disabled : Number(b.disabled),
        u.id,
      ),
    ];
    if (b.password)
      statements.push(
        c.env.DB.prepare(
          "UPDATE users SET password=?,has_password=1 WHERE id=?",
        ).bind(await passwordHash(b.password), u.id),
      );
    if (b.password || b.disabled || b.revoke_sessions)
      statements.push(
        c.env.DB.prepare("DELETE FROM credentials WHERE user_id=?").bind(u.id),
        c.env.DB.prepare("DELETE FROM password_recovery WHERE user_id=?").bind(
          u.id,
        ),
      );
    try {
      await c.env.DB.batch(statements);
    } catch {
      fail(409, "Instance needs an active administrator");
    }
    await record(c, "admin.user.update", {
      id: u.id,
      admin: b.admin,
      disabled: b.disabled,
      password_reset: !!b.password,
      revoke_sessions: !!b.revoke_sessions,
    });
    return c.json({ ok: true });
  });
  app.get("/api/admin/workspaces", async (c) =>
    c.json({
      workspaces: (
        await c.env.DB.prepare(
          "SELECT w.*,(SELECT COUNT(*) FROM workspace_members m WHERE m.workspace_id=w.id) AS members FROM workspaces w ORDER BY w.created_at DESC LIMIT 200",
        ).all()
      ).results,
    }),
  );
  app.put("/api/admin/workspaces/:id/owner", async (c) => {
    const b = z.object({ username: slug }).parse(await jsonInput(c));
    const w = await c.env.DB.prepare("SELECT id FROM workspaces WHERE id=?")
      .bind(c.req.param("id"))
      .first();
    const u = await c.env.DB.prepare(
      "SELECT id FROM users WHERE username=? AND disabled=0",
    )
      .bind(b.username)
      .first<{ id: string }>();
    if (!w || !u) fail(404, "Workspace or user not found");
    await c.env.DB.prepare(
      "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(?,?,'owner') ON CONFLICT(workspace_id,user_id) DO UPDATE SET role='owner'",
    )
      .bind(c.req.param("id"), u.id)
      .run();
    await record(c, "admin.workspace.recover", {
      id: c.req.param("id"),
      username: b.username,
    });
    return c.json({ ok: true });
  });
  app.get("/api/admin/repositories", async (c) =>
    c.json({
      repositories: (
        await c.env.DB.prepare(
          "SELECT id,namespace,name,description,visibility,created_at,sync_status FROM repositories WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 200",
        ).all()
      ).results,
    }),
  );
  app.patch("/api/admin/repositories/:id", async (c) => {
    const b = z
      .object({
        description: z.string().max(1000),
        visibility: z.enum(["public", "private"]),
      })
      .parse(await jsonInput(c));
    const r = await c.env.DB.prepare(
      "UPDATE repositories SET description=?,visibility=? WHERE id=? AND deleted_at IS NULL RETURNING id",
    )
      .bind(b.description, b.visibility, c.req.param("id"))
      .first();
    if (!r) fail(404, "Repository not found");
    await record(c, "admin.repository.update", { id: c.req.param("id"), ...b });
    return c.json({ ok: true });
  });
  app.delete("/api/admin/repositories/:id", async (c) => {
    const r = await c.env.DB.prepare(
      "SELECT * FROM repositories WHERE id=? AND deleted_at IS NULL",
    )
      .bind(c.req.param("id"))
      .first<Repo>();
    if (!r) fail(404, "Repository not found");
    await record(c, "admin.repository.delete", {
      id: r.id,
      namespace: r.namespace,
      name: r.name,
    });
    return h.engine(c, r, "/internal/delete", { method: "POST" });
  });
  app.get("/api/admin/audit", async (c) => {
    const before = z.coerce
      .number()
      .int()
      .positive()
      .parse(c.req.query("before") || Number.MAX_SAFE_INTEGER);
    return c.json({
      events: (
        await c.env.DB.prepare(
          "SELECT a.*,u.username AS actor FROM audit a LEFT JOIN users u ON u.id=a.actor_id WHERE a.id<? ORDER BY a.id DESC LIMIT 100",
        )
          .bind(before)
          .all()
      ).results,
    });
  });
}
