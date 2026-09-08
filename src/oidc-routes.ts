import { z } from "zod";
import type { Context, Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { App, Env } from "./types";
import { fail, digest, randomToken, slug, passwordHash } from "./security";
import { seal, unseal } from "./sync-config";
import { jsonInput, identity } from "./workspaces";
import {
  consumeFactor,
  mfaState,
  passwordProof,
  securityLimit,
  stepUp,
} from "./account";
import {
  authorize,
  discover,
  exchange,
  pkce,
  providerInput,
  type OIDCProvider,
} from "./oidc";

const adminGuard =
  "EXISTS(SELECT 1 FROM users u JOIN credentials c ON c.user_id=u.id WHERE u.id=? AND u.admin=1 AND u.disabled=0 AND c.hash=? AND c.scope='write' AND c.kind IN ('session','pat') AND c.expires_at>?)";
const cookieName = "onestorage_oidc",
  prefix = "/api/auth/oidc";
interface Flow {
  state_hash: string;
  browser_hash: string;
  provider_id: string;
  revision: number;
  mode: string;
  stage: string;
  user_id: string | null;
  credential_hash: string | null;
  auth_epoch: number | null;
  encrypted: string;
  subject: string | null;
  mfa_version: string | null;
  expires_at: number;
  created_at: number;
}
async function provider(env: Env, id: string, enabled = true) {
  const row = await env.DB.prepare(
    "SELECT * FROM oidc_providers WHERE id=?" +
      (enabled ? " AND enabled=1" : ""),
  )
    .bind(id)
    .first<OIDCProvider>();
  return row || fail(404, "Identity provider unavailable");
}
function publicProvider(p: OIDCProvider) {
  return {
    id: p.id,
    name: p.name,
    issuer: p.issuer,
    client_id: p.client_id,
    configured_secret: !!p.secret,
    enabled: !!p.enabled,
    registration: !!p.registration,
    revision: p.revision,
    ...JSON.parse(p.config),
  };
}
function origin(c: Context<App>) {
  if (c.req.header("origin") !== c.env.APP_ORIGIN)
    fail(403, "Matching Origin required");
}
function session(c: Context<App>) {
  if (c.get("kind") !== "session") fail(403, "Browser session required");
  return identity(c);
}
function flowCookie(c: Context<App>, token: string) {
  setCookie(c, cookieName, token, {
    httpOnly: true,
    secure: c.env.APP_ORIGIN.startsWith("https:"),
    sameSite: "Lax",
    path: prefix,
    maxAge: 600,
  });
}
function clear(c: Context<App>) {
  deleteCookie(c, cookieName, { path: prefix });
}
async function browserHash(c: Context<App>) {
  return digest(getCookie(c, cookieName) || "missing-cookie");
}
async function pending(c: Context<App>) {
  const f = await c.env.DB.prepare(
    "SELECT f.* FROM oidc_flows f JOIN oidc_providers p ON p.id=f.provider_id WHERE f.browser_hash=? AND f.expires_at>? AND p.enabled=1 AND p.revision=f.revision AND f.stage IN ('register','mfa')",
  )
    .bind(await browserHash(c), Date.now())
    .first<Flow>();
  return f || fail(401, "Login expired; start again");
}
async function issue(
  c: Context<App>,
  f: Flow,
  userId: string,
  epoch: number,
  factorVersion: string | null,
) {
  const token = randomToken(),
    id = crypto.randomUUID(),
    now = Date.now();
  // Claim and credential insertion are one transaction; last-row guard prevents a
  // second callback/completion from minting a session after the flow is consumed.
  const result = await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE oidc_flows SET stage='issuing' WHERE state_hash=? AND browser_hash=? AND stage IN ('exchanging','mfa','register') AND expires_at>? AND EXISTS(SELECT 1 FROM oidc_providers WHERE id=oidc_flows.provider_id AND enabled=1 AND revision=oidc_flows.revision) AND EXISTS(SELECT 1 FROM users WHERE id=? AND disabled=0 AND auth_epoch=?) AND EXISTS(SELECT 1 FROM oidc_identities i WHERE i.provider_id=oidc_flows.provider_id AND i.user_id=? AND i.subject=?) AND (mode='login' OR EXISTS(SELECT 1 FROM credentials c WHERE c.hash=oidc_flows.credential_hash AND c.user_id=oidc_flows.user_id AND c.kind='session' AND c.expires_at>?)) AND COALESCE((SELECT version FROM user_mfa WHERE user_id=? AND enabled=1),'')=?",
    ).bind(
      f.state_hash,
      f.browser_hash,
      now,
      userId,
      epoch,
      userId,
      f.subject,
      now,
      userId,
      factorVersion || "",
    ),
    c.env.DB.prepare(
      "INSERT INTO credentials(hash,id,user_id,name,kind,expires_at,oidc_provider_id,authenticated_at) SELECT ?,?,?,'OIDC browser session','session',?,?,? WHERE changes()=1 AND EXISTS(SELECT 1 FROM oidc_flows WHERE state_hash=? AND stage='issuing')",
    ).bind(
      await digest(token),
      id,
      userId,
      now + 7 * 86400000,
      f.provider_id,
      now,
      f.state_hash,
    ),
    c.env.DB.prepare(
      "DELETE FROM credentials WHERE hash=? AND user_id=? AND kind='session' AND EXISTS(SELECT 1 FROM credentials WHERE id=? AND user_id=?)",
    ).bind(f.mode === "reauth" ? f.credential_hash : null, userId, id, userId),
    c.env.DB.prepare(
      "DELETE FROM oidc_flows WHERE state_hash=? AND stage='issuing'",
    ).bind(f.state_hash),
  ]);
  if (!result[1].meta.changes)
    fail(409, "Account or login changed; start again");
  setCookie(c, "onestorage_session", token, {
    httpOnly: true,
    secure: c.env.APP_ORIGIN.startsWith("https:"),
    sameSite: "Strict",
    path: "/",
    maxAge: 7 * 86400,
  });
  clear(c);
  await c.env.DB.prepare(
    "INSERT INTO audit(actor_id,action,detail) VALUES(?,'account.oidc.login',?)",
  )
    .bind(userId, JSON.stringify({ provider: f.provider_id }))
    .run();
}
export async function cleanupOIDC(env: Env) {
  await env.DB.prepare(
    "DELETE FROM oidc_flows WHERE state_hash IN (SELECT state_hash FROM oidc_flows WHERE expires_at<? LIMIT 1000)",
  )
    .bind(Date.now())
    .run();
}
export function registerOIDC(app: Hono<App>, send?: typeof fetch) {
  app.use(prefix + "/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    await next();
  });
  app.get(prefix + "/providers", async (c) =>
    c.json({
      providers: (
        await c.env.DB.prepare(
          "SELECT id,name FROM oidc_providers WHERE enabled=1 ORDER BY name",
        ).all()
      ).results,
    }),
  );
  app.get("/api/admin/identity-providers", async (c) => {
    if (!identity(c).admin) fail(403, "Administrator required");
    return c.json({
      providers: (
        await c.env.DB.prepare(
          "SELECT * FROM oidc_providers ORDER BY name",
        ).all<OIDCProvider>()
      ).results.map(publicProvider),
      callback: c.env.APP_ORIGIN + prefix + "/callback",
    });
  });
  for (const method of ["post", "put"] as const)
    app[method](
      "/api/admin/identity-providers" + (method === "put" ? "/:id" : ""),
      async (c) => {
        const admin = identity(c);
        if (!admin.admin) fail(403, "Administrator required");
        const input = providerInput.parse(await jsonInput(c));
        const old =
          method === "put"
            ? await provider(c.env, c.req.param("id")!, false)
            : null;
        if (
          old &&
          (input.revision !== old.revision ||
            input.issuer !== old.issuer ||
            input.client_id !== old.client_id)
        )
          fail(
            409,
            "Provider revision changed; issuer and client ID are immutable",
          );
        if (
          !old &&
          (await c.env.DB.prepare(
            "SELECT count(*) AS n FROM oidc_providers",
          ).first<{ n: number }>())!.n >= 20
        )
          fail(409, "Maximum 20 identity providers");
        const id = old?.id || crypto.randomUUID();
        let config;
        try {
          config =
            input.enabled || !old
              ? await discover(input, send)
              : {
                  ...JSON.parse(old.config),
                  auth_method: input.auth_method,
                  allowed_hosts: input.allowed_hosts,
                  email_domains: input.email_domains,
                };
        } catch {
          fail(
            400,
            "OIDC discovery failed; verify issuer, approved hosts and client authentication method",
          );
        }
        const secret = input.client_secret
          ? await seal(c.env, "oidc-provider:" + id, input.client_secret)
          : old?.secret || null;
        if (input.auth_method !== "none" && !secret)
          fail(400, "Client secret required");
        if (old) {
          const changed = await c.env.DB.prepare(
            "UPDATE oidc_providers SET name=?,secret=?,config=?,enabled=?,registration=?,revision=revision+1 WHERE id=? AND revision=? AND " +
              adminGuard,
          )
            .bind(
              input.name,
              secret,
              JSON.stringify(config),
              Number(input.enabled),
              Number(input.registration),
              id,
              input.revision,
              admin.id,
              c.get("credential"),
              Date.now(),
            )
            .run();
          if (!changed.meta.changes) fail(409, "Provider changed");
        } else {
          const changed = await c.env.DB.prepare(
            "INSERT INTO oidc_providers(id,name,issuer,client_id,secret,config,enabled,registration) SELECT ?,?,?,?,?,?,?,? WHERE (SELECT count(*) FROM oidc_providers)<20 AND " +
              adminGuard,
          )
            .bind(
              id,
              input.name,
              input.issuer,
              input.client_id,
              secret,
              JSON.stringify(config),
              Number(input.enabled),
              Number(input.registration),
              admin.id,
              c.get("credential"),
              Date.now(),
            )
            .run();
          if (!changed.meta.changes)
            fail(409, "Provider limit or administrator authorization changed");
        }
        await c.env.DB.prepare(
          "INSERT INTO audit(actor_id,action,detail) VALUES(?,'admin.oidc.configure',?)",
        )
          .bind(admin.id, JSON.stringify({ provider: id }))
          .run();
        return c.json(
          publicProvider(await provider(c.env, id, false)),
          old ? 200 : 201,
        );
      },
    );
  app.delete("/api/admin/identity-providers/:id", async (c) => {
    if (!identity(c).admin) fail(403, "Administrator required");
    const p = await provider(c.env, c.req.param("id"), false);
    if (
      await c.env.DB.prepare(
        "SELECT id FROM oidc_identities WHERE provider_id=? LIMIT 1",
      )
        .bind(p.id)
        .first()
    )
      fail(409, "Linked accounts exist; disable the provider instead");
    const changed = await c.env.DB.prepare(
      "DELETE FROM oidc_providers WHERE id=? AND revision=? AND NOT EXISTS(SELECT 1 FROM oidc_identities WHERE provider_id=oidc_providers.id) AND " +
        adminGuard,
    )
      .bind(p.id, p.revision, identity(c).id, c.get("credential"), Date.now())
      .run();
    if (!changed.meta.changes)
      fail(409, "Provider or administrator authorization changed");
    await c.env.DB.prepare(
      "INSERT INTO audit(actor_id,action,detail) VALUES(?,'admin.oidc.delete',?)",
    )
      .bind(identity(c).id, JSON.stringify({ provider: p.id }))
      .run();
    return c.json({ deleted: true });
  });
  app.post(prefix + "/:id/start", async (c) => {
    origin(c);
    const p = await provider(c.env, c.req.param("id")!);
    await securityLimit(
      c.env,
      "oidc:" + (c.req.header("cf-connecting-ip") || "local"),
    );
    const b = z
      .object({
        mode: z.enum(["login", "link", "reauth"]).default("login"),
        password: z.string().max(128).default(""),
        otp: z.string().max(64).default(""),
      })
      .parse(await jsonInput(c));
    let userId: string | null = null,
      credential: string | null = null,
      epoch: number | null = null,
      factorVersion: string | null = null;
    if (b.mode !== "login") {
      const u = session(c);
      userId = u.id;
      credential = c.get("credential");
      if (b.mode === "link") {
        epoch = (await passwordProof(c, b.password)).auth_epoch;
        factorVersion = await stepUp(c, b.otp);
      } else
        epoch =
          (
            await c.env.DB.prepare(
              "SELECT auth_epoch FROM users WHERE id=? AND disabled=0",
            )
              .bind(u.id)
              .first<{ auth_epoch: number }>()
          )?.auth_epoch ?? null;
      if (epoch === null) fail(401, "Sign in required");
    } else if (c.get("user"))
      fail(409, "Sign out before changing account, or use account linking");
    const state = randomToken(),
      browser = randomToken(),
      stateHash = await digest(state),
      nonce = randomToken(),
      verifier = randomToken(),
      now = Date.now();
    const encrypted = await seal(c.env, "oidc-flow:" + stateHash, {
      nonce,
      verifier,
    });
    await c.env.DB.prepare("DELETE FROM oidc_flows WHERE browser_hash=?")
      .bind(await browserHash(c))
      .run();
    await c.env.DB.prepare(
      "INSERT INTO oidc_flows(state_hash,browser_hash,provider_id,revision,mode,user_id,credential_hash,auth_epoch,encrypted,expires_at,created_at,mfa_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        stateHash,
        await digest(browser),
        p.id,
        p.revision,
        b.mode,
        userId,
        credential,
        epoch,
        encrypted,
        now + 600000,
        now,
        factorVersion,
      )
      .run();
    flowCookie(c, browser);
    c.executionCtx.waitUntil(cleanupOIDC(c.env));
    return c.json({
      url: authorize(
        p,
        state,
        nonce,
        await pkce(verifier),
        c.env.APP_ORIGIN + prefix + "/callback",
      ),
    });
  });
  app.get(prefix + "/callback", async (c) => {
    let f: Flow | null = null;
    try {
      const query = c.req.query();
      if (
        !query.state ||
        query.state.length > 256 ||
        !query.code ||
        query.code.length > 4096 ||
        query.error
      )
        throw Error("Invalid callback");
      const stateHash = await digest(query.state);
      f = await c.env.DB.prepare(
        "UPDATE oidc_flows SET stage='exchanging' WHERE state_hash=? AND browser_hash=? AND stage='pending' AND expires_at>? AND EXISTS(SELECT 1 FROM oidc_providers WHERE id=oidc_flows.provider_id AND revision=oidc_flows.revision AND enabled=1) RETURNING *",
      )
        .bind(stateHash, await browserHash(c), Date.now())
        .first<Flow>();
      if (!f) throw Error("Expired callback");
      const p = await provider(c.env, f.provider_id);
      if (query.iss && query.iss !== p.issuer) throw Error("Issuer mismatch");
      const { nonce, verifier } = await unseal<{
        nonce: string;
        verifier: string;
      }>(c.env, "oidc-flow:" + f.state_hash, f.encrypted);
      const secret = p.secret
        ? await unseal<string>(c.env, "oidc-provider:" + p.id, p.secret)
        : null;
      const claims = await exchange(
        p,
        secret,
        query.code,
        verifier,
        nonce,
        c.env.APP_ORIGIN + prefix + "/callback",
        send,
      );
      f.subject = claims.subject;
      const linked = await c.env.DB.prepare(
        "SELECT u.id,u.auth_epoch,u.disabled FROM oidc_identities i JOIN users u ON u.id=i.user_id WHERE i.provider_id=? AND i.subject=?",
      )
        .bind(p.id, claims.subject)
        .first<{ id: string; auth_epoch: number; disabled: number }>();
      if (f.mode === "link") {
        const result = await c.env.DB.prepare(
          "INSERT INTO oidc_identities(id,provider_id,subject,user_id) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM oidc_flows f JOIN oidc_providers p ON p.id=f.provider_id JOIN credentials c ON c.hash=f.credential_hash JOIN users u ON u.id=f.user_id WHERE f.state_hash=? AND f.stage='exchanging' AND f.expires_at>? AND p.enabled=1 AND p.revision=f.revision AND c.user_id=f.user_id AND c.expires_at>? AND c.kind='session' AND u.disabled=0 AND u.auth_epoch=f.auth_epoch AND COALESCE((SELECT version FROM user_mfa WHERE user_id=f.user_id AND enabled=1),'')=COALESCE(f.mfa_version,''))",
        )
          .bind(
            crypto.randomUUID(),
            p.id,
            claims.subject,
            f.user_id,
            f.state_hash,
            Date.now(),
            Date.now(),
          )
          .run();
        if (!result.meta.changes) throw Error("Link no longer authorized");
        await c.env.DB.prepare("DELETE FROM oidc_flows WHERE state_hash=?")
          .bind(f.state_hash)
          .run();
        await c.env.DB.prepare(
          "INSERT INTO audit(actor_id,action,detail) VALUES(?,'account.oidc.link',?)",
        )
          .bind(f.user_id, JSON.stringify({ provider: p.id }))
          .run();
        clear(c);
        return c.redirect("/settings/account", 303);
      }
      if (
        f.mode === "reauth" &&
        (!linked ||
          linked.id !== f.user_id ||
          linked.auth_epoch !== f.auth_epoch ||
          !(await c.env.DB.prepare(
            "SELECT hash FROM credentials WHERE hash=? AND user_id=? AND kind='session' AND expires_at>?",
          )
            .bind(f.credential_hash, f.user_id, Date.now())
            .first()))
      )
        throw Error("Reauthentication account mismatch");
      if (linked) {
        if (linked.disabled) throw Error("Account disabled");
        const m = await mfaState(c.env, linked.id);
        if (!m?.enabled) {
          await issue(c, f, linked.id, linked.auth_epoch, null);
          return c.redirect("/", 303);
        }
        const changed = await c.env.DB.prepare(
          "UPDATE oidc_flows SET stage='mfa',user_id=?,auth_epoch=?,subject=?,mfa_version=? WHERE state_hash=? AND stage='exchanging'",
        )
          .bind(
            linked.id,
            linked.auth_epoch,
            claims.subject,
            m.version,
            f.state_hash,
          )
          .run();
        if (!changed.meta.changes) throw Error("Flow changed");
      } else {
        if (!p.registration || f.mode !== "login")
          throw Error("Identity is not linked and registration is disabled");
        const changed = await c.env.DB.prepare(
          "UPDATE oidc_flows SET stage='register',subject=?,encrypted=? WHERE state_hash=? AND stage='exchanging'",
        )
          .bind(
            claims.subject,
            await seal(c.env, "oidc-flow:" + f.state_hash, {
              suggested_username: claims.suggested_username,
            }),
            f.state_hash,
          )
          .run();
        if (!changed.meta.changes) throw Error("Flow changed");
      }
      return c.redirect("/login/oidc", 303);
    } catch {
      if (f)
        await c.env.DB.prepare("DELETE FROM oidc_flows WHERE state_hash=?")
          .bind(f.state_hash)
          .run();
      clear(c);
      return c.redirect("/login?oidc_error=failed", 303);
    }
  });
  app.get(prefix + "/pending", async (c) => {
    const f = await pending(c);
    return c.json({
      stage: f.stage,
      provider: (await provider(c.env, f.provider_id)).name,
    });
  });
  app.post(prefix + "/complete", async (c) => {
    origin(c);
    const f = await pending(c),
      p = await provider(c.env, f.provider_id);
    const b = z
      .object({
        username: slug.optional(),
        otp: z.string().max(64).default(""),
      })
      .parse(await jsonInput(c));
    if (f.stage === "mfa") {
      if (
        !f.user_id ||
        !(await consumeFactor(c.env, f.user_id, b.otp, f.mfa_version!))
      )
        fail(401, "Invalid or already used verification code");
      await issue(c, f, f.user_id, f.auth_epoch!, f.mfa_version);
      return c.json({ ok: true });
    }
    if (!b.username || !p.registration)
      fail(400, "Choose a username; provider registration must be enabled");
    if (f.user_id) {
      await issue(c, f, f.user_id, f.auth_epoch!, null);
      return c.json({ ok: true }, 201);
    }
    const id = crypto.randomUUID(),
      hash = await passwordHash(randomToken() + randomToken());
    try {
      const result = await c.env.DB.batch([
        c.env.DB.prepare(
          "UPDATE oidc_flows SET stage='creating' WHERE state_hash=? AND stage='register' AND expires_at>? AND EXISTS(SELECT 1 FROM oidc_providers WHERE id=oidc_flows.provider_id AND enabled=1 AND registration=1 AND revision=oidc_flows.revision)",
        ).bind(f.state_hash, Date.now()),
        c.env.DB.prepare(
          "INSERT INTO users(id,username,password,has_password) SELECT ?,?,?,0 WHERE changes()=1",
        ).bind(id, b.username, hash),
        c.env.DB.prepare(
          "INSERT INTO oidc_identities(id,provider_id,subject,user_id) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM users WHERE id=?)",
        ).bind(crypto.randomUUID(), p.id, f.subject, id, id),
        c.env.DB.prepare(
          "UPDATE oidc_flows SET stage='register',user_id=?,auth_epoch=0 WHERE state_hash=? AND stage='creating' AND EXISTS(SELECT 1 FROM users WHERE id=?)",
        ).bind(id, f.state_hash, id),
      ]);
      if (!result[1].meta.changes) fail(409, "Registration expired");
    } catch {
      fail(
        409,
        "Username or identity already registered; choose another name or sign in again",
      );
    }
    await issue(c, { ...f, user_id: id, auth_epoch: 0 }, id, 0, null);
    return c.json({ ok: true }, 201);
  });
  app.get("/api/account/identities", async (c) => {
    const u = session(c);
    const row = await c.env.DB.prepare(
      "SELECT has_password FROM users WHERE id=?",
    )
      .bind(u.id)
      .first<{ has_password: number }>();
    return c.json({
      has_password: !!row?.has_password,
      identities: (
        await c.env.DB.prepare(
          "SELECT i.id,i.provider_id,p.name,p.enabled,i.created_at FROM oidc_identities i JOIN oidc_providers p ON p.id=i.provider_id WHERE i.user_id=? ORDER BY p.name",
        )
          .bind(u.id)
          .all()
      ).results,
      providers: (
        await c.env.DB.prepare(
          "SELECT id,name FROM oidc_providers WHERE enabled=1 ORDER BY name",
        ).all()
      ).results,
    });
  });
  app.post("/api/account/identities/:id/unlink", async (c) => {
    const u = session(c);
    const b = z
      .object({
        password: z.string().max(128).default(""),
        otp: z.string().max(64).default(""),
      })
      .parse(await jsonInput(c));
    await passwordProof(c, b.password);
    await stepUp(c, b.otp);
    const result = await c.env.DB.prepare(
      "DELETE FROM oidc_identities WHERE id=? AND user_id=? AND EXISTS(SELECT 1 FROM users u JOIN credentials c ON c.user_id=u.id WHERE u.id=? AND u.disabled=0 AND c.hash=? AND c.kind='session' AND c.expires_at>? AND (u.has_password=1 OR EXISTS(SELECT 1 FROM oidc_identities i JOIN oidc_providers p ON p.id=i.provider_id WHERE i.user_id=u.id AND i.id!=? AND p.enabled=1)))",
    )
      .bind(
        c.req.param("id"),
        u.id,
        u.id,
        c.get("credential"),
        Date.now(),
        c.req.param("id"),
      )
      .run();
    if (!result.meta.changes)
      fail(409, "Keep a password or another enabled identity before unlinking");
    await c.env.DB.prepare(
      "INSERT INTO audit(actor_id,action,detail) VALUES(?,'account.oidc.unlink',?)",
    )
      .bind(u.id, JSON.stringify({ identity: c.req.param("id") }))
      .run();
    return c.json({ ok: true });
  });
}
