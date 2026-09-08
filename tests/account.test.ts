import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import app from "../src/app";
import { digest, passwordHash } from "../src/security";
import { hotp, base32, decodeBase32, totpCounter } from "../src/totp";
import { consumeFactor } from "../src/account";
import { renderMarkdown } from "../src/browser/markdown.js";
import type { Env } from "../src/types";
async function fixture() {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync("migrations").sort())
    db.exec(readFileSync("migrations/" + file, "utf8"));
  const password = "fixture-password-123";
  db.prepare(
    "INSERT INTO users(id,username,password,admin) VALUES('u','person',?,1)",
  ).run(await passwordHash(password));
  db.prepare(
    "INSERT INTO credentials(hash,id,user_id,name,kind,expires_at) VALUES(?,'session-one','u','Browser','session',?)",
  ).run(await digest("fixture-session"), Date.now() + 3600000);
  const DB = {
    prepare(sql: string) {
      let values: any[] = [];
      return {
        bind(...v: any[]) {
          values = v;
          return this;
        },
        async first() {
          return db.prepare(sql).get(...values) || null;
        },
        async all() {
          return { results: db.prepare(sql).all(...values) };
        },
        execute() {
          const s = db.prepare(sql);
          if (/RETURNING/i.test(sql)) {
            const results = s.all(...values);
            return {
              results,
              meta: {
                changes: Number(db.prepare("SELECT changes() AS n").get()!.n),
              },
            };
          }
          return { results: [], meta: s.run(...values) };
        },
        async run() {
          return this.execute();
        },
      };
    },
    async batch(statements: any[]) {
      db.exec("BEGIN");
      try {
        const result = statements.map((s) => s.execute());
        db.exec("COMMIT");
        return result;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
  const env = {
      DB,
      APP_ORIGIN: "http://localhost",
      CREDENTIAL_ENCRYPTION_KEY: btoa("x".repeat(32)),
    } as unknown as Env,
    pending: Promise<any>[] = [];
  async function req(
    path: string,
    method = "GET",
    body?: unknown,
    cookie = "onestorage_session=fixture-session",
  ) {
    const r = await app.fetch(
      new Request("http://localhost/api" + path, {
        method,
        headers: {
          Origin: "http://localhost",
          Cookie: cookie,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
      env,
      {
        waitUntil(p: Promise<any>) {
          pending.push(p);
        },
        passThroughOnException() {},
      } as any,
    );
    await Promise.all(pending.splice(0));
    const data = (await r.json()) as any;
    return {
      status: r.status,
      data,
      cookie: r.headers.get("set-cookie")?.split(";")[0] || "",
    };
  }
  return { db, env, req, password };
}
test("RFC 4226/6238 SHA-1 vectors and bounded monotonic TOTP window", async () => {
  const secret = base32(new TextEncoder().encode("12345678901234567890"));
  assert.equal(
    new TextDecoder().decode(decodeBase32(secret)),
    "12345678901234567890",
  );
  for (const [counter, value] of [
    "755224",
    "287082",
    "359152",
    "969429",
    "338314",
    "254676",
    "287922",
    "162583",
    "399871",
    "520489",
  ].entries())
    assert.equal(await hotp(secret, counter), value);
  for (const [time, value] of [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ] as const)
    assert.equal(await hotp(secret, Math.floor(time / 30), 8), value);
  const code = await hotp(secret, 100);
  assert.equal(await totpCounter(secret, code, -1, 100 * 30000), 100);
  assert.equal(await totpCounter(secret, code, 100, 100 * 30000), null);
  assert.equal(await totpCounter(secret, code, -1, 103 * 30000), null);
});
test("2FA enrollment verifies possession, revokes other sessions, encrypts seeds and consumes recovery codes once under concurrency", async () => {
  const { db, env, req, password } = await fixture();
  const old = await req("/login", "POST", { username: "person", password }, "");
  assert.equal(old.status, 200);
  const setup = await req("/account/mfa/setup", "POST", { password });
  assert.equal(setup.status, 200);
  assert.ok(
    !String(db.prepare("SELECT secret FROM user_mfa").get()!.secret).includes(
      setup.data.secret,
    ),
  );
  const otp = await hotp(setup.data.secret, Math.floor(Date.now() / 30000));
  const enabled = await req("/account/mfa/enable", "POST", {
    version: setup.data.version,
    otp,
  });
  assert.equal(enabled.status, 200, JSON.stringify(enabled));
  assert.equal(enabled.data.recovery_codes.length, 10);
  assert.equal(
    (await req("/me", "GET", undefined, old.cookie)).data.user,
    null,
  );
  assert.equal(
    (await req("/login", "POST", { username: "person", password }, "")).data
      .mfa_required,
    true,
  );
  assert.equal(
    (await req("/login", "POST", { username: "person", password, otp }, ""))
      .status,
    401,
  );
  assert.equal(
    (await req("/tokens", "POST", { name: "needs-factor" })).status,
    403,
  );
  const [a, b] = await Promise.all([
    consumeFactor(env, "u", enabled.data.recovery_codes[0]),
    consumeFactor(env, "u", enabled.data.recovery_codes[0]),
  ]);
  assert.equal(Number(a) + Number(b), 1);
  const logged = await req(
    "/login",
    "POST",
    { username: "person", password, otp: enabled.data.recovery_codes[1] },
    "",
  );
  assert.equal(logged.status, 200);
  assert.equal(
    (await req("/account/security", "GET", undefined, logged.cookie)).data
      .recovery_codes_remaining,
    8,
  );
  assert.equal(
    db
      .prepare("SELECT COUNT(*) n FROM mfa_recovery WHERE hash LIKE '%-%'")
      .get()!.n,
    0,
  );
});
test("recovery rotation invalidates old codes, disable requires password plus factor, and auth changes advance the login epoch", async () => {
  const { db, env, req, password } = await fixture(),
    setup = (await req("/account/mfa/setup", "POST", { password })).data,
    enabled = await req("/account/mfa/enable", "POST", {
      version: setup.version,
      otp: await hotp(setup.secret, Math.floor(Date.now() / 30000)),
    });
  const old = enabled.data.recovery_codes;
  const rotated = await req("/account/mfa/recovery", "POST", {
    password,
    otp: old[0],
  });
  assert.equal(rotated.status, 200);
  assert.equal(await consumeFactor(env, "u", old[1]), false);
  assert.equal(
    (await req("/account/mfa/disable", "POST", { password, otp: old[2] }))
      .status,
    403,
  );
  assert.equal(
    (
      await req("/account/mfa/disable", "POST", {
        password,
        otp: rotated.data.recovery_codes[0],
      })
    ).status,
    200,
  );
  assert.equal((await req("/account/security")).data.enabled, false);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM mfa_recovery").get()!.n, 0);
  assert.equal(
    db.prepare("SELECT auth_epoch FROM users WHERE id='u'").get()!.auth_epoch,
    2,
  );
  const before = db.prepare("SELECT auth_epoch FROM users WHERE id='u'").get()!
    .auth_epoch;
  await req("/password", "POST", {
    current_password: password,
    new_password: "new-fixture-password-123",
  });
  assert.equal(
    db.prepare("SELECT auth_epoch FROM users WHERE id='u'").get()!.auth_epoch,
    Number(before) + 1,
  );
});
test("old enrollment versions, expiry, wrong passwords and PAT access cannot manage authenticators", async () => {
  const { db, req, password } = await fixture();
  assert.equal(
    (await req("/account/mfa/setup", "POST", { password: "incorrect" })).status,
    403,
  );
  const first = (await req("/account/mfa/setup", "POST", { password })).data,
    second = (await req("/account/mfa/setup", "POST", { password })).data;
  assert.equal(
    (
      await req("/account/mfa/enable", "POST", {
        version: first.version,
        otp: await hotp(first.secret, Math.floor(Date.now() / 30000)),
      })
    ).status,
    409,
  );
  db.exec("UPDATE user_mfa SET expires_at=0");
  assert.equal(
    (
      await req("/account/mfa/enable", "POST", {
        version: second.version,
        otp: "123456",
      })
    ).status,
    409,
  );
  db.exec("UPDATE credentials SET kind='pat'");
  assert.equal((await req("/account/security")).status, 403);
});
test("factor guessing is limited across sessions and IP addresses by account", async () => {
  const { db, env, req, password } = await fixture(),
    setup = (await req("/account/mfa/setup", "POST", { password })).data;
  await req("/account/mfa/enable", "POST", {
    version: setup.version,
    otp: await hotp(setup.secret, Math.floor(Date.now() / 30000)),
  });
  for (let i = 0; i < 9; i++)
    assert.equal(await consumeFactor(env, "u", "not-a-code"), false);
  await assert.rejects(consumeFactor(env, "u", "not-a-code"), /Too many/);
});
test("profiles and activity only expose repositories the current viewer can access", async () => {
  const { db, req } = await fixture();
  db.exec(
    "INSERT INTO repositories(id,owner_id,namespace,name,visibility) VALUES('p','u','person','private','private'),('o','u','person','open','public');INSERT INTO audit(repo_id,actor_id,action,detail) VALUES('p','u','issue.create','private subject'),('o','u','issue.create','public subject')",
  );
  assert.equal(
    (
      await req("/profile", "PUT", {
        display_name: "Person",
        bio: "**Hello**",
        website: "javascript:alert(1)",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await req("/profile", "PUT", {
        display_name: "Person",
        bio: "**Hello**",
        website: "https://example.com",
      })
    ).status,
    200,
  );
  const anonymous = await req("/profiles/person", "GET", undefined, "");
  assert.equal(anonymous.data.repositories.length, 1);
  assert.equal(anonymous.data.activity.length, 1);
  assert.equal(anonymous.data.activity[0].detail, "public subject");
  assert.equal((await req("/profiles/person")).data.repositories.length, 2);
  db.exec(
    "INSERT INTO users(id,username,password,admin) VALUES('other','other','hash',1);UPDATE users SET disabled=1 WHERE id='u'",
  );
  assert.equal(
    (await req("/profiles/person", "GET", undefined, "")).status,
    404,
  );
});
test("Markdown renders tables/tasks and safe relative links while rejecting script HTML, dangerous URLs and remote image fetches", () => {
  const env = {
    base: "/owner/repo",
    ref: "a".repeat(40),
    path: "docs/README.md",
  };
  const html = renderMarkdown(
    "# Heading\n\n- [x] Done\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n[File](../src/a.js)\n\n![local](pic.png)\n\n![remote](https://track.invalid/pixel.png)\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n[bad](data:text/html;base64,eA==)",
    env,
  );
  assert.match(html, /<h1 id="md-heading">/);
  assert.match(html, /<table>/);
  assert.match(html, /type="checkbox" disabled checked/);
  assert.match(html, /path=src%2Fa.js/);
  assert.match(html, /\/api\/repos\/owner\/repo\/preview\?/);
  assert.doesNotMatch(html, /<img[^>]*src="https:/);
  assert.doesNotMatch(html, /<script|href="javascript:|href="data:/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(renderMarkdown("<img src=x onerror=alert(1)>"), /<img/);
  assert.doesNotMatch(
    renderMarkdown("[bad](java&#x73;cript:alert(1))"),
    /href="javascript:/,
  );
});
test("a login cannot mint a session after its password/MFA snapshot is invalidated", async () => {
  const { db, env, req, password } = await fixture(),
    prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (sql.startsWith("INSERT INTO credentials") && sql.includes("SELECT")) {
      const run = statement.run.bind(statement);
      statement.run = async () => {
        db.exec("UPDATE users SET auth_epoch=auth_epoch+1 WHERE id='u'");
        return run();
      };
    }
    return statement;
  }) as any;
  const login = await req(
    "/login",
    "POST",
    { username: "person", password },
    "",
  );
  assert.equal(login.status, 409);
  assert.equal(login.cookie, "");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM credentials").get()!.n, 1);
});
test("enrollment cannot enable 2FA from a session revoked while the request was in flight", async () => {
  const { db, env, req, password } = await fixture(),
    setup = (await req("/account/mfa/setup", "POST", { password })).data,
    batch = env.DB.batch.bind(env.DB);
  env.DB.batch = (async (statements: any[]) => {
    db.exec("DELETE FROM credentials");
    return batch(statements);
  }) as any;
  const enabled = await req("/account/mfa/enable", "POST", {
    version: setup.version,
    otp: await hotp(setup.secret, Math.floor(Date.now() / 30000)),
  });
  assert.equal(enabled.status, 409);
  assert.equal(db.prepare("SELECT enabled FROM user_mfa").get()!.enabled, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM mfa_recovery").get()!.n, 0);
});
test("PAT creation cannot race a revoked session or changed authentication epoch", async () => {
  const { db, env, req } = await fixture(),
    prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (sql.startsWith("INSERT INTO credentials") && sql.includes("'pat'")) {
      const run = statement.run.bind(statement);
      statement.run = async () => {
        db.exec("UPDATE users SET auth_epoch=auth_epoch+1 WHERE id='u'");
        return run();
      };
    }
    return statement;
  }) as any;
  assert.equal((await req("/tokens", "POST", { name: "raced" })).status, 409);
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM credentials WHERE kind='pat'").get()!.n,
    0,
  );
});
