import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { repositoryRole } from "../src/access";
import {
  pipelineSchema,
  enqueueRun,
  claimRun,
  triggerPush,
  publishCI,
  consumeCI,
} from "../src/ci";
import type { Env, Repo } from "../src/types";
function fixture() {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync("migrations").sort())
    db.exec(readFileSync("migrations/" + f, "utf8"));
  db.exec(
    "INSERT INTO users(id,username,password,admin) VALUES('owner','owner','hash',1),('dev','dev','hash',0),('reader','reader','hash',0); INSERT INTO workspaces(id,slug,name) VALUES('w','team','Team'); INSERT INTO workspace_members VALUES('w','owner','owner'),('w','dev','developer'); INSERT INTO repositories(id,owner_id,namespace,name,visibility,workspace_id) VALUES('repo','dev','team','repo','private','w');",
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
  };
  const messages: any[] = [];
  const env = {
    DB,
    EVENTS: {
      async send(v: any) {
        messages.push(v);
      },
    },
    REPOSITORIES: {
      idFromName: (x: string) => x,
      get: () => ({
        fetch: async () =>
          Response.json({ content: '{"ok":true}', binary: false }),
      }),
    },
  } as unknown as Env;
  const repo = db
    .prepare("SELECT * FROM repositories WHERE id='repo'")
    .get() as unknown as Repo;
  return { db, env, repo, messages };
}
test("workspace inheritance replaces creator ownership and revocation takes effect on the next lookup", async () => {
  const { db, env, repo } = fixture(),
    dev = { id: "dev", username: "dev", admin: 0 };
  assert.equal(await repositoryRole(env, repo, dev), "developer");
  db.exec("DELETE FROM workspace_members WHERE user_id='dev'");
  assert.equal(await repositoryRole(env, repo, dev), "guest");
  db.exec("INSERT INTO members VALUES('repo','dev','reader')");
  assert.equal(await repositoryRole(env, repo, dev), "reader");
  db.exec("INSERT INTO workspace_members VALUES('w','dev','maintainer')");
  assert.equal(await repositoryRole(env, repo, dev), "maintainer");
  assert.throws(
    () => db.exec("DELETE FROM workspace_members WHERE user_id='owner'"),
    /owner/,
  );
  assert.throws(
    () => db.exec("UPDATE users SET disabled=1 WHERE id='owner'"),
    /administrator/,
  );
  assert.throws(
    () =>
      db.exec(
        "INSERT INTO users VALUES('x','team','hash',0,datetime('now'),0)",
      ),
    /Namespace/,
  );
});
test("pipeline validates runtime boundaries and unsafe paths", () => {
  assert.throws(() =>
    pipelineSchema.parse({
      runner: "worker",
      steps: [{ type: "run", name: "shell", command: "echo hi" }],
    }),
  );
  assert.throws(() =>
    pipelineSchema.parse({
      runner: "worker",
      steps: [{ type: "file", path: "../../secret" }],
    }),
  );
  assert.throws(() =>
    pipelineSchema.parse({
      runner: "external",
      steps: [{ type: "run", name: "x", command: "true" }],
      artifacts: ["/etc/passwd"],
    }),
  );
});
test("CI push projection is idempotent; claim is exclusive and timeout never repeats a deployment", async () => {
  const { db, env, repo } = fixture(),
    config = pipelineSchema.parse({
      runner: "external",
      steps: [{ type: "run", name: "test", command: "npm test" }],
    });
  db.prepare("INSERT INTO ci_pipelines(repo_id,config) VALUES(?,?)").run(
    repo.id,
    JSON.stringify(config),
  );
  const event = {
    id: "push-one",
    event: "push",
    repository_id: repo.id,
    ref: "refs/heads/main",
    after: "a".repeat(40),
  };
  await triggerPush(env, event);
  await triggerPush(env, event);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ci_runs").get()!.n, 1);
  await triggerPush(env, {
    ...event,
    id: "ephemeral",
    ref: "refs/namespaces/ephemeral/refs/heads/main",
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ci_runs").get()!.n, 1);
  const [a, b] = await Promise.all([
    claimRun(env, repo.id, "runner-a", "external"),
    claimRun(env, repo.id, "runner-b", "external"),
  ]);
  assert.equal(Number(!!a) + Number(!!b), 1);
  db.exec("UPDATE ci_runs SET lease_until=0");
  await publishCI(env);
  assert.equal(
    db.prepare("SELECT status FROM ci_runs").get()!.status,
    "failed",
  );
  assert.equal(await claimRun(env, repo.id, "runner-a", "external"), null);
});
test("Worker pipeline validates actual source data; queued cancellation prevents execution", async () => {
  const { db, env, repo, messages } = fixture(),
    config = pipelineSchema.parse({
      runner: "worker",
      steps: [{ type: "file", path: "package.json", format: "json" }],
    });
  const created = await enqueueRun(
    env,
    repo,
    "main",
    "a".repeat(40),
    config,
    "manual",
    "owner",
  );
  assert.equal(messages[0].id, "ci:" + created!.id);
  await consumeCI(env, created!.id);
  assert.equal(
    db.prepare("SELECT status FROM ci_runs WHERE id=?").get(created!.id)!
      .status,
    "succeeded",
  );
  assert.match(
    String(db.prepare("SELECT content FROM ci_logs").get()!.content),
    /PASS/,
  );
  const canceled = await enqueueRun(
    env,
    repo,
    "main",
    "a".repeat(40),
    config,
    "manual",
    "owner",
  );
  db.prepare("UPDATE ci_runs SET status='canceled' WHERE id=?").run(
    canceled!.id,
  );
  await consumeCI(env, canceled!.id);
  assert.equal(
    db.prepare("SELECT status FROM ci_runs WHERE id=?").get(canceled!.id)!
      .status,
    "canceled",
  );
});
test("highlight escapes hostile source and falls back for unknown or oversized files", async () => {
  const { highlightCode } = await import("../src/browser/highlight.js");
  assert.match(
    highlightCode('const x = "<script>alert(1)</script>";', "x.js")!,
    /hljs-keyword/,
  );
  assert.ok(
    !highlightCode('const x = "<script>alert(1)</script>";', "x.js")!.includes(
      "<script>",
    ),
  );
  assert.equal(highlightCode("abc", "unknown.xyz"), null);
  assert.equal(highlightCode("a".repeat(200001), "file.js"), null);
});
test("failed CI queue publication retains a runnable outbox entry for cron", async () => {
  const { env, repo, db } = fixture();
  env.EVENTS = {
    send: async () => {
      throw Error("queue unavailable");
    },
  } as any;
  const config = pipelineSchema.parse({
    runner: "worker",
    steps: [{ type: "file", path: "package.json", format: "json" }],
  });
  const created = await enqueueRun(
    env,
    repo,
    "main",
    "b".repeat(40),
    config,
    "manual",
    "owner",
  );
  assert.equal(
    db.prepare("SELECT status FROM ci_runs WHERE id=?").get(created!.id)!
      .status,
    "queued",
  );
  const messages: any[] = [];
  env.EVENTS = {
    send: async (value: any) => {
      messages.push(value);
    },
  } as any;
  await publishCI(env);
  assert.deepEqual(messages, [{ id: "ci:" + created!.id }]);
  await consumeCI(env, created!.id);
  assert.equal(
    db.prepare("SELECT status FROM ci_runs WHERE id=?").get(created!.id)!
      .status,
    "succeeded",
  );
});
