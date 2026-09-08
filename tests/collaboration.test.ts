import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { reviewGate, protectRefs } from "../src/review";
import { modulesFor, saveCloudOutput, cloudStep } from "../src/cloud-ci";
import { pipelineSchema } from "../src/ci";
import type { Env, Repo } from "../src/types";
function fixture() {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync("migrations").sort())
    db.exec(readFileSync("migrations/" + f, "utf8"));
  db.exec(
    "INSERT INTO users(id,username,password) VALUES('o','owner','x'),('a','author','x'),('d','dev','x');INSERT INTO repositories(id,owner_id,namespace,name,visibility) VALUES('r','o','owner','repo','private');INSERT INTO members VALUES('r','a','developer'),('r','d','developer');INSERT INTO merge_requests(id,repo_id,author_id,title,source,target,source_sha,target_sha) VALUES(1,'r','a','MR','feature','main','src','dst');INSERT INTO branch_protections VALUES('r','main',1,1,1);",
  );
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
        async run() {
          return { meta: db.prepare(sql).run(...values) };
        },
      };
    },
    async batch(statements: any[]) {
      db.exec("BEGIN");
      try {
        const result = [];
        for (const s of statements) result.push(await s.run());
        db.exec("COMMIT");
        return result;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
  const objects = new Map<string, string>();
  const env = {
    DB,
    OBJECTS: {
      put: async (k: string, v: string) => {
        objects.set(k, v);
      },
      delete: async (k: string) => {
        objects.delete(k);
      },
    },
  } as unknown as Env;
  const repo = db
      .prepare("SELECT * FROM repositories WHERE id='r'")
      .get() as unknown as Repo,
    mr = db.prepare("SELECT * FROM merge_requests").get();
  return { env, repo, mr, db, objects };
}
test("review gate binds approvals to both commits, respects changes requests and immediately revokes removed reviewers", async () => {
  const { env, repo, mr, db } = fixture();
  assert.equal((await reviewGate(env, repo, mr)).allowed, false);
  db.exec(
    "INSERT INTO merge_reviews(mr_id,user_id,source_sha,target_sha,verdict) VALUES(1,'d','src','dst','approve');INSERT INTO ci_runs(id,repo_id,ref,sha,config,trigger,status) VALUES('c','r','feature','src','{}','manual','succeeded')",
  );
  assert.equal((await reviewGate(env, repo, mr)).allowed, true);
  assert.equal(
    (await reviewGate(env, repo, { ...mr, target_sha: "new" })).allowed,
    false,
  );
  db.exec(
    "INSERT INTO merge_reviews(mr_id,user_id,source_sha,target_sha,verdict) VALUES(1,'d','src','dst','changes')",
  );
  assert.equal((await reviewGate(env, repo, mr)).allowed, false);
  db.exec(
    "INSERT INTO merge_reviews(mr_id,user_id,source_sha,target_sha,verdict) VALUES(1,'d','src','dst','approve');DELETE FROM members WHERE user_id='d'",
  );
  assert.equal((await reviewGate(env, repo, mr)).approvals, 0);
});
test("protected refs reject direct push, delete and force, even when a caller otherwise has write access", async () => {
  const { env, repo, db } = fixture(),
    store = { ancestor: async () => false } as any;
  await assert.rejects(
    protectRefs(env, repo, store, { "refs/heads/main": "old" }, {}),
    /deleted/,
  );
  await assert.rejects(
    protectRefs(
      env,
      repo,
      store,
      { "refs/heads/main": "old" },
      { "refs/heads/main": "new" },
    ),
    /force push/,
  );
  store.ancestor = async () => true;
  await assert.rejects(
    protectRefs(
      env,
      repo,
      store,
      { "refs/heads/main": "old" },
      { "refs/heads/main": "new" },
    ),
    /reviewed merge/,
  );
  await protectRefs(
    env,
    repo,
    store,
    { "refs/heads/main": "old" },
    { "refs/heads/main": "old", "refs/heads/topic": "new" },
  );
});
test("cloud modules preserve WASM bytes and reject reserved/traversal paths and incompatible runner modes", () => {
  assert.throws(() =>
    cloudStep.parse({
      type: "javascript",
      entry: "../main.js",
      files: ["main.js"],
    }),
  );
  assert.throws(() =>
    modulesFor({ "__onestorage_ci.js": { content: "host override" } }),
  );
  assert.throws(() =>
    pipelineSchema.parse({
      runner: "external",
      steps: [{ type: "javascript", entry: "ci.js", files: ["ci.js"] }],
    }),
  );
  const modules = modulesFor({
    "answer.wasm": { content: "AGFzbQEAAAA=", binary: true },
  });
  assert.deepEqual(
    Array.from((modules["answer.wasm"] as any).wasm),
    [0, 97, 115, 109, 1, 0, 0, 0],
  );
});
test("cloud outputs publish atomically and canceled leases cannot retain artifacts or succeed", async () => {
  const { env, repo, db, objects } = fixture();
  db.exec(
    "INSERT INTO ci_runs(id,repo_id,ref,sha,config,trigger,status,lease_hash,lease_until) VALUES('c','r','main','abc','{}','manual','running','hash',9999999999999)",
  );
  let run = db.prepare("SELECT * FROM ci_runs WHERE id='c'").get() as any;
  await saveCloudOutput(env, repo, run, { "result.txt": { content: "built" } });
  assert.equal(
    db.prepare("SELECT status FROM ci_runs WHERE id='c'").get()!.status,
    "succeeded",
  );
  assert.equal(db.prepare("SELECT COUNT(*) n FROM ci_artifacts").get()!.n, 1);
  assert.equal(objects.size, 1);
  db.exec(
    "INSERT INTO ci_runs(id,repo_id,ref,sha,config,trigger,status,lease_hash,lease_until) VALUES('x','r','main','abc','{}','manual','canceled',NULL,9999999999999)",
  );
  run = db.prepare("SELECT * FROM ci_runs WHERE id='x'").get() as any;
  await saveCloudOutput(
    env,
    repo,
    { ...run, lease_hash: "old" },
    { "no.txt": { content: "must not exist" } },
  );
  assert.equal(objects.size, 1);
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM ci_artifacts WHERE run_id='x'").get()!.n,
    0,
  );
});
test("wiki version history is transactional and independent of the mutable page, and watches produce notifications", () => {
  const { db } = fixture();
  db.exec(
    "INSERT INTO wiki_pages VALUES('r','guide','Guide','old',1,'a',datetime('now'));UPDATE wiki_pages SET body='new',version=2 WHERE repo_id='r';INSERT INTO repository_watches VALUES('r','d');INSERT INTO audit(repo_id,actor_id,action,detail) VALUES('r','a','wiki.update','guide')",
  );
  assert.equal(
    db.prepare("SELECT body FROM wiki_history WHERE version=1").get()!.body,
    "old",
  );
  assert.equal(
    db.prepare("SELECT user_id FROM notifications").get()!.user_id,
    "d",
  );
});
import gateway from "../src/apps-gateway";
test("application gateway requires explicit publication and strips credentials and cookies across the isolated origin", async () => {
  const { env, db } = fixture(),
    rid = "11111111-1111-4111-8111-111111111111";
  db.exec(
    `INSERT INTO repositories(id,owner_id,namespace,name,visibility) VALUES('${rid}','o','owner','app','private');INSERT INTO ci_runs(id,repo_id,ref,sha,config,trigger,status) VALUES('job','${rid}','main','sha','{}','manual','succeeded');INSERT INTO deployments(id,repo_id,run_id,environment,sha,object_key) VALUES('deploy','${rid}','job','production','sha','bundle');INSERT INTO environments(repo_id,name,deployment_id,public) VALUES('${rid}','production','deploy',0)`,
  );
  const url = "https://apps.example/apps/" + rid + "/production/hello";
  assert.equal((await gateway.fetch(new Request(url), env)).status, 404);
  db.exec("UPDATE environments SET public=1");
  env.OBJECTS = {
    get: async () => ({
      json: async () => ({
        kind: "worker",
        entry: "index.js",
        files: { "index.js": { content: "export default {}" } },
      }),
    }),
  } as any;
  env.LOADER = {
    get: (_id: any, getCode: any) => {
      const code = getCode();
      assert.equal(code.globalOutbound, null);
      assert.equal(code.env, undefined);
      return {
        getEntrypoint: () => ({
          fetch: async (r: Request) => {
            assert.equal(new URL(r.url).pathname, "/hello");
            assert.equal(r.headers.get("authorization"), null);
            assert.equal(r.headers.get("cookie"), null);
            return new Response("hello", {
              headers: { "set-cookie": "bad=1" },
            });
          },
        }),
      };
    },
  } as any;
  const r = await gateway.fetch(
    new Request(url, {
      headers: { authorization: "Bearer never-pass", cookie: "session=secret" },
    }),
    env,
  );
  assert.equal(await r.text(), "hello");
  assert.equal(r.headers.get("set-cookie"), null);
  assert.match(r.headers.get("content-security-policy")!, /sandbox/);
  db.prepare(
    "UPDATE repositories SET deleted_at=datetime('now') WHERE id=?",
  ).run(rid);
  assert.equal((await gateway.fetch(new Request(url), env)).status, 404);
});

test("comment pagination cannot hide an unresolved changes request", async () => {
  const { env, repo, mr, db } = fixture();
  db.exec(
    "UPDATE branch_protections SET approvals=0,require_ci=0;INSERT INTO merge_reviews(mr_id,user_id,source_sha,target_sha,verdict) VALUES(1,'d','src','dst','changes')",
  );
  const insert = db.prepare(
    "INSERT INTO merge_reviews(mr_id,user_id,source_sha,target_sha,verdict) VALUES(1,'a','src','dst','comment')",
  );
  for (let i = 0; i < 201; i++) insert.run();
  const gate = await reviewGate(env, repo, mr);
  assert.equal(gate.reviews.length, 200);
  assert.equal(gate.changes, 1);
  assert.equal(gate.allowed, false);
});
