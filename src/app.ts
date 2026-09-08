import { base64, unbase64 } from "./git/signatures";
import { registerMCP } from "./mcp";
import { githubLFS } from "./lfs-sync";
import { registerSyncRoutes } from "./sync-routes";
import { upstreamSchema, upstreamURL } from "./sync-config";
import { scheduleSync } from "./sync";
import { registerForgeRoutes } from "./forge-routes";
import { verifyDelegation, requireScope } from "./delegation";
import { registerIdentityRoutes } from "./identity-routes";
import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { z, ZodError } from "zod";
import type { App, Repo, User } from "./types";
import { publishPending, webhookURL } from "./webhooks";
import {
  slug,
  repoName,
  branch,
  sha,
  fail,
  digest,
  randomToken,
  passwordHash,
  verifyPassword,
  equal,
  boundedBody,
} from "./security";
const app = new Hono<App>();
const userInput = z.object({
  username: slug,
  password: z.string().min(12).max(128),
});
const issueInput = z.object({
  title: z.string().trim().min(1).max(240),
  body: z.string().max(20000).default(""),
});
async function input<T>(c: Context<App>, schema: z.ZodType<T>): Promise<T> {
  const b = await boundedBody(c.req.raw, 2 * 1024 * 1024);
  let data;
  try {
    data = JSON.parse(new TextDecoder().decode(b));
  } catch {
    fail(400, "Invalid JSON");
  }
  return schema.parse(data);
}
const requireUser = (c: Context<App>) =>
  c.get("user") || fail(401, "Sign in required");
const requireAdmin = (c: Context<App>) => {
  const u = requireUser(c);
  if (!u.admin) fail(403, "Administrator required");
  return u;
};
async function audit(
  c: Context<App>,
  action: string,
  repoId: string | null = null,
  detail = "",
) {
  const statements = [
    c.env.DB.prepare(
      "INSERT INTO audit(repo_id,actor_id,action,detail) VALUES(?,?,?,?)",
    ).bind(repoId, c.get("user")?.id || null, action, detail),
  ];
  if (repoId && !action.startsWith("git.")) {
    const hooks = await c.env.DB.prepare(
      "SELECT id,events FROM webhooks WHERE repo_id=? LIMIT 10",
    )
      .bind(repoId)
      .all<{ id: string; events: string }>();
    for (const hook of hooks.results) {
      const selected = JSON.parse(hook.events);
      if (!selected.includes("*") && !selected.includes(action)) continue;
      const id = crypto.randomUUID();
      const payload = JSON.stringify({
        id,
        event: action,
        repository_id: repoId,
        actor: c.get("user")?.username || null,
        detail,
        timestamp: new Date().toISOString(),
      });
      statements.push(
        c.env.DB.prepare(
          "INSERT INTO deliveries(id,webhook_id,payload) VALUES(?,?,?)",
        ).bind(id, hook.id, payload),
      );
    }
  }
  await c.env.DB.batch(statements);
  if (c.env.EVENTS) c.executionCtx.waitUntil(publishPending(c.env));
}
async function repoAccess(
  c: Context<App>,
  level: "read" | "write" | "maintain" = "read",
): Promise<Repo> {
  const namespace = c.req.param("namespace"),
    name = c.req.param("repo");
  const r = await c.env.DB.prepare(
    "SELECT * FROM repositories WHERE namespace=? AND name=? AND deleted_at IS NULL",
  )
    .bind(namespace, name)
    .first<Repo>();
  if (!r) fail(404, "Repository not found");
  const delegated = c.get("delegation");
  if (delegated) {
    const operation = c.req.path.split("/").slice(5).join("/");
    if (
      /^(members|issues|merges|audit|webhooks|deliveries)(\/|$)/.test(operation)
    )
      fail(403, "Delegated Git tokens cannot manage collaboration");
    requireScope(
      delegated,
      level === "read"
        ? "git:read"
        : level === "maintain"
          ? "repo:write"
          : "git:write",
      `${r.namespace}/${r.name}`,
    );
  }
  const user = c.get("user");
  const owner = user?.id === r.owner_id;
  const member = user
    ? await c.env.DB.prepare(
        "SELECT role FROM members WHERE repo_id=? AND user_id=?",
      )
        .bind(r.id, user.id)
        .first<{ role: string }>()
    : null;
  if (level === "read" && (r.visibility === "public" || owner || member))
    return r;
  if (!user) fail(401, "Authentication required");
  if (level === "read") fail(404, "Repository not found");
  if (c.get("scope") === "read") fail(403, "Read-only token");
  if (
    owner ||
    member?.role === "maintainer" ||
    (level === "write" && member?.role === "developer")
  )
    return r;
  fail(403, "Insufficient repository permissions");
}
async function engine(
  c: Context<App>,
  repo: Repo,
  path: string,
  options: {
    method?: string;
    body?: BodyInit | null;
    headers?: HeadersInit;
    mutation?: boolean;
    namespace?: "ephemeral" | "import";
  } = {},
) {
  const headers = new Headers(options.headers);
  headers.delete("x-write-policy");
  headers.delete("x-namespace");
  headers.set("x-repo-id", repo.id);
  headers.set("x-default-branch", repo.default_branch);
  headers.set("x-repo-owner-id", repo.owner_id);
  headers.set(
    "x-actor",
    c.get("delegation")?.subject || c.get("user")?.username || "",
  );
  const delegation = c.get("delegation");
  if (delegation)
    headers.set(
      "x-write-policy",
      JSON.stringify({ rules: delegation.refs, allowForce: true }),
    );
  if (options.namespace) headers.set("x-namespace", options.namespace);
  else if (c.req.query("ephemeral") === "true")
    headers.set("x-namespace", "ephemeral");
  if (options.mutation) headers.set("x-mutation", "1");
  const ns = c.env.REPOSITORIES;
  return ns.get(ns.idFromName(repo.id)).fetch(
    new Request(`http://repository${path}`, {
      method: options.method || "GET",
      headers,
      body: options.body,
    }),
  );
}
async function engineJSON(
  c: Context<App>,
  r: Repo,
  path: string,
  payload?: unknown,
) {
  const response = await engine(
    c,
    r,
    path,
    payload === undefined
      ? {}
      : {
          method: "POST",
          body: JSON.stringify(payload),
          headers: { "content-type": "application/json" },
          mutation: true,
        },
  );
  const data = (await response.json()) as any;
  if (!response.ok)
    throw new HTTPException(response.status as 400, {
      message: data.error || "Git operation failed",
    });
  return data;
}
app.onError((err, c) => {
  if (err instanceof ZodError)
    return c.json(
      {
        error: "Invalid input",
        details: err.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      400,
    );
  if (err instanceof HTTPException) {
    if (err.status === 401)
      c.header("WWW-Authenticate", 'Basic realm="OneStorage", charset="UTF-8"');
    return c.json({ error: err.message }, err.status);
  }
  console.error("Request failed", err instanceof Error ? err.name : "unknown");
  return c.json(
    { error: "Internal error; retry or contact the administrator" },
    500,
  );
});
app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "same-origin");
  c.header("X-Frame-Options", "DENY");
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  c.header("Cache-Control", "no-store");
});
app.use("*", async (c, next) => {
  const origin = c.req.header("origin");
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
  if (mutating && origin && origin !== c.env.APP_ORIGIN)
    fail(403, "Cross-origin request rejected");
  c.set("user", null);
  c.set("scope", "read");
  c.set("kind", null);
  c.set("credential", null);
  const authorization = c.req.header("authorization");
  let token: string | undefined;
  if (authorization?.startsWith("Bearer ")) token = authorization.slice(7);
  else if (authorization?.startsWith("Basic ")) {
    try {
      const basic = atob(authorization.slice(6));
      token = basic.slice(basic.indexOf(":") + 1);
    } catch {
      fail(401, "Invalid credentials");
    }
  } else if (authorization) fail(401, "Unsupported authorization");
  const cookie = !authorization
    ? getCookie(c, "onestorage_session")
    : undefined;
  token ||= cookie;
  if (token?.split(".").length === 3 && authorization) {
    const delegation = await verifyDelegation(c.env, token);
    c.set("delegation", delegation);
    c.set("user", delegation.user);
    c.set(
      "scope",
      delegation.scopes.some((s) => s === "git:write" || s === "repo:write")
        ? "write"
        : "read",
    );
    c.set("kind", "jwt");
  } else if (token) {
    const hash = await digest(token);
    const row = await c.env.DB.prepare(
      "SELECT u.id,u.username,u.admin,c.scope,c.kind FROM credentials c JOIN users u ON u.id=c.user_id WHERE c.hash=? AND c.expires_at>?",
    )
      .bind(hash, Date.now())
      .first<User & { scope: "read" | "write"; kind: "pat" | "session" }>();
    if (row && (cookie ? row.kind === "session" : row.kind === "pat")) {
      c.set("user", { id: row.id, username: row.username, admin: row.admin });
      c.set("scope", row.scope);
      c.set("kind", row.kind);
      c.set("credential", hash);
    } else if (authorization) fail(401, "Invalid or expired access token");
  }
  if (mutating && c.get("kind") === "session" && origin !== c.env.APP_ORIGIN)
    fail(403, "Session requests require a matching Origin header");
  if (
    mutating &&
    c.req.path.startsWith("/api/") &&
    c.get("user") &&
    c.get("scope") === "read" &&
    !(
      c.req.method === "POST" &&
      /^\/api\/repos\/[^/]+\/[^/]+\/(grep|archive)$/.test(c.req.path)
    )
  )
    fail(403, "Read-only access token");
  await next();
});
registerIdentityRoutes(app);
registerMCP(app);
app.get("/api/health", (c) =>
  c.json({ name: "OneStorage", version: "0.3.0", status: "ok" }),
);
app.get("/api/setup", async (c) =>
  c.json({
    required: !(await c.env.DB.prepare(
      "SELECT value FROM settings WHERE key='initialized'",
    ).first()),
  }),
);
app.post("/api/setup", async (c) => {
  const b = await input(
    c,
    userInput.extend({ secret: z.string().min(1).max(256) }),
  );
  if (
    !c.env.BOOTSTRAP_SECRET ||
    !equal(await digest(b.secret), await digest(c.env.BOOTSTRAP_SECRET))
  )
    fail(403, "Invalid setup secret");
  if (
    await c.env.DB.prepare(
      "SELECT value FROM settings WHERE key='initialized'",
    ).first()
  )
    fail(409, "Setup already completed");
  const id = crypto.randomUUID(),
    password = await passwordHash(b.password);
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO settings(key,value) VALUES('initialized','1')",
      ),
      c.env.DB.prepare(
        "INSERT INTO users(id,username,password,admin) VALUES(?,?,?,1)",
      ).bind(id, b.username, password),
    ]);
  } catch {
    fail(409, "Setup already completed or username unavailable");
  }
  return c.json({ id, username: b.username }, 201);
});
app.post("/api/login", async (c) => {
  const b = await input(
    c,
    z.object({
      username: z.string().min(1).max(48),
      password: z.string().max(128),
    }),
  );
  const now = Date.now(),
    bucket = Math.floor(now / 600000),
    key = await digest(
      `${c.req.header("cf-connecting-ip") || "local"}:${bucket}`,
    );
  const limit = await c.env.DB.prepare(
    "INSERT INTO login_limits(key,attempts,reset_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=attempts+1 RETURNING attempts",
  )
    .bind(key, now + 600000)
    .first<{ attempts: number }>();
  if ((limit?.attempts || 0) > 20)
    fail(429, "Too many sign-in attempts; retry in ten minutes");
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE username=?")
    .bind(b.username.toLowerCase())
    .first<User & { password: string }>();
  const valid = await verifyPassword(
    b.password,
    user?.password ||
      "pbkdf2:100000:00000000000000000000000000000000:0000000000000000000000000000000000000000000000000000000000000000",
  );
  if (!user || !valid) fail(401, "Invalid username or password");
  const token = randomToken(),
    hash = await digest(token);
  await c.env.DB.prepare(
    "INSERT INTO credentials(hash,id,user_id,name,kind,expires_at) VALUES(?,?,?,'Browser session','session',?)",
  )
    .bind(hash, crypto.randomUUID(), user.id, now + 7 * 86400000)
    .run();
  setCookie(c, "onestorage_session", token, {
    httpOnly: true,
    secure: c.env.APP_ORIGIN.startsWith("https:"),
    sameSite: "Strict",
    path: "/",
    maxAge: 7 * 86400,
  });
  c.executionCtx.waitUntil(
    c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM login_limits WHERE reset_at<?").bind(now),
      c.env.DB.prepare("DELETE FROM credentials WHERE expires_at<?").bind(now),
    ]),
  );
  return c.json({ id: user.id, username: user.username, admin: user.admin });
});
app.post("/api/logout", async (c) => {
  if (c.get("kind") === "session")
    await c.env.DB.prepare("DELETE FROM credentials WHERE hash=?")
      .bind(c.get("credential"))
      .run();
  deleteCookie(c, "onestorage_session", { path: "/" });
  return c.json({ ok: true });
});
app.post("/api/password", async (c) => {
  const u = requireUser(c);
  if (c.get("kind") !== "session")
    fail(403, "Use a browser session to change your password");
  const b = await input(
    c,
    z.object({
      current_password: z.string().max(128),
      new_password: z.string().min(12).max(128),
    }),
  );
  const stored = await c.env.DB.prepare("SELECT password FROM users WHERE id=?")
    .bind(u.id)
    .first<{ password: string }>();
  if (!stored || !(await verifyPassword(b.current_password, stored.password)))
    fail(403, "Current password is incorrect");
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET password=? WHERE id=?").bind(
      await passwordHash(b.new_password),
      u.id,
    ),
    c.env.DB.prepare("DELETE FROM credentials WHERE user_id=?").bind(u.id),
  ]);
  deleteCookie(c, "onestorage_session", { path: "/" });
  return c.json({ ok: true });
});
app.get("/api/me", (c) => c.json({ user: c.get("user") }));
app.post("/api/users", async (c) => {
  requireAdmin(c);
  const b = await input(c, userInput);
  const id = crypto.randomUUID(),
    hash = await passwordHash(b.password);
  try {
    await c.env.DB.prepare(
      "INSERT INTO users(id,username,password) VALUES(?,?,?)",
    )
      .bind(id, b.username, hash)
      .run();
  } catch {
    fail(409, "Username already exists");
  }
  await audit(c, "user.create", null, b.username);
  return c.json({ id, username: b.username }, 201);
});
app.get("/api/tokens", async (c) => {
  const u = requireUser(c);
  return c.json({
    tokens: (
      await c.env.DB.prepare(
        "SELECT id,name,scope,expires_at,created_at FROM credentials WHERE user_id=? AND kind='pat' ORDER BY created_at DESC",
      )
        .bind(u.id)
        .all()
    ).results,
  });
});
app.post("/api/tokens", async (c) => {
  const u = requireUser(c);
  if (c.get("kind") !== "session")
    fail(403, "Use a browser session to create access tokens");
  const b = await input(
    c,
    z.object({
      name: z.string().trim().min(1).max(80),
      scope: z.enum(["read", "write"]).default("write"),
      days: z.number().int().min(1).max(365).default(90),
    }),
  );
  const token = randomToken(),
    id = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO credentials(hash,id,user_id,name,kind,scope,expires_at) VALUES(?,?,?,?,'pat',?,?)",
  )
    .bind(
      await digest(token),
      id,
      u.id,
      b.name,
      b.scope,
      Date.now() + b.days * 86400000,
    )
    .run();
  await audit(c, "token.create", null, b.name);
  return c.json({ id, token }, 201);
});
app.delete("/api/tokens/:id", async (c) => {
  const u = requireUser(c);
  await c.env.DB.prepare(
    "DELETE FROM credentials WHERE id=? AND user_id=? AND kind='pat'",
  )
    .bind(c.req.param("id"), u.id)
    .run();
  return c.json({ ok: true });
});
app.get("/api/repos", async (c) => {
  const delegation = c.get("delegation");
  requireScope(delegation, "org:read");
  const u = c.get("user");
  const search = (c.req.query("q") || "").slice(0, 100),
    limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .parse(c.req.query("limit") || 50);
  let offset =
    z.coerce
      .number()
      .int()
      .min(0)
      .max(10000)
      .parse(c.req.query("page") || 0) * limit;
  if (c.req.query("cursor")) {
    try {
      const cursor = JSON.parse(
        new TextDecoder().decode(unbase64(c.req.query("cursor")!)),
      );
      if (
        cursor.q !== search ||
        cursor.user !== (u?.id || "") ||
        !Number.isSafeInteger(cursor.offset) ||
        cursor.offset < 0 ||
        cursor.offset > 1000000
      )
        throw Error();
      offset = cursor.offset;
    } catch {
      fail(400, "Invalid repository cursor");
    }
  }
  const query = `SELECT DISTINCT r.* FROM repositories r LEFT JOIN members m ON m.repo_id=r.id AND m.user_id=? WHERE r.deleted_at IS NULL AND ${delegation ? "r.owner_id=?" : "(r.visibility='public' OR r.owner_id=? OR m.user_id IS NOT NULL)"} AND (r.name LIKE ? ESCAPE '\\' OR r.description LIKE ? ESCAPE '\\') ORDER BY r.created_at DESC,r.id LIMIT ? OFFSET ?`;
  const pattern = "%" + search.replace(/[\\%_]/g, "\\$&") + "%";
  const result = await c.env.DB.prepare(query)
    .bind(u?.id || "", u?.id || "", pattern, pattern, limit + 1, offset)
    .all();
  const has_more = result.results.length > limit;
  return c.json({
    repositories: result.results.slice(0, limit),
    page: Math.floor(offset / limit),
    has_more,
    next_cursor: has_more
      ? base64(
          new TextEncoder().encode(
            JSON.stringify({
              q: search,
              user: u?.id || "",
              offset: offset + limit,
            }),
          ),
        )
      : null,
  });
});
app.post("/api/repos", async (c) => {
  const u = requireUser(c);
  const b = await input(
    c,
    z.object({
      name: repoName.optional(),
      id: repoName.optional(),
      base_repo: z
        .union([
          z.object({
            id: z.string().min(1).max(150),
            ref: z.string().max(300).optional(),
            sha: sha.optional(),
          }),
          upstreamSchema,
        ])
        .optional(),
      description: z.string().max(1000).default(""),
      visibility: z.enum(["public", "private"]).default("private"),
      default_branch: branch.optional(),
    }),
  );
  const id = crypto.randomUUID();
  b.name = b.name || b.id || id;
  requireScope(c.get("delegation"), "repo:write", `${u.username}/${b.name}`);
  let source: Repo | null = null;
  if (b.base_repo && "id" in b.base_repo) {
    const key = b.base_repo.id;
    source = await c.env.DB.prepare(
      "SELECT * FROM repositories WHERE owner_id=? AND deleted_at IS NULL AND (id=? OR name=? OR namespace||'/'||name=?)",
    )
      .bind(u.id, key, key, key)
      .first<Repo>();
    if (!source) fail(404, "Fork source not found in your namespace");
    requireScope(c.get("delegation"), "git:read");
    if (source.sync_status === "initializing")
      fail(409, "Source is initializing");
  }
  const upstream =
    b.base_repo && "provider" in b.base_repo ? b.base_repo : null;
  if (upstream) {
    upstreamURL(upstream, c.env.SYNC_ALLOWED_HOSTS);
    upstream.mode =
      upstream.provider === "github"
        ? upstream.mode === "public"
          ? "public"
          : "app"
        : "generic";
  }
  b.default_branch =
    b.default_branch ||
    source?.default_branch ||
    upstream?.default_branch ||
    "main";
  try {
    await c.env.DB.prepare(
      "INSERT INTO repositories(id,owner_id,namespace,name,description,visibility,default_branch,fork_source,sync_status,base_repo) VALUES(?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        id,
        u.id,
        u.username,
        b.name,
        b.description,
        b.visibility,
        b.default_branch,
        source?.id || null,
        source ? "initializing" : "idle",
        upstream ? JSON.stringify(upstream) : null,
      )
      .run();
  } catch {
    fail(409, "Repository name already exists");
  }
  if (source) {
    const target = {
      id,
      owner_id: u.id,
      namespace: u.username,
      name: b.name,
      description: b.description,
      visibility: b.visibility,
      default_branch: b.default_branch,
      created_at: new Date().toISOString(),
    } as Repo;
    try {
      await engineJSON(c, target, "/internal/fork-initialize", {
        source: source.id,
        ref: (b.base_repo as any).sha || (b.base_repo as any).ref,
        default_branch: b.default_branch,
      });
    } catch (e) {
      await engine(c, target, "/internal/delete", { method: "POST" });
      throw e;
    }
  }
  if (upstream?.provider === "github")
    await scheduleSync(c.env, {
      id,
      base_repo: JSON.stringify(upstream),
    } as Repo);
  await audit(c, "repo.create", id, b.name);
  return c.json(
    {
      id,
      namespace: u.username,
      ...b,
      clone_url: `${c.env.APP_ORIGIN}/${u.username}/${encodeURIComponent(b.name)}.git`,
    },
    201,
  );
});
app.get("/api/repos/:namespace/:repo", async (c) => {
  const r = await repoAccess(c);
  const user = c.get("user");
  const member = user
    ? await c.env.DB.prepare(
        "SELECT role FROM members WHERE repo_id=? AND user_id=?",
      )
        .bind(r.id, user.id)
        .first<{ role: string }>()
    : null;
  return c.json({
    ...r,
    role: user?.id === r.owner_id ? "owner" : member?.role || "guest",
    clone_url: `${c.env.APP_ORIGIN}/${r.namespace}/${encodeURIComponent(r.name)}.git`,
  });
});
app.patch("/api/repos/:namespace/:repo", async (c) => {
  const r = await repoAccess(c, "maintain");
  const b = await input(
    c,
    z.object({
      description: z.string().max(1000).optional(),
      visibility: z.enum(["public", "private"]).optional(),
      default_branch: branch.optional(),
    }),
  );
  if (b.default_branch)
    await engineJSON(c, r, "/internal/default-branch", {
      default_branch: b.default_branch,
    });
  await c.env.DB.prepare(
    "UPDATE repositories SET description=?,visibility=? WHERE id=?",
  )
    .bind(b.description ?? r.description, b.visibility ?? r.visibility, r.id)
    .run();
  await audit(c, "repo.update", r.id, b.visibility);
  return c.json({ ok: true });
});
app.delete("/api/repos/:namespace/:repo", async (c) => {
  const r = await repoAccess(c, "maintain");
  return engine(c, r, "/internal/delete", { method: "POST" });
});
app.get("/api/repo-url/:id", async (c) => {
  const r = await c.env.DB.prepare(
    "SELECT * FROM repositories WHERE id=? AND deleted_at IS NULL",
  )
    .bind(c.req.param("id"))
    .first<Repo>();
  if (!r) fail(404, "Repository not found");
  requireScope(c.get("delegation"), "git:read", r.namespace + "/" + r.name);
  const user = c.get("user");
  const member = user
    ? await c.env.DB.prepare(
        "SELECT role FROM members WHERE repo_id=? AND user_id=?",
      )
        .bind(r.id, user.id)
        .first()
    : null;
  if (r.visibility !== "public" && r.owner_id !== user?.id && !member)
    fail(404, "Repository not found");
  return c.json({
    id: r.id,
    namespace: r.namespace,
    name: r.name,
    url: `${c.env.APP_ORIGIN}/${r.namespace}/${encodeURIComponent(r.name)}.git`,
    ephemeral_url: `${c.env.APP_ORIGIN}/${r.namespace}/${encodeURIComponent(r.name)}+ephemeral.git`,
    import_url: `${c.env.APP_ORIGIN}/${r.namespace}/${encodeURIComponent(r.name)}+import.git`,
  });
});
registerForgeRoutes(app, { access: repoAccess, engine, audit });
registerSyncRoutes(app, { access: repoAccess, engine, audit });
for (const operation of [
  "branches",
  "tree",
  "blob",
  "commits",
  "compare",
  "search",
])
  app.get(`/api/repos/:namespace/:repo/${operation}`, async (c) => {
    const r = await repoAccess(c);
    return engine(c, r, `/${operation}${new URL(c.req.url).search}`);
  });
app.post("/api/repos/:namespace/:repo/commit", async (c) => {
  const r = await repoAccess(c, "write"),
    u = requireUser(c);
  const b = await input(
    c,
    z.object({
      branch: branch,
      expected_sha: sha.nullable(),
      message: z.string().min(1).max(1000),
      files: z
        .array(
          z.object({
            path: z.string().min(1).max(1000),
            content: z
              .string()
              .max(1024 * 1024)
              .nullable(),
          }),
        )
        .min(1)
        .max(30),
    }),
  );
  const result = await engineJSON(c, r, "/commit", {
    ...b,
    author: u.username,
    email: `${u.username}@users.1s.hk`,
  });
  await audit(c, "repo.commit", r.id, result.sha);
  return c.json(result, 201);
});
app.get("/api/repos/:namespace/:repo/members", async (c) => {
  const r = await repoAccess(c);
  return c.json({
    members: (
      await c.env.DB.prepare(
        "SELECT u.username,m.role FROM members m JOIN users u ON u.id=m.user_id WHERE repo_id=? ORDER BY u.username",
      )
        .bind(r.id)
        .all()
    ).results,
  });
});
app.put("/api/repos/:namespace/:repo/members", async (c) => {
  const r = await repoAccess(c, "maintain");
  const b = await input(
    c,
    z.object({
      username: slug,
      role: z.enum(["reader", "developer", "maintainer"]),
    }),
  );
  const u = await c.env.DB.prepare("SELECT id FROM users WHERE username=?")
    .bind(b.username)
    .first<{ id: string }>();
  if (!u) fail(404, "User not found");
  if (u.id === r.owner_id) fail(400, "Owner permissions are fixed");
  await c.env.DB.prepare(
    "INSERT INTO members(repo_id,user_id,role) VALUES(?,?,?) ON CONFLICT(repo_id,user_id) DO UPDATE SET role=excluded.role",
  )
    .bind(r.id, u.id, b.role)
    .run();
  await audit(c, "member.update", r.id, `${b.username}:${b.role}`);
  return c.json({ ok: true });
});
app.delete("/api/repos/:namespace/:repo/members/:username", async (c) => {
  const r = await repoAccess(c, "maintain");
  await c.env.DB.prepare(
    "DELETE FROM members WHERE repo_id=? AND user_id=(SELECT id FROM users WHERE username=?)",
  )
    .bind(r.id, c.req.param("username"))
    .run();
  await audit(c, "member.remove", r.id, c.req.param("username"));
  return c.json({ ok: true });
});
app.get("/api/repos/:namespace/:repo/issues", async (c) => {
  const r = await repoAccess(c);
  return c.json({
    issues: (
      await c.env.DB.prepare(
        "SELECT i.*,u.username AS author FROM issues i JOIN users u ON u.id=i.author_id WHERE repo_id=? ORDER BY i.id DESC LIMIT 100",
      )
        .bind(r.id)
        .all()
    ).results,
  });
});
app.post("/api/repos/:namespace/:repo/issues", async (c) => {
  const r = await repoAccess(c),
    u = requireUser(c),
    b = await input(c, issueInput);
  const result = await c.env.DB.prepare(
    "INSERT INTO issues(repo_id,author_id,title,body) VALUES(?,?,?,?) RETURNING *",
  )
    .bind(r.id, u.id, b.title, b.body)
    .first();
  await audit(c, "issue.create", r.id, b.title);
  return c.json(result, 201);
});
app.get("/api/repos/:namespace/:repo/issues/:id", async (c) => {
  const r = await repoAccess(c);
  const issue = await c.env.DB.prepare(
    "SELECT i.*,u.username AS author FROM issues i JOIN users u ON u.id=i.author_id WHERE i.id=? AND repo_id=?",
  )
    .bind(c.req.param("id"), r.id)
    .first();
  if (!issue) fail(404, "Issue not found");
  const comments = await c.env.DB.prepare(
    "SELECT c.*,u.username AS author FROM comments c JOIN users u ON u.id=c.author_id WHERE issue_id=? ORDER BY c.id LIMIT 200",
  )
    .bind(c.req.param("id"))
    .all();
  return c.json({ ...issue, comments: comments.results });
});
app.patch("/api/repos/:namespace/:repo/issues/:id", async (c) => {
  const r = await repoAccess(c),
    u = requireUser(c),
    b = await input(c, z.object({ state: z.enum(["open", "closed"]) }));
  const issue = await c.env.DB.prepare(
    "SELECT author_id FROM issues WHERE id=? AND repo_id=?",
  )
    .bind(c.req.param("id"), r.id)
    .first<{ author_id: string }>();
  if (!issue) fail(404, "Issue not found");
  if (issue.author_id !== u.id) await repoAccess(c, "maintain");
  await c.env.DB.prepare("UPDATE issues SET state=? WHERE id=? AND repo_id=?")
    .bind(b.state, c.req.param("id"), r.id)
    .run();
  await audit(c, "issue." + b.state, r.id, c.req.param("id"));
  return c.json({ ok: true });
});
app.post("/api/repos/:namespace/:repo/issues/:id/comments", async (c) => {
  const r = await repoAccess(c),
    u = requireUser(c),
    b = await input(c, z.object({ body: z.string().trim().min(1).max(20000) }));
  if (
    !(await c.env.DB.prepare("SELECT id FROM issues WHERE id=? AND repo_id=?")
      .bind(c.req.param("id"), r.id)
      .first())
  )
    fail(404, "Issue not found");
  const comment = await c.env.DB.prepare(
    "INSERT INTO comments(issue_id,author_id,body) VALUES(?,?,?) RETURNING *",
  )
    .bind(c.req.param("id"), u.id, b.body)
    .first();
  return c.json(comment, 201);
});
app.get("/api/repos/:namespace/:repo/merges", async (c) => {
  const r = await repoAccess(c);
  return c.json({
    merges: (
      await c.env.DB.prepare(
        "SELECT m.*,u.username AS author FROM merge_requests m JOIN users u ON u.id=m.author_id WHERE repo_id=? ORDER BY m.id DESC LIMIT 100",
      )
        .bind(r.id)
        .all()
    ).results,
  });
});
app.post("/api/repos/:namespace/:repo/merges", async (c) => {
  const r = await repoAccess(c, "write"),
    u = requireUser(c),
    b = await input(c, issueInput.extend({ source: branch, target: branch }));
  if (b.source === b.target) fail(400, "Select different branches");
  const comparison = await engineJSON(
    c,
    r,
    `/compare?source=${encodeURIComponent("refs/heads/" + b.source)}&target=${encodeURIComponent("refs/heads/" + b.target)}`,
  );
  const result = await c.env.DB.prepare(
    "INSERT INTO merge_requests(repo_id,author_id,title,body,source,target,source_sha,target_sha) VALUES(?,?,?,?,?,?,?,?) RETURNING *",
  )
    .bind(
      r.id,
      u.id,
      b.title,
      b.body,
      b.source,
      b.target,
      comparison.source_sha,
      comparison.target_sha,
    )
    .first();
  await audit(c, "merge_request.create", r.id, b.title);
  return c.json(result, 201);
});
app.get("/api/repos/:namespace/:repo/merges/:id", async (c) => {
  const r = await repoAccess(c);
  const mr = await c.env.DB.prepare(
    "SELECT m.*,u.username AS author FROM merge_requests m JOIN users u ON u.id=m.author_id WHERE m.id=? AND repo_id=?",
  )
    .bind(c.req.param("id"), r.id)
    .first<any>();
  if (!mr) fail(404, "Merge request not found");
  const comparison = await engineJSON(
    c,
    r,
    `/compare?source=${mr.source_sha}&target=${mr.target_sha}`,
  );
  return c.json({ ...mr, diff: comparison.diff });
});
app.post("/api/repos/:namespace/:repo/merges/:id/merge", async (c) => {
  const r = await repoAccess(c, "maintain");
  const mr = await c.env.DB.prepare(
    "SELECT * FROM merge_requests WHERE id=? AND repo_id=?",
  )
    .bind(c.req.param("id"), r.id)
    .first<any>();
  if (!mr) fail(404, "Merge request not found");
  if (mr.state === "merged") return c.json({ sha: mr.merged_sha });
  if (mr.state !== "open") fail(409, "Merge request is closed");
  const result = await engineJSON(c, r, "/merge", mr);
  await c.env.DB.prepare(
    "UPDATE merge_requests SET state='merged',merged_sha=? WHERE id=? AND repo_id=?",
  )
    .bind(result.sha, mr.id, r.id)
    .run();
  await audit(c, "merge_request.merge", r.id, String(mr.id));
  return c.json(result);
});
app.get("/api/repos/:namespace/:repo/audit", async (c) => {
  const r = await repoAccess(c, "maintain");
  return c.json({
    events: (
      await c.env.DB.prepare(
        "SELECT a.*,u.username AS actor FROM audit a LEFT JOIN users u ON u.id=a.actor_id WHERE repo_id=? ORDER BY a.id DESC LIMIT 100",
      )
        .bind(r.id)
        .all()
    ).results,
  });
});
app.get("/api/repos/:namespace/:repo/webhooks", async (c) => {
  const r = await repoAccess(c, "maintain");
  return c.json({
    webhooks: (
      await c.env.DB.prepare(
        "SELECT id,url,events,created_at FROM webhooks WHERE repo_id=? ORDER BY created_at",
      )
        .bind(r.id)
        .all()
    ).results,
  });
});
app.post("/api/repos/:namespace/:repo/webhooks", async (c) => {
  const r = await repoAccess(c, "maintain");
  const b = await input(
    c,
    z.object({
      url: z.string().url().max(2000),
      events: z
        .array(
          z.enum([
            "*",
            "push",
            "repo.sync.started",
            "repo.sync.succeeded",
            "repo.sync.failed",
            "repo.create",
            "repo.update",
          ]),
        )
        .min(1)
        .max(10)
        .default(["*"]),
    }),
  );
  let url;
  try {
    url = webhookURL(b.url, c.env.WEBHOOK_ALLOWED_HOSTS);
  } catch {
    fail(
      400,
      "Destination must be HTTPS on a WEBHOOK_ALLOWED_HOSTS hostname approved by the operator",
    );
  }
  const id = crypto.randomUUID(),
    secret = randomToken();
  const result = await c.env.DB.prepare(
    "INSERT INTO webhooks(id,repo_id,url,secret,events) SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM webhooks WHERE repo_id=?)<10",
  )
    .bind(id, r.id, url, secret, JSON.stringify(b.events), r.id)
    .run();
  if (!result.meta.changes) fail(409, "Maximum 10 webhooks per repository");
  return c.json({ id, url, secret }, 201);
});
app.delete("/api/repos/:namespace/:repo/webhooks/:id", async (c) => {
  const r = await repoAccess(c, "maintain");
  await c.env.DB.prepare("DELETE FROM webhooks WHERE id=? AND repo_id=?")
    .bind(c.req.param("id"), r.id)
    .run();
  return c.json({ ok: true });
});
app.get("/api/repos/:namespace/:repo/deliveries", async (c) => {
  const r = await repoAccess(c, "maintain");
  return c.json({
    deliveries: (
      await c.env.DB.prepare(
        "SELECT d.id,d.webhook_id,d.state,d.attempts,d.last_status,d.created_at FROM deliveries d JOIN webhooks w ON w.id=d.webhook_id WHERE w.repo_id=? ORDER BY d.created_at DESC LIMIT 100",
      )
        .bind(r.id)
        .all()
    ).results,
  });
});
// Canonical Git URLs include .git; only smart HTTP and the LFS protocol are exposed.
app.all("/:namespace/:git/*", async (c, next) => {
  const gitName = c.req.param("git");
  if (!gitName.endsWith(".git")) return next();
  let name = gitName.slice(0, -4);
  const gitNamespace = name.endsWith("+ephemeral")
    ? "ephemeral"
    : name.endsWith("+import")
      ? "import"
      : undefined;
  if (gitNamespace) name = name.slice(0, -gitNamespace.length - 1);
  repoName.parse(name);
  slug.parse(c.req.param("namespace"));
  // Hono route params are immutable: authorize through the same repository policy using an explicit lookup.
  const r = await c.env.DB.prepare(
    "SELECT * FROM repositories WHERE namespace=? AND name=? AND deleted_at IS NULL",
  )
    .bind(c.req.param("namespace"), name)
    .first<Repo>();
  if (!r) fail(404, "Repository not found");
  const suffix = new URL(c.req.url).pathname.split("/").slice(3).join("/"),
    u = c.get("user");
  if (gitNamespace === "import" && r.base_repo)
    fail(409, "Import remotes cannot be used with synced repositories");
  if (
    gitNamespace === "import" &&
    !(
      suffix === "git-receive-pack" ||
      c.req.query("service") === "git-receive-pack"
    )
  )
    fail(400, "Reads are disabled for +import remotes; use the normal remote");
  let writing =
    suffix === "git-receive-pack" ||
    c.req.query("service") === "git-receive-pack" ||
    c.req.method === "PUT";
  let batch: any;
  if (suffix === "info/lfs/objects/batch" && c.req.method === "POST") {
    batch = await input(
      c,
      z.object({
        operation: z.enum(["upload", "download"]),
        transfers: z.array(z.string()).optional(),
        objects: z
          .array(
            z.object({
              oid: z.string().regex(/^[0-9a-f]{64}$/),
              size: z
                .number()
                .int()
                .min(0)
                .max(16 * 1024 * 1024),
            }),
          )
          .max(100),
      }),
    );
    writing = batch.operation === "upload";
  }
  requireScope(
    c.get("delegation"),
    writing ? "git:write" : "git:read",
    `${r.namespace}/${r.name}`,
  );
  const member = u
    ? await c.env.DB.prepare(
        "SELECT role FROM members WHERE repo_id=? AND user_id=?",
      )
        .bind(r.id, u.id)
        .first<{ role: string }>()
    : null;
  const owner = u?.id === r.owner_id,
    read = r.visibility === "public" || owner || !!member,
    write =
      owner || member?.role === "developer" || member?.role === "maintainer";
  if (!read)
    fail(u ? 404 : 401, "Repository not found or authentication required");
  if (writing && (!write || c.get("scope") !== "write"))
    fail(u ? 403 : 401, "Write access required");
  if (suffix.startsWith("info/lfs/") && r.base_repo && !githubLFS(r))
    fail(409, "LFS is unavailable for generic or public GitHub sync");
  if (batch) {
    const objects = [];
    for (const object of batch.objects) {
      const exists = await c.env.OBJECTS.head(`lfs/${r.id}/${object.oid}`);
      const auth = c.req.header("authorization");
      const header = auth ? { Authorization: auth } : {};
      const href = `${c.env.APP_ORIGIN}/${r.namespace}/${encodeURIComponent(r.name)}${gitNamespace ? "+" + gitNamespace : ""}.git/info/lfs/objects/${object.oid}${githubLFS(r) ? "?size=" + object.size : ""}`;
      if (exists && exists.size !== object.size) {
        objects.push({
          ...object,
          error: { code: 422, message: "Size does not match stored object" },
        });
        continue;
      }
      objects.push({
        ...object,
        authenticated: !!u,
        ...(batch.operation === "download" && !exists && !githubLFS(r)
          ? { error: { code: 404, message: "Object not found" } }
          : batch.operation === "upload" &&
              exists &&
              !(githubLFS(r) && gitNamespace !== "ephemeral")
            ? {}
            : { actions: { [batch.operation]: { href, header } } }),
      });
    }
    return c.json({ transfer: "basic", objects });
  }
  const lfs = suffix.match(/^info\/lfs\/objects\/([0-9a-f]{64})$/);
  if (lfs) {
    const key = `lfs/${r.id}/${lfs[1]}`;
    if (c.req.method === "GET")
      return engine(
        c,
        r,
        "/internal/lfs/" + lfs[1] + new URL(c.req.url).search,
        { namespace: gitNamespace },
      );
    if (c.req.method === "PUT") {
      return engine(c, r, "/internal/lfs/" + lfs[1], {
        method: "PUT",
        body: c.req.raw.body,
        namespace: gitNamespace,
      });
    }
    fail(404, "Unsupported LFS endpoint");
  }
  if (!(
    (c.req.method === "GET" &&
      suffix === "info/refs" &&
      ["git-upload-pack", "git-receive-pack"].includes(
        c.req.query("service") || "",
      )) ||
    (c.req.method === "POST" &&
      ["git-upload-pack", "git-receive-pack"].includes(suffix))
  ))
    fail(404, "Unsupported Git endpoint");
  if (c.req.header("content-encoding"))
    fail(400, "Encoded Git requests are not supported");
  const headers = new Headers();
  for (const h of ["content-type", "git-protocol"]) {
    const v = c.req.header(h);
    if (v) headers.set(h, v);
  }
  const response = await engine(
    c,
    r,
    `/git/${suffix}${new URL(c.req.url).search}`,
    {
      method: c.req.method,
      headers,
      body: c.req.raw.body,
      mutation: c.req.method === "POST" && suffix === "git-receive-pack",
      namespace: gitNamespace,
    },
  );
  if (response.ok && c.req.method === "POST" && suffix === "git-receive-pack")
    await audit(c, "git.receive_pack", r.id);
  return response;
});
app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));
app.get("*", async (c) => {
  const url = new URL(c.req.url);
  if (
    url.pathname === "/app.js" ||
    url.pathname === "/forge.js" ||
    url.pathname === "/openapi.json" ||
    url.pathname === "/style.css" ||
    url.pathname === "/favicon.svg" ||
    url.pathname === "/source.tar.gz"
  )
    return c.env.ASSETS.fetch(c.req.raw);
  url.pathname = "/index.html";
  return c.env.ASSETS.fetch(new Request(url));
});
export default app;
