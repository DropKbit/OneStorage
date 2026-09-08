import test from "node:test";
import assert from "node:assert/strict";
import { accountFixture } from "./support/account-fixture";
import { digest, verifyPassword } from "../src/security";
import { hotp } from "../src/totp";

const path = "/account/password-recovery";
const nextPassword = "next-recovery-password-123";
test("browser-only key management, cross-origin refusal, SSO-only refusal and administrator revocation", async () => {
  const f = await accountFixture();
  const token = (await f.req("/tokens", "POST", { name: "test" })).data.token;
  const headers = { Authorization: `Bearer ${token}` };
  assert.equal((await f.req(path, "GET", undefined, "", headers)).status, 403);
  assert.equal(
    (
      await f.req(
        path,
        "PUT",
        { password: f.password, version: null },
        "",
        headers,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.req(
        "/recover-password",
        "POST",
        { username: "person", key: "a".repeat(64), new_password: nextPassword },
        "",
        headers,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.req(
        "/recover-password",
        "POST",
        { username: "person", key: "a".repeat(64), new_password: nextPassword },
        "",
        { Origin: "https://other.example" },
      )
    ).status,
    403,
  );
  const key = await f.req(path, "PUT", { password: f.password, version: null });
  assert.equal(key.status, 200);
  assert.equal(
    (await f.req("/admin/users/u", "PATCH", { revoke_sessions: true })).status,
    200,
  );
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM password_recovery").get()!.n,
    0,
  );
  const s = await accountFixture();
  s.db.exec(
    "INSERT INTO oidc_providers(id,name,issuer,client_id,config,enabled) VALUES('provider','SSO','https://id.example','client','{}',1)",
  );
  s.db
    .prepare(
      "UPDATE credentials SET oidc_provider_id='provider',authenticated_at=?",
    )
    .run(Date.now());
  s.db.exec("UPDATE users SET has_password=0 WHERE id='u'");
  assert.equal(
    (await s.req(path, "PUT", { password: "", version: null })).status,
    409,
  );
  assert.equal(
    s.db.prepare("SELECT count(*) n FROM password_recovery").get()!.n,
    0,
  );
});
test("saved recovery keys are hashed, versioned, secret-once, revocable and audited transactionally", async () => {
  const f = await accountFixture();
  assert.equal((await f.req(path, "GET", undefined, "")).status, 403);
  assert.equal((await f.req(path)).data.enabled, false);
  assert.equal(
    (await f.req(path, "PUT", { password: "wrong", version: null })).status,
    403,
  );
  const a = await f.req(path, "PUT", { password: f.password, version: null });
  assert.equal(a.status, 200, JSON.stringify(a));
  assert.match(a.data.key, /^osr_[a-f0-9]{8}(?:-[a-f0-9]{8}){7}$/);
  const stored = f.db.prepare("SELECT * FROM password_recovery").get()!;
  assert.notEqual(
    stored.hash,
    a.data.key.replace(/^osr_/, "").replaceAll("-", ""),
  );
  assert.equal(
    Number(stored.expires_at) - Number(stored.created_at),
    365 * 86400000,
  );
  const status = await f.req(path);
  assert.equal(status.data.enabled, true);
  assert.equal(JSON.stringify(status.data).includes(a.data.key), false);
  assert.equal("hash" in status.data, false);
  assert.equal(
    (await f.req(path, "PUT", { password: f.password, version: null })).status,
    409,
  );
  const b = await f.req(path, "PUT", {
    password: f.password,
    version: a.data.version,
  });
  assert.equal(b.status, 200);
  assert.equal(
    (
      await f.req(
        "/recover-password",
        "POST",
        { username: "person", key: a.data.key, new_password: nextPassword },
        "",
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await f.req(path, "DELETE", {
        password: f.password,
        version: a.data.version,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.req(path, "DELETE", {
        password: f.password,
        version: b.data.version,
      })
    ).status,
    200,
  );
  assert.equal((await f.req(path)).data.enabled, false);
  assert.equal(
    (
      await f.req(
        "/recover-password",
        "POST",
        { username: "person", key: b.data.key, new_password: nextPassword },
        "",
      )
    ).status,
    401,
  );
  assert.deepEqual(
    f.db
      .prepare("SELECT action FROM audit")
      .all()
      .map((x) => x.action),
    [
      "account.password_recovery.issue",
      "account.password_recovery.issue",
      "account.password_recovery.revoke",
    ],
  );
});

test("recovery consumes one key once, revokes sessions/PAT/delegation keys and preserves historical signing identity", async () => {
  const f = await accountFixture(),
    issued = await f.req(path, "PUT", { password: f.password, version: null });
  f.db
    .prepare(
      "INSERT INTO credentials(hash,id,user_id,name,kind,expires_at) VALUES(?,'pat','u','token','pat',?)",
    )
    .run(await digest("pat"), Date.now() + 100000);
  f.db.exec(
    "INSERT INTO api_keys(id,user_id,name,algorithm,public_key) VALUES('key','u','delegation','ES256','public')",
  );
  f.db.exec(
    "INSERT INTO signing_keys(id,user_id,name,format,public_key,fingerprint) VALUES('sig','u','signing','ssh','public','fp')",
  );
  const body = {
    username: "PERSON",
    key: issued.data.key.toUpperCase(),
    new_password: nextPassword,
  };
  const results = await Promise.all([
    f.req("/recover-password", "POST", body, ""),
    f.req("/recover-password", "POST", body, ""),
  ]);
  assert.deepEqual(results.map((x) => x.status).sort(), [200, 401]);
  assert.equal(
    results.find((x) => x.status === 200)!.data.sign_in_required,
    true,
  );
  assert.equal(f.db.prepare("SELECT count(*) n FROM credentials").get()!.n, 0);
  assert.equal(f.db.prepare("SELECT count(*) n FROM api_keys").get()!.n, 0);
  assert.equal(f.db.prepare("SELECT count(*) n FROM signing_keys").get()!.n, 1);
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM password_recovery").get()!.n,
    0,
  );
  assert.equal(
    f.db
      .prepare(
        "SELECT count(*) n FROM audit WHERE action='account.password_recovery.use'",
      )
      .get()!.n,
    1,
  );
  assert.equal((await f.req("/me")).data.user, null);
  assert.equal(
    (
      await f.req(
        "/login",
        "POST",
        { username: "person", password: f.password },
        "",
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await f.req(
        "/login",
        "POST",
        { username: "person", password: nextPassword },
        "",
      )
    ).status,
    200,
  );
});

test("MFA requires a fresh second factor for issuance and recovery, keeps MFA and blocks reuse", async () => {
  const f = await accountFixture();
  const setup = (
    await f.req("/account/mfa/setup", "POST", { password: f.password })
  ).data;
  const enabled = (
    await f.req("/account/mfa/enable", "POST", {
      version: setup.version,
      otp: await hotp(setup.secret, Math.floor(Date.now() / 30000)),
    })
  ).data;
  assert.equal(
    (await f.req(path, "PUT", { password: f.password, version: null })).status,
    403,
  );
  const key = await f.req(path, "PUT", {
    password: f.password,
    version: null,
    otp: enabled.recovery_codes[0],
  });
  assert.equal(key.status, 200);
  const body = {
    username: "person",
    key: key.data.key,
    new_password: nextPassword,
  };
  assert.equal(
    (await f.req("/recover-password", "POST", body, "")).status,
    401,
  );
  assert.equal(
    (
      await f.req(
        "/recover-password",
        "POST",
        { ...body, otp: enabled.recovery_codes[0] },
        "",
      )
    ).status,
    401,
  );
  // Invalid key must not burn a valid second factor.
  assert.equal(
    (
      await f.req(
        "/recover-password",
        "POST",
        { ...body, key: "0".repeat(64), otp: enabled.recovery_codes[1] },
        "",
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await f.req(
        "/recover-password",
        "POST",
        { ...body, otp: enabled.recovery_codes[1] },
        "",
      )
    ).status,
    200,
  );
  assert.equal(f.db.prepare("SELECT enabled FROM user_mfa").get()!.enabled, 1);
  assert.equal(f.db.prepare("SELECT count(*) n FROM mfa_recovery").get()!.n, 8);
  assert.equal(
    (
      await f.req(
        "/login",
        "POST",
        { username: "person", password: nextPassword },
        "",
      )
    ).data.mfa_required,
    true,
  );
  assert.equal(
    (
      await f.req(
        "/login",
        "POST",
        {
          username: "person",
          password: nextPassword,
          otp: enabled.recovery_codes[2],
        },
        "",
      )
    ).status,
    200,
  );
});

test("expiry, disabled or passwordless accounts and old security epochs never restore access", async () => {
  for (const mutation of [
    "UPDATE password_recovery SET expires_at=0",
    "UPDATE users SET disabled=1 WHERE id='u'",
    "UPDATE users SET has_password=0 WHERE id='u'",
    "UPDATE users SET auth_epoch=auth_epoch+1 WHERE id='u'",
    "UPDATE users SET password='new-hash' WHERE id='u'",
  ]) {
    const f = await accountFixture(),
      key = (await f.req(path, "PUT", { password: f.password, version: null }))
        .data.key;
    // Last-admin protection is unrelated to recovery.
    f.db.exec(
      "INSERT INTO users(id,username,password,admin) VALUES('other','other','hash',1)",
    );
    f.db.exec(mutation);
    const r = await f.req(
      "/recover-password",
      "POST",
      { username: "person", key, new_password: nextPassword },
      "",
    );
    assert.equal(r.status, 401, mutation);
    assert.equal(
      f.db
        .prepare(
          "SELECT count(*) n FROM audit WHERE action='account.password_recovery.use'",
        )
        .get()!.n,
      0,
    );
    if (!mutation.includes("expires_at"))
      assert.equal(
        f.db.prepare("SELECT count(*) n FROM password_recovery").get()!.n,
        0,
      );
  }
});

test("in-flight issuance/recovery recheck session, epoch, key version and factor configuration at commit", async () => {
  for (const mutation of [
    "DELETE FROM credentials",
    "UPDATE users SET auth_epoch=auth_epoch+1 WHERE id='u'",
  ]) {
    const f = await accountFixture();
    f.race(() => f.db.exec(mutation));
    assert.equal(
      (await f.req(path, "PUT", { password: f.password, version: null }))
        .status,
      409,
    );
    assert.equal(
      f.db.prepare("SELECT count(*) n FROM password_recovery").get()!.n,
      0,
    );
  }
  for (const mutation of [
    "DELETE FROM password_recovery",
    "UPDATE password_recovery SET version='different'",
    "UPDATE users SET auth_epoch=auth_epoch+1 WHERE id='u'",
    "INSERT INTO user_mfa(user_id,version,secret,enabled,expires_at) VALUES('u','new','secret',1,0)",
  ]) {
    const f = await accountFixture(),
      key = (await f.req(path, "PUT", { password: f.password, version: null }))
        .data.key;
    f.race(() => f.db.exec(mutation));
    assert.equal(
      (
        await f.req(
          "/recover-password",
          "POST",
          { username: "person", key, new_password: nextPassword },
          "",
        )
      ).status,
      401,
      mutation,
    );
    assert.equal(
      await verifyPassword(
        f.password,
        String(
          f.db.prepare("SELECT password FROM users WHERE id='u'").get()!
            .password,
        ),
      ),
      true,
    );
    assert.equal(
      f.db.prepare("SELECT count(*) n FROM credentials").get()!.n,
      1,
    );
  }
});

test("audit storage failure rolls back issuance and password recovery, invalid credentials share one error and are rate limited", async () => {
  const f = await accountFixture();
  f.db.exec(
    "CREATE TRIGGER audit_failure BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT,'injected'); END",
  );
  assert.equal(
    (await f.req(path, "PUT", { password: f.password, version: null })).status,
    500,
  );
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM password_recovery").get()!.n,
    0,
  );
  f.db.exec("DROP TRIGGER audit_failure");
  const key = (
    await f.req(path, "PUT", { password: f.password, version: null })
  ).data.key;
  f.db.exec(
    "CREATE TRIGGER audit_failure BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT,'injected'); END",
  );
  assert.equal(
    (
      await f.req(
        "/recover-password",
        "POST",
        { username: "person", key, new_password: nextPassword },
        "",
      )
    ).status,
    500,
  );
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM password_recovery").get()!.n,
    1,
  );
  assert.equal(f.db.prepare("SELECT count(*) n FROM credentials").get()!.n, 1);
  assert.equal(
    await verifyPassword(
      f.password,
      String(
        f.db.prepare("SELECT password FROM users WHERE id='u'").get()!.password,
      ),
    ),
    true,
  );
  f.db.exec("DROP TRIGGER audit_failure");
  const body = { key: "a".repeat(64), new_password: nextPassword };
  const known = await f.req(
    "/recover-password",
    "POST",
    { ...body, username: "person" },
    "",
  );
  const unknown = await f.req(
    "/recover-password",
    "POST",
    { ...body, username: "missing" },
    "",
  );
  assert.equal(known.status, unknown.status);
  assert.deepEqual(known.data, unknown.data);
  for (let i = 0; i < 7; i++)
    assert.equal(
      (
        await f.req(
          "/recover-password",
          "POST",
          { ...body, username: "missing" },
          "",
        )
      ).status,
      401,
    );
  assert.equal(
    (
      await f.req(
        "/recover-password",
        "POST",
        { ...body, username: "missing" },
        "",
      )
    ).status,
    429,
  );
});
