import type { Context, Hono } from "hono";
import { deleteCookie } from "hono/cookie";
import { z } from "zod";
import type { App } from "./types";
import {
  consumeFactor,
  mfaState,
  passwordProof,
  securityLimit,
  stepUp,
} from "./account";
import { digest, equal, fail, hex, passwordHash } from "./security";
import { jsonInput } from "./workspaces";

const lifetime = 365 * 86400000;
const proof = z.object({
  password: z.string().max(128),
  otp: z.string().max(64).default(""),
  version: z.string().uuid().nullable(),
});
const session = (c: Context<App>) => {
  if (c.get("kind") !== "session" || !c.get("user"))
    fail(403, "Browser session required");
  return c.get("user")!;
};
// Re-evaluate security state at the write, after password hashing and MFA I/O.
const live = `EXISTS(SELECT 1 FROM users u JOIN credentials c ON c.user_id=u.id
 WHERE u.id=? AND u.disabled=0 AND u.has_password=1 AND u.auth_epoch=?
 AND c.hash=? AND c.kind='session' AND c.expires_at>?
 AND COALESCE((SELECT version FROM user_mfa WHERE user_id=u.id AND enabled=1),'')=?)`;

export function registerPasswordRecovery(app: Hono<App>) {
  app.get("/api/account/password-recovery", async (c) => {
    const u = session(c);
    const result = await c.env.DB.batch([
      c.env.DB.prepare(
        `SELECT u.has_password,r.version,r.created_at,r.expires_at
        FROM users u LEFT JOIN password_recovery r ON r.user_id=u.id AND r.auth_epoch=u.auth_epoch
        WHERE u.id=? AND u.disabled=0`,
      ).bind(u.id),
      c.env.DB.prepare(
        `SELECT action,created_at FROM audit WHERE actor_id=?
        AND action IN ('account.password_recovery.issue','account.password_recovery.revoke','account.password_recovery.use')
        ORDER BY id DESC LIMIT 20`,
      ).bind(u.id),
    ]);
    const row = result[0].results[0] as unknown as {
      has_password: number;
      version: string | null;
      created_at: number | null;
      expires_at: number | null;
    };
    if (!row) fail(401, "Sign in required");
    return c.json({
      ...row,
      has_password: !!row.has_password,
      enabled: !!row.version && (row.expires_at || 0) > Date.now(),
      history: result[1].results,
    });
  });
  app.put("/api/account/password-recovery", async (c) => {
    const u = session(c),
      b = proof.parse(await jsonInput(c));
    const stored = await passwordProof(c, b.password);
    if (!stored.has_password)
      fail(409, "Set a local password before creating a password recovery key");
    const mfa = await stepUp(c, b.otp),
      now = Date.now();
    const version = crypto.randomUUID(),
      secret = hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
    const hash = await digest(`password-recovery:${u.id}:${version}:${secret}`);
    const result = await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO password_recovery(user_id,version,hash,auth_epoch,created_at,expires_at)
        SELECT ?,?,?,?,?,? WHERE ${live}
        AND COALESCE((SELECT version FROM password_recovery WHERE user_id=?),'')=?
        ON CONFLICT(user_id) DO UPDATE SET version=excluded.version,hash=excluded.hash,
        auth_epoch=excluded.auth_epoch,created_at=excluded.created_at,expires_at=excluded.expires_at`,
      ).bind(
        u.id,
        version,
        hash,
        stored.auth_epoch,
        now,
        now + lifetime,
        u.id,
        stored.auth_epoch,
        c.get("credential"),
        now,
        mfa || "",
        u.id,
        b.version || "",
      ),
      c.env.DB.prepare(
        `INSERT INTO audit(actor_id,action,event_id)
        SELECT ?,'account.password_recovery.issue',? WHERE EXISTS(SELECT 1 FROM password_recovery WHERE user_id=? AND version=?)`,
      ).bind(u.id, version, u.id, version),
    ]);
    if (!result[0].meta.changes)
      fail(
        409,
        "Account security or recovery key changed; refresh and try again",
      );
    return c.json({
      version,
      key: "osr_" + secret.match(/.{8}/g)!.join("-"),
      created_at: now,
      expires_at: now + lifetime,
    });
  });
  app.delete("/api/account/password-recovery", async (c) => {
    const u = session(c),
      b = proof.parse(await jsonInput(c));
    const stored = await passwordProof(c, b.password),
      mfa = await stepUp(c, b.otp);
    const operation = crypto.randomUUID();
    const result = await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO audit(actor_id,action,event_id)
        SELECT ?,'account.password_recovery.revoke',? WHERE ${live}
        AND EXISTS(SELECT 1 FROM password_recovery WHERE user_id=? AND version=?)`,
      ).bind(
        u.id,
        operation,
        u.id,
        stored.auth_epoch,
        c.get("credential"),
        Date.now(),
        mfa || "",
        u.id,
        b.version || "",
      ),
      c.env.DB.prepare(
        `DELETE FROM password_recovery WHERE user_id=? AND version=?
        AND EXISTS(SELECT 1 FROM audit WHERE event_id=?)`,
      ).bind(u.id, b.version || "", operation),
    ]);
    if (!result[0].meta.changes)
      fail(
        409,
        "Account security or recovery key changed; refresh and try again",
      );
    return c.json({ ok: true });
  });
  app.post("/api/recover-password", async (c) => {
    // This is an anonymous recovery operation, never an alternative PAT/JWT permission.
    if (c.get("kind") && c.get("kind") !== "session")
      fail(403, "Use the password recovery form without an access token");
    const b = z
      .object({
        username: z
          .string()
          .trim()
          .min(1)
          .max(48)
          .transform((s) => s.toLowerCase()),
        key: z.string().max(100),
        new_password: z.string().min(12).max(128),
        otp: z.string().max(64).default(""),
      })
      .parse(await jsonInput(c));
    await securityLimit(
      c.env,
      "password-recovery:ip:" +
        (await digest(c.req.header("cf-connecting-ip") || "local")),
    );
    await securityLimit(
      c.env,
      "password-recovery:user:" + (await digest(b.username)),
    );
    const row = await c.env.DB.prepare(
      `SELECT u.id,u.auth_epoch,r.version,r.hash,r.expires_at
      FROM users u JOIN password_recovery r ON r.user_id=u.id AND r.auth_epoch=u.auth_epoch
      WHERE u.username=? AND u.disabled=0 AND u.has_password=1`,
    )
      .bind(b.username)
      .first<{
        id: string;
        auth_epoch: number;
        version: string;
        hash: string;
        expires_at: number;
      }>();
    const secret = b.key
      .trim()
      .replace(/^osr_/i, "")
      .replace(/[\s-]/g, "")
      .toLowerCase();
    const hash = await digest(
      `password-recovery:${row?.id || "missing"}:${row?.version || "missing"}:${secret}`,
    );
    const invalid = () =>
      fail(401, "Recovery credentials are invalid, expired, or already used");
    if (
      !row ||
      !/^[0-9a-f]{64}$/.test(secret) ||
      !equal(hash, row.hash) ||
      row.expires_at <= Date.now()
    )
      return invalid();
    const mfa = await mfaState(c.env, row.id);
    if (
      mfa?.enabled &&
      !(await consumeFactor(c.env, row.id, b.otp, mfa.version))
    )
      return invalid();
    const newHash = await passwordHash(b.new_password),
      operation = crypto.randomUUID();
    // The password trigger advances auth_epoch and removes the recovery key within this batch.
    const changed =
      "EXISTS(SELECT 1 FROM users WHERE id=? AND password=? AND auth_epoch=? AND disabled=0)";
    const guard = [row.id, newHash, row.auth_epoch + 1];
    const result = await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE users SET password=? WHERE id=? AND disabled=0 AND has_password=1 AND auth_epoch=?
        AND EXISTS(SELECT 1 FROM password_recovery WHERE user_id=users.id AND version=? AND hash=? AND expires_at>?)
        AND COALESCE((SELECT version FROM user_mfa WHERE user_id=users.id AND enabled=1),'')=?`,
      ).bind(
        newHash,
        row.id,
        row.auth_epoch,
        row.version,
        hash,
        Date.now(),
        mfa?.enabled ? mfa.version : "",
      ),
      ...["credentials", "api_keys", "oidc_flows"].map((table) =>
        c.env.DB.prepare(
          `DELETE FROM ${table} WHERE user_id=? AND ${changed}`,
        ).bind(row.id, ...guard),
      ),
      c.env.DB.prepare(
        `INSERT INTO audit(actor_id,action,event_id)
        SELECT ?,'account.password_recovery.use',? WHERE ${changed}`,
      ).bind(row.id, operation, ...guard),
    ]);
    if (!result[0].meta.changes) return invalid();
    deleteCookie(c, "onestorage_session", { path: "/" });
    return c.json({ ok: true, sign_in_required: true });
  });
}
