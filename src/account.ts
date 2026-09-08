import { z } from "zod";
import type { Hono, Context } from "hono";
import type { App, Env, User } from "./types";
import { fail, digest, verifyPassword, hex } from "./security";
import { seal, unseal } from "./sync-config";
import { base32, totpCounter } from "./totp";
import { jsonInput } from "./workspaces";
import { deleteCookie } from "hono/cookie";
interface MFA {
  user_id: string;
  version: string;
  secret: string;
  enabled: number;
  expires_at: number;
  last_counter: number;
}
export async function mfaState(env: Env, id: string) {
  return env.DB.prepare("SELECT * FROM user_mfa WHERE user_id=?")
    .bind(id)
    .first<MFA>();
}
export async function securityLimit(env: Env, id: string) {
  const key = "security:" + id + ":" + Math.floor(Date.now() / 600000);
  const row = await env.DB.prepare(
    "INSERT INTO login_limits(key,attempts,reset_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=attempts+1 RETURNING attempts",
  )
    .bind(key, Date.now() + 600000)
    .first<{ attempts: number }>();
  if ((row?.attempts || 0) > 10)
    fail(429, "Too many verification attempts; retry in ten minutes");
}
export async function consumeFactor(
  env: Env,
  id: string,
  code: string,
  expectedVersion?: string,
) {
  const mfa = await mfaState(env, id);
  if (!mfa?.enabled || (expectedVersion && mfa.version !== expectedVersion))
    return false;
  await securityLimit(env, id);
  const normalized = code.trim().replace(/[\s-]/g, "").toLowerCase();
  if (/^[a-f0-9]{32}$/.test(normalized)) {
    const hash = await digest(`recovery:${id}:${mfa.version}:${normalized}`);
    const result = await env.DB.prepare(
      "DELETE FROM mfa_recovery WHERE user_id=? AND hash=? AND version=? AND EXISTS(SELECT 1 FROM user_mfa WHERE user_id=? AND version=? AND enabled=1) RETURNING hash",
    )
      .bind(id, hash, mfa.version, id, mfa.version)
      .first();
    return !!result;
  }
  const secret = await unseal<string>(
      env,
      "mfa:" + id + ":" + mfa.version,
      mfa.secret,
    ),
    counter = await totpCounter(secret, normalized, mfa.last_counter);
  if (counter === null) return false;
  const result = await env.DB.prepare(
    "UPDATE user_mfa SET last_counter=? WHERE user_id=? AND version=? AND enabled=1 AND last_counter<?",
  )
    .bind(counter, id, mfa.version, counter)
    .run();
  return !!result.meta.changes;
}
export async function passwordProof(c: Context<App>, password: string) {
  const user = c.get("user") || fail(401, "Sign in required");
  await securityLimit(c.env, "password:" + user.id);
  const row = await c.env.DB.prepare(
    "SELECT password,auth_epoch,has_password FROM users WHERE id=? AND disabled=0",
  )
    .bind(user.id)
    .first<{ password: string; auth_epoch: number; has_password: number }>();
  if (row && !row.has_password) {
    if (
      c.get("kind") !== "session" ||
      !(await c.env.DB.prepare(
        "SELECT c.hash FROM credentials c JOIN oidc_providers p ON p.id=c.oidc_provider_id WHERE c.hash=? AND c.user_id=? AND c.kind='session' AND c.expires_at>? AND c.authenticated_at>? AND p.enabled=1",
      )
        .bind(c.get("credential"), user.id, Date.now(), Date.now() - 300000)
        .first())
    )
      fail(
        403,
        "Complete OIDC sign-in again before changing security settings",
      );
    return row;
  }
  if (!row || !(await verifyPassword(password, row.password)))
    fail(403, "Current password is incorrect");
  return row;
}
async function requireFactor(c: Context<App>, code: string) {
  const m = await mfaState(c.env, c.get("user")!.id);
  if (!m?.enabled) fail(409, "Two-factor authentication is not enabled");
  if (!(await consumeFactor(c.env, m.user_id, code, m.version)))
    fail(403, "Invalid or already used verification code");
  return m;
}
export async function stepUp(c: Context<App>, otp = "") {
  const m = await mfaState(c.env, c.get("user")!.id);
  if (m?.enabled && !(await consumeFactor(c.env, m.user_id, otp, m.version)))
    fail(403, "A fresh authenticator or recovery code is required");
  return m?.enabled ? m.version : null;
}
async function recoveryCodes(
  env: Env,
  userId: string,
  version: string,
  operation: string,
) {
  const codes = Array.from({ length: 10 }, () =>
    hex(crypto.getRandomValues(new Uint8Array(16)).buffer),
  );
  const statements = [];
  for (const code of codes)
    statements.push(
      env.DB.prepare(
        "INSERT INTO mfa_recovery(user_id,version,hash) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM user_mfa WHERE user_id=? AND version=? AND operation=? AND enabled=1)",
      ).bind(
        userId,
        version,
        await digest(`recovery:${userId}:${version}:${code}`),
        userId,
        version,
        operation,
      ),
    );
  return { codes: codes.map((x) => x.match(/.{8}/g)!.join("-")), statements };
}
export function registerAccount(app: Hono<App>) {
  const session = (c: Context<App>) => {
    if (c.get("kind") !== "session" || !c.get("user"))
      fail(403, "Browser session required");
    return c.get("user")!;
  };
  const record = (c: Context<App>, action: string) =>
    c.env.DB.prepare("INSERT INTO audit(actor_id,action) VALUES(?,?)")
      .bind(c.get("user")!.id, action)
      .run();
  const proofSchema = z.object({
    password: z.string().max(128),
    otp: z.string().max(64).default(""),
  });
  app.get("/api/account/security", async (c) => {
    const u = session(c),
      m = await mfaState(c.env, u.id),
      count = await c.env.DB.prepare(
        "SELECT count(*) AS n FROM mfa_recovery WHERE user_id=?",
      )
        .bind(u.id)
        .first<{ n: number }>();
    return c.json({
      enabled: !!m?.enabled,
      pending: !!m && !m.enabled && m.expires_at > Date.now(),
      recovery_codes_remaining: count?.n || 0,
    });
  });
  app.post("/api/account/mfa/setup", async (c) => {
    const u = session(c),
      b = proofSchema.parse(await jsonInput(c));
    await passwordProof(c, b.password);
    const previous = await mfaState(c.env, u.id);
    if (previous?.enabled)
      fail(409, "Disable the current authenticator before replacing it");
    const version = crypto.randomUUID(),
      secret = base32(crypto.getRandomValues(new Uint8Array(20))),
      expires = Date.now() + 600000,
      encrypted = await seal(c.env, "mfa:" + u.id + ":" + version, secret);
    const result = await c.env.DB.prepare(
      "INSERT INTO user_mfa(user_id,version,secret,expires_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET version=excluded.version,secret=excluded.secret,expires_at=excluded.expires_at,last_counter=-1 WHERE user_mfa.enabled=0",
    )
      .bind(u.id, version, encrypted, expires)
      .run();
    if (!result.meta.changes) fail(409, "Authenticator changed; refresh");
    return c.json({
      version,
      secret,
      expires_at: expires,
      uri:
        "otpauth://totp/" +
        encodeURIComponent("OneStorage:" + u.username) +
        "?secret=" +
        secret +
        "&issuer=OneStorage&algorithm=SHA1&digits=6&period=30",
    });
  });
  app.post("/api/account/mfa/enable", async (c) => {
    const u = session(c),
      b = z
        .object({
          version: z.string().uuid(),
          otp: z.string().regex(/^\d{6}$/),
        })
        .parse(await jsonInput(c));
    await securityLimit(c.env, u.id);
    const m = await mfaState(c.env, u.id);
    if (!m || m.enabled || m.version !== b.version || m.expires_at < Date.now())
      fail(409, "Setup expired or changed; start again");
    const secret = await unseal<string>(
        c.env,
        "mfa:" + u.id + ":" + m.version,
        m.secret,
      ),
      counter = await totpCounter(secret, b.otp);
    if (counter === null) fail(403, "Authenticator code is incorrect");
    const operation = crypto.randomUUID(),
      recovery = await recoveryCodes(c.env, u.id, m.version, operation),
      live =
        "EXISTS(SELECT 1 FROM user_mfa WHERE user_id=? AND operation=? AND enabled=1)";
    const result = await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE user_mfa SET enabled=1,last_counter=?,operation=? WHERE user_id=? AND version=? AND enabled=0 AND expires_at>? AND EXISTS(SELECT 1 FROM credentials c JOIN users u ON u.id=c.user_id WHERE c.hash=? AND c.user_id=user_mfa.user_id AND c.kind='session' AND c.expires_at>? AND u.disabled=0)",
      ).bind(
        counter,
        operation,
        u.id,
        m.version,
        Date.now(),
        c.get("credential"),
        Date.now(),
      ),
      c.env.DB.prepare(
        `UPDATE users SET auth_epoch=auth_epoch+1 WHERE id=? AND ${live}`,
      ).bind(u.id, u.id, operation),
      c.env.DB.prepare(
        `DELETE FROM credentials WHERE user_id=? AND kind='session' AND hash!=? AND ${live}`,
      ).bind(u.id, c.get("credential"), u.id, operation),
      ...recovery.statements,
    ]);
    if (!result[0].meta.changes) fail(409, "Authenticator changed; refresh");
    await record(c, "account.mfa.enable");
    return c.json({ enabled: true, recovery_codes: recovery.codes });
  });
  app.post("/api/account/mfa/recovery", async (c) => {
    const u = session(c),
      b = proofSchema.parse(await jsonInput(c));
    await passwordProof(c, b.password);
    const m = await requireFactor(c, b.otp),
      operation = crypto.randomUUID(),
      recovery = await recoveryCodes(c.env, u.id, m.version, operation);
    const result = await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE user_mfa SET operation=? WHERE user_id=? AND version=? AND enabled=1 AND EXISTS(SELECT 1 FROM credentials c JOIN users u ON u.id=c.user_id WHERE c.hash=? AND c.user_id=user_mfa.user_id AND c.kind='session' AND c.expires_at>? AND u.disabled=0)",
      ).bind(operation, u.id, m.version, c.get("credential"), Date.now()),
      c.env.DB.prepare(
        "DELETE FROM mfa_recovery WHERE user_id=? AND EXISTS(SELECT 1 FROM user_mfa WHERE user_id=? AND operation=?)",
      ).bind(u.id, u.id, operation),
      ...recovery.statements,
    ]);
    if (!result[0].meta.changes) fail(409, "Authenticator changed; refresh");
    await record(c, "account.mfa.recovery.rotate");
    return c.json({ recovery_codes: recovery.codes });
  });
  app.post("/api/account/mfa/disable", async (c) => {
    const u = session(c),
      b = proofSchema.parse(await jsonInput(c));
    await passwordProof(c, b.password);
    const m = await requireFactor(c, b.otp),
      operation = crypto.randomUUID(),
      live = "EXISTS(SELECT 1 FROM user_mfa WHERE user_id=? AND operation=?)";
    const result = await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE user_mfa SET operation=? WHERE user_id=? AND version=? AND enabled=1 AND EXISTS(SELECT 1 FROM credentials c JOIN users u ON u.id=c.user_id WHERE c.hash=? AND c.user_id=user_mfa.user_id AND c.kind='session' AND c.expires_at>? AND u.disabled=0)",
      ).bind(operation, u.id, m.version, c.get("credential"), Date.now()),
      c.env.DB.prepare(
        `UPDATE users SET auth_epoch=auth_epoch+1 WHERE id=? AND ${live}`,
      ).bind(u.id, u.id, operation),
      c.env.DB.prepare(
        `DELETE FROM credentials WHERE user_id=? AND kind='session' AND hash!=? AND ${live}`,
      ).bind(u.id, c.get("credential"), u.id, operation),
      c.env.DB.prepare(
        `DELETE FROM mfa_recovery WHERE user_id=? AND ${live}`,
      ).bind(u.id, u.id, operation),
      c.env.DB.prepare(
        "DELETE FROM user_mfa WHERE user_id=? AND operation=?",
      ).bind(u.id, operation),
    ]);
    if (!result[0].meta.changes) fail(409, "Authenticator changed; refresh");
    await record(c, "account.mfa.disable");
    return c.json({ enabled: false });
  });
  app.get("/api/account/sessions", async (c) => {
    const u = session(c);
    return c.json({
      sessions: (
        await c.env.DB.prepare(
          "SELECT id,created_at,expires_at,(hash=?) AS current FROM credentials WHERE user_id=? AND kind='session' AND expires_at>? ORDER BY created_at DESC LIMIT 100",
        )
          .bind(c.get("credential"), u.id, Date.now())
          .all()
      ).results,
    });
  });
  app.delete("/api/account/sessions/:id", async (c) => {
    const u = session(c);
    const row = await c.env.DB.prepare(
      "DELETE FROM credentials WHERE id=? AND user_id=? AND kind='session' RETURNING hash",
    )
      .bind(c.req.param("id"), u.id)
      .first<{ hash: string }>();
    if (row?.hash === c.get("credential"))
      deleteCookie(c, "onestorage_session", { path: "/" });
    await record(c, "account.session.revoke");
    return c.json({ ok: true });
  });
  app.get("/api/profile", async (c) => {
    const u = session(c);
    return c.json(
      await c.env.DB.prepare(
        "SELECT u.username,p.display_name,p.bio,p.location,p.website FROM users u LEFT JOIN user_profiles p ON p.user_id=u.id WHERE u.id=?",
      )
        .bind(u.id)
        .first(),
    );
  });
  app.put("/api/profile", async (c) => {
    const u = session(c),
      b = z
        .object({
          display_name: z.string().trim().max(80).default(""),
          bio: z.string().max(2000).default(""),
          location: z.string().trim().max(100).default(""),
          website: z
            .string()
            .max(1000)
            .refine((s) => {
              try {
                return (
                  !s ||
                  (/^https?:\/\//.test(s) &&
                    !new URL(s).username &&
                    !new URL(s).password)
                );
              } catch {
                return false;
              }
            }, "Use an HTTP(S) URL without credentials")
            .default(""),
        })
        .parse(await jsonInput(c));
    await c.env.DB.prepare(
      "INSERT INTO user_profiles(user_id,display_name,bio,location,website) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name,bio=excluded.bio,location=excluded.location,website=excluded.website,updated_at=datetime('now')",
    )
      .bind(u.id, b.display_name, b.bio, b.location, b.website)
      .run();
    return c.json({ ok: true });
  });
  app.get("/api/profiles/:username", async (c) => {
    if (c.get("delegation")) fail(403, "Git delegation cannot read profiles");
    const u = await c.env.DB.prepare(
      "SELECT u.id,u.username,u.created_at,p.display_name,p.bio,p.location,p.website FROM users u LEFT JOIN user_profiles p ON p.user_id=u.id WHERE u.username=? AND u.disabled=0",
    )
      .bind(c.req.param("username"))
      .first<User & Record<string, unknown>>();
    if (!u) fail(404, "User not found");
    const viewer = c.get("user")?.id || "",
      before = Number(c.req.query("before") || Number.MAX_SAFE_INTEGER);
    if (!Number.isSafeInteger(before) || before < 1)
      fail(400, "Invalid activity cursor");
    const allowed =
      "(r.visibility='public' OR (r.workspace_id IS NULL AND r.owner_id=?) OR EXISTS(SELECT 1 FROM members m WHERE m.repo_id=r.id AND m.user_id=?) OR EXISTS(SELECT 1 FROM workspace_members w WHERE w.workspace_id=r.workspace_id AND w.user_id=?))";
    const [repos, activity] = await Promise.all([
      c.env.DB.prepare(
        `SELECT r.id,r.namespace,r.name,r.description,r.visibility FROM repositories r WHERE r.owner_id=? AND r.workspace_id IS NULL AND r.deleted_at IS NULL AND ${allowed} ORDER BY r.created_at DESC LIMIT 50`,
      )
        .bind(u.id, viewer, viewer, viewer)
        .all(),
      c.env.DB.prepare(
        `SELECT a.id,a.action,a.detail,a.created_at,r.namespace,r.name FROM audit a JOIN repositories r ON r.id=a.repo_id WHERE a.actor_id=? AND a.id<? AND r.deleted_at IS NULL AND ${allowed} ORDER BY a.id DESC LIMIT 50`,
      )
        .bind(u.id, before, viewer, viewer, viewer)
        .all<any>(),
    ]);
    return c.json({
      profile: u,
      repositories: repos.results,
      activity: activity.results,
      next: activity.results.length === 50 ? activity.results.at(-1).id : null,
    });
  });
}
