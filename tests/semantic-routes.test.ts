import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import type { App } from "../src/types";
import { fixture } from "./support/review-fixture";
import { registerSemanticRoutes } from "../src/semantic-routes";
test("semantic administration rejects ordinary, revoked and read-only credentials", async () => {
  const f = fixture();
  f.db.exec(
    "INSERT INTO credentials(id,hash,user_id,name,kind,scope,expires_at) VALUES('o','token','o','test','pat','write',9999999999999)",
  );
  const app = new Hono<App>();
  app.use("*", async (c, next) => {
    c.set("user", { id: "o", username: "owner", admin: 1 });
    c.set("credential", "token");
    await next();
  });
  registerSemanticRoutes(app);
  const req = (path = "", method = "GET", body?: any) =>
    app.request(
      "/api/admin/semantic" + path,
      {
        method,
        ...(body
          ? {
              body: JSON.stringify(body),
              headers: { "Content-Type": "application/json" },
            }
          : {}),
      },
      f.env,
      { waitUntil() {} } as any,
    );
  assert.equal((await req()).status, 403);
  f.db.exec("UPDATE users SET admin=1 WHERE id='o'");
  assert.equal((await req()).status, 200);
  assert.equal(
    (await req("", "PATCH", { enabled: false, daily_chars: 4000 })).status,
    200,
  );
  assert.equal(
    f.db.prepare("SELECT enabled FROM semantic_settings").get()!.enabled,
    0,
  );
  f.db.exec("UPDATE credentials SET scope='read'");
  assert.equal(
    (await req("", "PATCH", { enabled: true, daily_chars: 4000 })).status,
    403,
  );
  assert.equal((await req("/rebuild", "POST", { repo_id: "r" })).status, 403);
  f.db.exec("UPDATE credentials SET scope='write'");
  assert.equal((await req("/rebuild", "POST", { repo_id: "r" })).status, 202);
  assert.equal(
    f.db
      .prepare("SELECT count(*) AS n FROM audit WHERE action LIKE 'semantic.%'")
      .get()!.n,
    2,
  );
  f.db.exec("DELETE FROM credentials");
  assert.equal((await req()).status, 403);
  f.db.close();
});
test("administrator demotion during a mutation cannot change budgets or emit audit records", async () => {
  const f = fixture();
  f.db.exec(
    "UPDATE users SET admin=1 WHERE id IN('o','a');INSERT INTO credentials(id,hash,user_id,name,kind,scope,expires_at) VALUES('o','token','o','test','pat','write',9999999999999)",
  );
  const app = new Hono<App>();
  app.use("*", async (c, next) => {
    c.set("user", { id: "o", username: "owner", admin: 1 });
    c.set("credential", "token");
    await next();
  });
  registerSemanticRoutes(app);
  const batch = f.env.DB.batch.bind(f.env.DB);
  f.env.DB.batch = (async (statements) => {
    f.db.exec("UPDATE users SET admin=0 WHERE id='o'");
    return batch(statements);
  }) as typeof f.env.DB.batch;
  const response = await app.request(
    "/api/admin/semantic",
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false, daily_chars: 1000 }),
    },
    f.env,
    { waitUntil() {} } as any,
  );
  assert.equal(response.status, 403);
  assert.equal(
    f.db.prepare("SELECT enabled FROM semantic_settings").get()!.enabled,
    1,
  );
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM audit").get()!.n, 0);
  f.db.close();
});
