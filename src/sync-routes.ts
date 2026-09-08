import { Hono, Context } from "hono";
import type { App, Repo } from "./types";
import { z } from "zod";
import { fail, boundedBody } from "./security";
import {
  upstreamSchema,
  upstreamURL,
  seal,
  credentialSchema,
} from "./sync-config";
import {
  githubSchema,
  githubConfig,
  githubPrivateKey,
  verifyGitHubWebhook,
} from "./github";
import { scheduleSync, publishSyncJobs } from "./sync";
interface Helpers {
  access: (
    c: Context<App>,
    level?: "read" | "write" | "maintain",
  ) => Promise<Repo>;
  engine: (
    c: Context<App>,
    repo: Repo,
    path: string,
    options?: any,
  ) => Promise<Response>;
  audit: (
    c: Context<App>,
    action: string,
    id: string,
    detail?: string,
  ) => Promise<void>;
}
const input = async (c: Context<App>) => {
  try {
    return JSON.parse(
      new TextDecoder().decode(await boundedBody(c.req.raw, 100000)),
    );
  } catch {
    fail(400, "Invalid JSON");
  }
};
export function registerSyncRoutes(app: Hono<App>, h: Helpers) {
  app.put("/api/repos/:namespace/:repo/upstream", async (c) => {
    const repo = await h.access(c, "maintain"),
      raw = await input(c);
    const base = raw === null ? null : upstreamSchema.parse(raw);
    if (base) {
      upstreamURL(base, c.env.SYNC_ALLOWED_HOSTS);
      base.mode =
        base.provider === "github"
          ? base.mode === "public"
            ? "public"
            : "app"
          : "generic";
    }
    const response = await h.engine(c, repo, "/internal/configure-upstream", {
      method: "POST",
      body: JSON.stringify(base),
    });
    if (response.ok) await h.audit(c, "repo.upstream.update", repo.id);
    return response;
  });
  app.delete("/api/repos/:namespace/:repo/base", async (c) => {
    const repo = await h.access(c, "maintain");
    return h.engine(c, repo, "/internal/configure-upstream", {
      method: "POST",
      body: "null",
    });
  });
  app.post("/api/repos/:namespace/:repo/pull-upstream", async (c) => {
    const repo = await h.access(c, "write");
    const job = await scheduleSync(c.env, repo);
    return c.json(job, 202);
  });
  app.get("/api/repos/:namespace/:repo/sync-status", async (c) => {
    const repo = await h.access(c);
    const jobs = await c.env.DB.prepare(
      "SELECT id,status,attempts,error,created_at FROM sync_jobs WHERE repo_id=? ORDER BY created_at DESC,id DESC LIMIT 20",
    )
      .bind(repo.id)
      .all();
    return c.json({
      upstream: repo.base_repo ? JSON.parse(repo.base_repo) : null,
      status: repo.sync_status,
      error: repo.sync_error,
      synced_at: repo.synced_at,
      jobs: jobs.results,
    });
  });
  app.get("/api/repos/:namespace/:repo/git-credentials", async (c) => {
    const repo = await h.access(c, "maintain");
    return c.json({
      credentials: (
        await c.env.DB.prepare(
          "SELECT id,created_at,updated_at FROM git_credentials WHERE repo_id=?",
        )
          .bind(repo.id)
          .all()
      ).results,
    });
  });
  for (const method of ["POST", "PUT"])
    app.on(method, "/api/repos/:namespace/:repo/git-credentials", async (c) => {
      const repo = await h.access(c, "maintain");
      if (!repo.base_repo || JSON.parse(repo.base_repo).provider === "github")
        fail(400, "Generic Git upstream required");
      const b = credentialSchema.parse(await input(c));
      const current = await c.env.DB.prepare(
        "SELECT id FROM git_credentials WHERE repo_id=? LIMIT 1",
      )
        .bind(repo.id)
        .first<{ id: string }>();
      if (method === "POST" && current)
        fail(409, "Credential already exists; use PUT");
      if (method === "PUT" && !current) fail(404, "Credential not found");
      const id = current?.id || crypto.randomUUID(),
        encrypted = await seal(c.env, "git:" + repo.id + ":" + id, b);
      if (current)
        await c.env.DB.prepare(
          "UPDATE git_credentials SET encrypted=?,updated_at=datetime('now') WHERE id=?",
        )
          .bind(encrypted, id)
          .run();
      else
        await c.env.DB.prepare(
          "INSERT INTO git_credentials(id,repo_id,encrypted) VALUES(?,?,?)",
        )
          .bind(id, repo.id, encrypted)
          .run();
      await h.audit(c, "repo.credential.update", repo.id);
      return c.json({ id }, method === "POST" ? 201 : 200);
    });
  app.delete("/api/repos/:namespace/:repo/git-credentials/:id", async (c) => {
    const repo = await h.access(c, "maintain");
    await c.env.DB.prepare(
      "DELETE FROM git_credentials WHERE repo_id=? AND id=?",
    )
      .bind(repo.id, c.req.param("id"))
      .run();
    await h.audit(c, "repo.credential.delete", repo.id);
    return c.json({ deleted: true });
  });
  const session = (c: Context<App>) => {
    if (c.get("kind") !== "session") fail(403, "Browser session required");
    return c.get("user")!;
  };
  app.get("/api/integrations/github", async (c) => {
    const u = session(c),
      row = await c.env.DB.prepare(
        "SELECT user_id FROM github_integrations WHERE user_id=?",
      )
        .bind(u.id)
        .first();
    if (!row) return c.json({ configured: false });
    const config = await githubConfig(c.env, u.id);
    return c.json({
      configured: true,
      app_id: config.app_id,
      installation_id: config.installation_id,
      webhook_url: c.env.APP_ORIGIN + "/webhooks/github/" + u.username,
    });
  });
  app.put("/api/integrations/github", async (c) => {
    const u = session(c),
      b = githubSchema.parse(await input(c));
    await githubPrivateKey(b.private_key);
    const encrypted = await seal(c.env, "github:" + u.id, b);
    await c.env.DB.prepare(
      "INSERT INTO github_integrations(user_id,encrypted) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET encrypted=excluded.encrypted",
    )
      .bind(u.id, encrypted)
      .run();
    return c.json({
      configured: true,
      webhook_url: c.env.APP_ORIGIN + "/webhooks/github/" + u.username,
    });
  });
  app.delete("/api/integrations/github", async (c) => {
    const u = session(c);
    await c.env.DB.prepare("DELETE FROM github_integrations WHERE user_id=?")
      .bind(u.id)
      .run();
    return c.json({ deleted: true });
  });
  app.post("/webhooks/github/:username", async (c) => {
    const user = await c.env.DB.prepare("SELECT id FROM users WHERE username=?")
      .bind(c.req.param("username"))
      .first<{ id: string }>();
    if (!user) fail(404, "Integration not found");
    const config = await githubConfig(c.env, user.id);
    const raw = await boundedBody(c.req.raw, 2 * 1024 * 1024);
    if (
      !(await verifyGitHubWebhook(
        raw,
        c.req.header("x-hub-signature-256") || "",
        config.webhook_secret,
      ))
    )
      fail(401, "Invalid GitHub webhook signature");
    const delivery = c.req.header("x-github-delivery") || "";
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(delivery))
      fail(400, "Invalid delivery ID");
    const body = JSON.parse(new TextDecoder().decode(raw));
    if (String(body.installation?.id) !== config.installation_id)
      fail(403, "Installation mismatch");
    if (
      !["push", "create", "delete", "installation_repositories"].includes(
        c.req.header("x-github-event") || "",
      )
    )
      return c.json({ ignored: true });
    // Insert jobs and dedup marker in one D1 transaction, so a crash cannot lose a received event.
    const repos = await c.env.DB.prepare(
      "SELECT * FROM repositories WHERE owner_id=? AND base_repo IS NOT NULL AND deleted_at IS NULL",
    )
      .bind(user.id)
      .all<Repo>();
    const key = user.id + ":" + delivery;
    const statements = [];
    for (const repo of repos.results) {
      const base = JSON.parse(repo.base_repo!);
      if (
        base.provider !== "github" ||
        base.mode === "public" ||
        `${base.owner}/${base.name}`.toLowerCase() !==
          String(body.repository?.full_name).toLowerCase()
      )
        continue;
      statements.push(
        c.env.DB.prepare(
          "INSERT INTO sync_jobs(id,repo_id,direction,lease_until) SELECT ?,?,'pull',0 WHERE NOT EXISTS(SELECT 1 FROM incoming_webhooks WHERE id=?)",
        ).bind(crypto.randomUUID(), repo.id, key),
      );
    }
    statements.push(
      c.env.DB.prepare(
        "INSERT OR IGNORE INTO incoming_webhooks(id,received_at) VALUES(?,?)",
      ).bind(key, Date.now()),
    );
    await c.env.DB.batch(statements);
    c.executionCtx.waitUntil(publishSyncJobs(c.env));
    return c.json({ accepted: true }, 202);
  });
}
