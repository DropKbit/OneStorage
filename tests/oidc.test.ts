import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { fixture } from "./support/review-fixture";
import { registerOIDC } from "../src/oidc-routes";
import { discover, exchange, pkce, providerInput } from "../src/oidc";
import { digest, passwordHash } from "../src/security";
import { hotp } from "../src/totp";
import { seal } from "../src/sync-config";
import type { App } from "../src/types";

const issuer = "https://identity.example.com",
  secret = "client-secret-example",
  password = "OIDC-test-password-123";
async function setup() {
  const f = fixture();
  f.db
    .prepare(
      "INSERT INTO users(id,username,password,admin) VALUES('backup-admin','backup-admin','unused',1)",
    )
    .run();
  f.env.APP_ORIGIN = "https://git.example.com";
  f.env.CREDENTIAL_ENCRYPTION_KEY = btoa("x".repeat(32));
  f.db
    .prepare("UPDATE users SET admin=1,password=? WHERE id='o'")
    .run(await passwordHash(password));
  f.db
    .prepare(
      "INSERT INTO credentials(hash,id,user_id,name,kind,expires_at) VALUES('admin','admin','o','test','session',?)",
    )
    .run(Date.now() + 600000);
  const keys = await generateKeyPair("ES256"),
    jwk = { ...(await exportJWK(keys.publicKey)), kid: "test" };
  let claims: Record<string, any> = {},
    authURL: URL,
    downloads = 0,
    onDiscovery = () => {};
  const send = async (input: any, init?: RequestInit) => {
    const url = new URL(String(input));
    downloads++;
    if (url.pathname.endsWith("openid-configuration")) {
      onDiscovery();
      return Response.json({
        issuer,
        authorization_endpoint: issuer + "/authorize",
        token_endpoint: issuer + "/token",
        jwks_uri: issuer + "/jwks",
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic"],
      });
    }
    if (url.pathname === "/jwks") return Response.json({ keys: [jwk] });
    assert.equal(url.pathname, "/token");
    assert.equal(
      new Headers(init!.headers).get("authorization"),
      "Basic " + btoa("client:" + secret),
    );
    const body = new URLSearchParams(init!.body as URLSearchParams);
    assert.match(body.get("code_verifier")!, /^[A-Za-z0-9._~-]{43,128}$/);
    assert.equal(
      await pkce(body.get("code_verifier")!),
      authURL.searchParams.get("code_challenge"),
    );
    const jwt = await new SignJWT({
      nonce: authURL.searchParams.get("nonce"),
      ...claims,
    })
      .setProtectedHeader({ alg: "ES256", kid: "test" })
      .setSubject(claims.sub || "subject-one")
      .setIssuer(claims.iss || issuer)
      .setAudience(claims.aud || "client")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(keys.privateKey);
    return Response.json({ id_token: jwt, access_token: "discard-me" });
  };
  const app = new Hono<App>();
  app.use("*", async (c, next) => {
    const admin = c.req.header("authorization") === "Bearer admin";
    c.set("user", admin ? { id: "o", username: "owner", admin: 1 } : null);
    c.set("kind", admin ? "session" : null);
    c.set("scope", "write");
    c.set("credential", admin ? "admin" : null);
    await next();
  });
  app.onError((e, c) =>
    c.json({ error: e.message }, e instanceof HTTPException ? e.status : 400),
  );
  registerOIDC(app, send as any);
  let cookie = "";
  async function req(
    path: string,
    method = "GET",
    body?: any,
    admin = false,
    expected = 200,
    extra: Record<string, string> = {},
  ) {
    const r = await app.request(
      "https://git.example.com" + path,
      {
        method,
        headers: {
          Origin: f.env.APP_ORIGIN,
          ...(admin ? { Authorization: "Bearer admin" } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          "content-type": "application/json",
          ...extra,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      f.env,
      { waitUntil: () => {}, passThroughOnException: () => {}, props: {} },
    );
    assert.equal(r.status, expected, await r.clone().text());
    const set = r.headers.getSetCookie?.() || [];
    const flow = set.find((s) => s.startsWith("onestorage_oidc="));
    if (flow) cookie = flow.split(";")[0];
    return r;
  }
  const config = {
    name: "Test OIDC",
    issuer,
    client_id: "client",
    client_secret: secret,
    allowed_hosts: ["identity.example.com"],
    enabled: true,
    registration: true,
  };
  const provider = (await (
    await req("/api/admin/identity-providers", "POST", config, true, 201)
  ).json()) as any;
  async function start(mode = "login") {
    const r = (await (
      await req(
        "/api/auth/oidc/" + provider.id + "/start",
        "POST",
        { mode, password },
        mode !== "login",
      )
    ).json()) as any;
    authURL = new URL(r.url);
    return authURL;
  }
  async function callback(expected = 303) {
    return req(
      "/api/auth/oidc/callback?state=" +
        encodeURIComponent(authURL.searchParams.get("state")!) +
        "&code=test",
      "GET",
      undefined,
      false,
      expected,
    );
  }
  return {
    ...f,
    app,
    req,
    provider,
    config,
    start,
    callback,
    setClaims: (c: any) => {
      claims = c;
    },
    setDiscoveryHook: (hook: () => void) => {
      onDiscovery = hook;
    },
    getCookie: () => cookie,
    setCookie: (s: string) => {
      cookie = s;
    },
    getDownloads: () => downloads,
  };
}
test("OIDC discovery rejects foreign endpoints, bad issuers and non-PKCE providers", async () => {
  const input = providerInput.parse({
    name: "test",
    issuer,
    client_id: "x",
    allowed_hosts: ["identity.example.com"],
    auth_method: "none",
  });
  for (const override of [
    { issuer: "https://evil.example" },
    { token_endpoint: "http://127.0.0.1/token" },
    { code_challenge_methods_supported: ["plain"] },
  ])
    await assert.rejects(
      discover(input, (async () =>
        Response.json({
          issuer,
          authorization_endpoint: issuer + "/a",
          token_endpoint: issuer + "/t",
          jwks_uri: issuer + "/j",
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          ...override,
        })) as typeof fetch),
    );
});
test("OIDC creates ordinary passwordless account, consumes callback and never stores provider tokens", async () => {
  const f = await setup();
  assert.equal(f.provider.configured_secret, true);
  assert.equal(f.provider.secret, undefined);
  assert.ok(
    !String(
      f.db.prepare("SELECT secret FROM oidc_providers").get()!.secret,
    ).includes(secret),
  );
  await f.start();
  assert.equal((await f.callback()).headers.get("location"), "/login/oidc");
  const r = await f.req(
    "/api/auth/oidc/complete",
    "POST",
    { username: "federated" },
    false,
    201,
  );
  assert.match(r.headers.get("set-cookie")!, /onestorage_session=/);
  const user = f.db
    .prepare("SELECT * FROM users WHERE username='federated'")
    .get()!;
  assert.equal(user.admin, 0);
  assert.equal(user.has_password, 0);
  assert.equal(f.db.prepare("SELECT count(*) n FROM oidc_flows").get()!.n, 0);
  assert.equal(
    f.db
      .prepare("SELECT oidc_provider_id FROM credentials WHERE user_id=?")
      .get(user.id)!.oidc_provider_id,
    f.provider.id,
  );
  assert.equal(
    (await f.callback()).headers.get("location"),
    "/login?oidc_error=failed",
  );
});
test("OIDC state is bound to browser and cannot be replayed or used for login CSRF", async () => {
  const f = await setup();
  await f.start();
  const cookie = f.getCookie();
  f.setCookie("onestorage_oidc=attacker");
  assert.equal(
    (await f.callback()).headers.get("location"),
    "/login?oidc_error=failed",
  );
  assert.equal(f.getDownloads(), 1);
  f.setCookie(cookie);
  assert.equal((await f.callback()).headers.get("location"), "/login/oidc");
  assert.equal(
    (await f.callback()).headers.get("location"),
    "/login?oidc_error=failed",
  );
  await f.req(
    "/api/auth/oidc/" + f.provider.id + "/start",
    "POST",
    {},
    false,
    403,
    { Origin: "https://attacker.example" },
  );
});
test("OIDC token nonce/audience/issuer/azp mismatches fail without issuing a session", async () => {
  for (const claims of [
    { nonce: "wrong" },
    { aud: "other" },
    { iss: "https://evil.example" },
    { aud: ["client", "other"] },
    { azp: "other" },
  ]) {
    const f = await setup();
    f.setClaims(claims);
    await f.start();
    assert.equal(
      (await f.callback()).headers.get("location"),
      "/login?oidc_error=failed",
    );
    assert.equal(
      f.db
        .prepare(
          "SELECT count(*) n FROM credentials WHERE oidc_provider_id IS NOT NULL",
        )
        .get()!.n,
      0,
    );
  }
});
test("OIDC link requires local proof and never merges accounts by suggested username", async () => {
  const f = await setup();
  await f.req(
    "/api/auth/oidc/" + f.provider.id + "/start",
    "POST",
    { mode: "link", password: "wrong" },
    true,
    403,
  );
  await f.start("link");
  assert.equal(
    (await f.callback()).headers.get("location"),
    "/settings/account",
  );
  assert.equal(
    f.db.prepare("SELECT user_id FROM oidc_identities").get()!.user_id,
    "o",
  );
  await f.start();
  assert.equal((await f.callback()).headers.get("location"), "/");
  const identity = f.db.prepare("SELECT id FROM oidc_identities").get()!.id;
  await f.req(
    "/api/account/identities/" + identity + "/unlink",
    "POST",
    { password },
    true,
  );
  assert.equal(
    f.db
      .prepare(
        "SELECT count(*) n FROM credentials WHERE oidc_provider_id IS NOT NULL",
      )
      .get()!.n,
    0,
  );
});
test("OIDC honors local MFA, password epochs and provider revision", async () => {
  const f = await setup();
  await f.start("link");
  await f.callback();
  const mfaSecret = "JBSWY3DPEHPK3PXP";
  f.db
    .prepare(
      "INSERT INTO user_mfa(user_id,version,secret,enabled,expires_at,last_counter) VALUES('o','mfa',?,1,?, -1)",
    )
    .run(await seal(f.env, "mfa:o:mfa", mfaSecret), Date.now() + 600000);
  await f.start();
  assert.equal((await f.callback()).headers.get("location"), "/login/oidc");
  assert.equal(
    ((await (await f.req("/api/auth/oidc/pending")).json()) as any).stage,
    "mfa",
  );
  await f.req(
    "/api/auth/oidc/complete",
    "POST",
    { otp: "invalid" },
    false,
    401,
  );
  f.db.prepare("UPDATE users SET password='changed' WHERE id='o'").run();
  await f.req(
    "/api/auth/oidc/complete",
    "POST",
    { otp: await hotp(mfaSecret, Math.floor(Date.now() / 30000)) },
    false,
    409,
  );
  const g = await setup();
  await g.start();
  await g.req(
    "/api/admin/identity-providers/" + g.provider.id,
    "PUT",
    { ...g.config, revision: 1, enabled: false },
    true,
  );
  assert.equal(
    (await g.callback()).headers.get("location"),
    "/login?oidc_error=failed",
  );
});

test("OIDC domain policy requires a verified exact domain and does not link matching emails", async () => {
  for (const claims of [
    { email: "owner@example.com", email_verified: false },
    { email: "owner@evil.example.com", email_verified: true },
    { email: "owner@example.com", email_verified: true },
  ]) {
    const f = await setup();
    await f.req(
      "/api/admin/identity-providers/" + f.provider.id,
      "PUT",
      { ...f.config, revision: 1, email_domains: ["example.com"] },
      true,
    );
    f.setClaims(claims);
    await f.start();
    assert.equal(
      (await f.callback()).headers.get("location"),
      claims.email_verified && claims.email === "owner@example.com"
        ? "/login/oidc"
        : "/login?oidc_error=failed",
    );
    assert.equal(
      f.db.prepare("SELECT count(*) n FROM oidc_identities").get()!.n,
      0,
    );
  }
});
test("OIDC checks account disablement, flow expiry and changed MFA at callback", async () => {
  for (const mode of ["disabled", "expired", "mfa"]) {
    const f = await setup();
    if (mode === "disabled") {
      await f.start("link");
      await f.callback();
      await f.start();
      f.db.prepare("UPDATE users SET disabled=1 WHERE id='o'").run();
    } else {
      await f.start("link");
      if (mode === "expired")
        f.db.prepare("UPDATE oidc_flows SET expires_at=0").run();
      else
        f.db
          .prepare(
            "INSERT INTO user_mfa(user_id,version,secret,enabled,expires_at,last_counter) VALUES('o','new','unused',1,0,-1)",
          )
          .run();
    }
    assert.equal(
      (await f.callback()).headers.get("location"),
      "/login?oidc_error=failed",
    );
    assert.equal(
      f.db
        .prepare(
          "SELECT count(*) n FROM credentials WHERE oidc_provider_id IS NOT NULL",
        )
        .get()!.n,
      0,
    );
    if (mode !== "disabled")
      assert.equal(
        f.db.prepare("SELECT count(*) n FROM oidc_identities").get()!.n,
        0,
      );
  }
});
test("OIDC discovery cannot publish configuration after administrator revocation", async () => {
  for (const mode of ["create", "update", "credential"]) {
    const f = await setup();
    f.setDiscoveryHook(() => {
      if (mode === "credential")
        f.db.prepare("DELETE FROM credentials WHERE hash='admin'").run();
      else f.db.prepare("UPDATE users SET admin=0 WHERE id='o'").run();
    });
    await f.req(
      "/api/admin/identity-providers" +
        (mode === "create" ? "" : "/" + f.provider.id),
      mode === "create" ? "POST" : "PUT",
      { ...f.config, ...(mode === "create" ? {} : { revision: 1 }) },
      true,
      409,
    );
    assert.equal(
      f.db.prepare("SELECT count(*) n FROM oidc_providers").get()!.n,
      1,
    );
    assert.equal(
      f.db.prepare("SELECT revision FROM oidc_providers").get()!.revision,
      1,
    );
  }
});
test("OIDC reauthentication rotates the original session and provider updates revoke only provenance credentials", async () => {
  const f = await setup();
  await f.start("link");
  await f.callback();
  await f.start("reauth");
  assert.equal((await f.callback()).headers.get("location"), "/");
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM credentials WHERE hash='admin'").get()!
      .n,
    0,
  );
  f.db
    .prepare(
      "INSERT INTO credentials(hash,id,user_id,name,kind,expires_at) VALUES('local','local','o','local','pat',?)",
    )
    .run(Date.now() + 600000);
  f.db
    .prepare(
      "INSERT INTO credentials(hash,id,user_id,name,kind,expires_at,oidc_provider_id) VALUES('oidc-pat','oidc-pat','o','oidc','pat',?,?)",
    )
    .run(Date.now() + 600000, f.provider.id);
  f.db.prepare("UPDATE oidc_providers SET enabled=0").run();
  assert.equal(
    f.db
      .prepare(
        "SELECT count(*) n FROM credentials WHERE oidc_provider_id IS NOT NULL",
      )
      .get()!.n,
    0,
  );
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM credentials WHERE hash='local'").get()!
      .n,
    1,
  );
});
test("OIDC registration can resume after account insertion without creating another user", async () => {
  const f = await setup();
  await f.start();
  await f.callback();
  f.db
    .prepare(
      "INSERT INTO users(id,username,password,has_password) VALUES('resumed','resumed','unknown',0)",
    )
    .run();
  f.db
    .prepare(
      "INSERT INTO oidc_identities(id,provider_id,subject,user_id) VALUES('resumed',?,'subject-one','resumed')",
    )
    .run(f.provider.id);
  f.db.prepare("UPDATE oidc_flows SET user_id='resumed',auth_epoch=0").run();
  const r = await f.req(
    "/api/auth/oidc/complete",
    "POST",
    { username: "ignored" },
    false,
    201,
  );
  assert.match(r.headers.get("set-cookie")!, /onestorage_session=/);
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM users WHERE username='ignored'").get()!
      .n,
    0,
  );
});
