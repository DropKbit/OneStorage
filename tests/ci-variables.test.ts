import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support/review-fixture";
import { enqueueRun, claimRun, consumeCI, registerCIRoutes } from "../src/ci";
import { pipelineSchema } from "../src/ci-config";
import { variableSchema, variableKey } from "../src/ci-variable-schema";
import {
  loadRunVariables,
  variableContext,
  maskLogRows,
  maskRunLog,
} from "../src/ci-variables";
import { seal, unseal } from "../src/sync-config";
import { secretPatterns, redactChunks } from "../src/ci-redaction";
import { saveCloudOutput } from "../src/cloud-ci";
import { registerVariableRoutes } from "../src/ci-variable-routes";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
const secret = "test-secret-value-0123456789",
  sha = "a".repeat(40);
function setup() {
  const f = fixture();
  f.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 42).toString("base64");
  let onBranch = async () => {},
    tip = sha;
  f.env.REPOSITORIES = {
    idFromName: (id: string) => id,
    get: () => ({
      fetch: async (r: Request) => {
        if (new URL(r.url).pathname === "/branch") {
          await onBranch();
          return Response.json({ sha: tip });
        }
        return new Response("export default async ()=>({});");
      },
    }),
  } as any;
  f.env.OBJECTS.delete = (async (key: string) => {
    f.objects.delete(key);
  }) as any;
  async function variable(id = "v", options: any = {}) {
    const b = variableSchema.parse({
      key: "TEST_TOKEN",
      value: secret,
      ...options,
    });
    f.db
      .prepare(
        "INSERT INTO ci_variables(id,repo_id,owner_id,key,environment,encrypted,secret,protected,refs,enabled) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        "r",
        "o",
        b.key,
        b.environment,
        await seal(f.env, variableContext("r", id), b.value),
        Number(b.secret),
        Number(b.protected),
        JSON.stringify(b.refs),
        Number(b.enabled),
      );
    return b;
  }
  async function run(options: any = {}, trigger = "manual") {
    const config = pipelineSchema.parse({
      runner: "worker",
      variables: ["TEST_TOKEN"],
      steps: [{ type: "file", path: "README.md" }],
      ...options,
    });
    const made = await enqueueRun(
      f.env,
      f.repo,
      "main",
      sha,
      config,
      trigger,
      "o",
    );
    return (await claimRun(f.env, "r", "worker", "worker", made!.id))!.run;
  }
  return {
    ...f,
    variable,
    run,
    setBranch: (cb: () => Promise<void>) => {
      onBranch = cb;
    },
    setTip: (s: string) => {
      tip = s;
    },
    row: (id: string) =>
      f.db.prepare("SELECT * FROM ci_runs WHERE id=?").get(id)!,
  };
}
test("variable names, secret length, job selection and environment contracts reject unsafe configuration", () => {
  for (const key of [
    "HOME",
    "PATH",
    "NODE_OPTIONS",
    "GIT_ASKPASS",
    "ONESTORAGE_TOKEN",
    "LD_PRELOAD",
    "a",
    "A-B",
  ])
    assert.equal(variableKey.safeParse(key).success, false);
  assert.equal(variableKey.safeParse("CLOUDFLARE_API_TOKEN").success, true);
  assert.equal(
    variableSchema.safeParse({ key: "KEY", value: "tiny" }).success,
    false,
  );
  assert.equal(
    variableSchema.safeParse({ key: "KEY", value: "short", secret: false })
      .success,
    true,
  );
  assert.equal(
    variableSchema.safeParse({ key: "KEY", value: "nul\0value" }).success,
    false,
  );
  assert.equal(
    pipelineSchema.safeParse({
      runner: "worker",
      variables: ["KEY", "KEY"],
      steps: [{ type: "file", path: "x" }],
    }).success,
    false,
  );
  assert.equal(
    pipelineSchema.safeParse({
      runner: "worker",
      environment: "staging",
      deploy: {
        kind: "static",
        files: ["index.html"],
        entry: "index.html",
        environment: "production",
      },
      steps: [{ type: "file", path: "x" }],
    }).success,
    false,
  );
});
test("values and run snapshots are encrypted with separate AAD; environment-specific scope overrides global", async () => {
  const f = setup();
  await f.variable();
  await f.variable("production", {
    environment: "production",
    value: "production-secret-value",
  });
  const run = await f.run({ environment: "production" }),
    data = await loadRunVariables(f.env, run);
  assert.equal(data.variables.TEST_TOKEN, "production-secret-value");
  const stored = f.db.prepare("SELECT * FROM ci_run_variables").get()!;
  assert.doesNotMatch(JSON.stringify(stored), /production-secret-value/);
  assert.equal(stored.variable_id, "production");
  await assert.rejects(
    unseal(
      f.env,
      variableContext("other", "production"),
      stored.encrypted as string,
    ),
    /could not be decrypted/,
  );
  assert.deepEqual(
    (await loadRunVariables(f.env, run)).variables,
    data.variables,
  );
});
test("disabled exact environment cannot silently fall back to a different credential", async () => {
  const f = setup();
  await f.variable("fallback");
  await f.variable("production", { environment: "production", enabled: false });
  await assert.rejects(
    loadRunVariables(f.env, await f.run({ environment: "production" })),
    /unavailable/,
  );
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM ci_run_variables").get()!.n,
    0,
  );
});
test("protected values require a protected branch and current code SHA; no secret reaches MR, retry-MR, or unclassified runs", async () => {
  for (const mode of [
    "mr",
    "retry",
    "unknown",
    "head",
    "unprotected",
    "scope",
  ]) {
    const f = setup();
    await f.variable("v", mode === "scope" ? { refs: ["release"] } : {});
    const run = await f.run({}, mode === "mr" ? "merge_request" : "manual");
    if (mode === "retry") {
      f.db
        .prepare(
          "UPDATE ci_runs SET source_trigger='merge_request',trigger='retry' WHERE id=?",
        )
        .run(run.id);
      run.source_trigger = "merge_request";
    }
    if (mode === "unknown") {
      f.db
        .prepare("UPDATE ci_runs SET source_trigger=NULL WHERE id=?")
        .run(run.id);
      run.source_trigger = undefined;
    }
    if (mode === "head") f.setTip("b".repeat(40));
    if (mode === "unprotected") f.db.exec("DELETE FROM branch_protections");
    await assert.rejects(loadRunVariables(f.env, run));
    assert.equal(
      f.db.prepare("SELECT count(*) n FROM ci_run_variables").get()!.n,
      0,
      mode,
    );
  }
});
test("explicit unprotected plaintext variables can serve MR checks but still respect environment and branch scopes", async () => {
  const f = setup();
  await f.variable("plain", {
    key: "PUBLIC_LABEL",
    value: "preview",
    secret: false,
    protected: false,
    refs: ["*"],
  });
  const run = await f.run({ variables: ["PUBLIC_LABEL"] }, "merge_request");
  const loaded = await loadRunVariables(f.env, run);
  assert.equal(loaded.variables.PUBLIC_LABEL, "preview");
  assert.deepEqual(loaded.patterns, []);
});
test("value rotation, deletion, owner disable, last-maintainer removal and archive revoke leases and reject late output", async () => {
  for (const mode of [
    "rotation",
    "delete",
    "disabled",
    "role",
    "archive",
    "transfer",
    "protection",
  ]) {
    const f = setup();
    await f.variable();
    if (mode === "role")
      f.db.exec(
        "UPDATE members SET role='maintainer' WHERE user_id='a';UPDATE ci_variables SET owner_id='a'",
      );
    const run = await f.run();
    await loadRunVariables(f.env, run);
    if (mode === "rotation")
      f.db.exec("UPDATE ci_variables SET revision=revision+1");
    if (mode === "delete") f.db.exec("DELETE FROM ci_variables");
    if (mode === "disabled")
      f.db.exec("UPDATE users SET disabled=1 WHERE id='o'");
    if (mode === "role") f.db.exec("DELETE FROM members WHERE user_id='a'");
    if (mode === "archive")
      f.db.exec(
        "UPDATE repositories SET archived_at=datetime('now') WHERE id='r'",
      );
    if (mode === "transfer")
      f.db.exec("UPDATE repositories SET namespace='elsewhere' WHERE id='r'");
    if (mode === "protection") f.db.exec("DELETE FROM branch_protections");
    assert.equal(f.row(run.id).status, "canceled", mode);
    assert.equal(f.row(run.id).lease_hash, null);
    await assert.rejects(loadRunVariables(f.env, run));
    await saveCloudOutput(f.env, f.repo, run, {
      "late.txt": { content: "discard" },
    });
    assert.equal(f.objects.size, 0);
    assert.equal(
      await maskRunLog(f.env, run.id, "old " + secret),
      "old [MASKED]",
      "old mask survives rotation/deletion",
    );
  }
});
test("revoke between branch read and binding publication rolls back all values", async () => {
  const f = setup();
  await f.variable();
  await f.variable("v2", { key: "SECOND", value: "other-secret-12345" });
  const run = await f.run({ variables: ["TEST_TOKEN", "SECOND"] });
  f.setBranch(async () => {
    f.db.exec(
      "UPDATE ci_variables SET enabled=0,revision=revision+1 WHERE id='v2'",
    );
  });
  await assert.rejects(loadRunVariables(f.env, run));
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM ci_run_variables").get()!.n,
    0,
  );
});
test("a completed child variable revocation cancels its active parent and siblings", async () => {
  const f = setup();
  await f.variable();
  const config = pipelineSchema.parse({
    runner: "workflow",
    jobs: [
      {
        id: "first",
        pipeline: {
          runner: "worker",
          variables: ["TEST_TOKEN"],
          steps: [{ type: "file", path: "x" }],
        },
      },
      {
        id: "second",
        pipeline: { runner: "worker", steps: [{ type: "file", path: "x" }] },
      },
    ],
  });
  const parent = await enqueueRun(
    f.env,
    f.repo,
    "main",
    sha,
    config,
    "manual",
    "o",
  );
  await consumeCI(f.env, parent!.id);
  const child = f.db
    .prepare("SELECT id FROM ci_runs WHERE job_key='first'")
    .get()!;
  const claimed = await claimRun(
    f.env,
    "r",
    "worker",
    "worker",
    child.id as string,
  );
  await loadRunVariables(f.env, claimed!.run);
  f.db
    .prepare("UPDATE ci_runs SET status='succeeded' WHERE id=?")
    .run(child.id);
  f.db.exec("UPDATE ci_variables SET revision=revision+1");
  assert.equal(f.row(parent!.id).status, "canceled");
  assert.equal(
    f.db.prepare("SELECT status FROM ci_runs WHERE job_key='second'").get()!
      .status,
    "canceled",
  );
});
test("redaction covers transport boundaries, JSON/URL/base64 variants and bounded repetitive logs without altering nonsecrets", async () => {
  const value = 'secret" /中文xyz',
    patterns = secretPatterns([value]);
  for (const p of patterns) {
    const chunks = ["before " + p.slice(0, 4), p.slice(4) + " after"];
    assert.equal(
      redactChunks(chunks, patterns).join(""),
      "before [MASKED] after",
    );
  }
  assert.deepEqual(redactChunks(["normal", " log"], patterns), [
    "normal",
    " log",
  ]);
  assert.ok(
    !redactChunks(["a".repeat(1024 * 1024)], ["a".repeat(8)])[0].includes(
      "aaaaaaaa",
    ),
  );
  const f = setup();
  await f.variable();
  const run = await f.run();
  await loadRunVariables(f.env, run);
  const rows = await maskLogRows(f.env, run.id, [
    { seq: 0, content: secret.slice(0, 5) },
    { seq: 2, content: secret.slice(5) },
  ]);
  assert.equal(rows.map((r) => r.content).join(""), "[MASKED]");
  assert.deepEqual(
    rows.map((r) => r.seq),
    [0, 2],
  );
});
test("variable CRUD is write-only and audited atomically; stale revisions, foreign IDs and authority loss fail closed", async () => {
  const f = setup(),
    app = new Hono<any>();
  let actor = "o";
  app.use("*", async (c, next) => {
    c.set("user", { id: actor, username: actor, admin: 0 });
    await next();
  });
  app.onError((e, c) =>
    c.json({ error: e.message }, e instanceof HTTPException ? e.status : 400),
  );
  registerVariableRoutes(app, { access: async () => f.repo });
  const base = "/api/repos/owner/repo/ci/variables",
    b = { key: "TEST_TOKEN", value: secret };
  const req = (path: string, method: string, body?: unknown) =>
    app.request(
      "http://test" + base + path,
      {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      f.env,
    );
  const made = await req("", "POST", b);
  assert.equal(made.status, 201);
  const row = (await made.json()) as any;
  assert.ok(!("value" in row) && !("encrypted" in row));
  assert.doesNotMatch(await (await req("", "GET")).text(), new RegExp(secret));
  assert.equal(
    (await req("/" + row.id, "PUT", { ...b, revision: 9 })).status,
    409,
  );
  assert.equal(
    (await req("/" + row.id, "PUT", { key: "TEST_TOKEN", revision: 0 })).status,
    200,
  );
  assert.equal(
    f.db
      .prepare("SELECT count(*) n FROM audit WHERE action LIKE 'ci.variable.%'")
      .get()!.n,
    2,
  );
  actor = "g";
  assert.equal(
    (await req("", "POST", { key: "NO", value: secret })).status,
    409,
  );
  actor = "a";
  f.db.exec("UPDATE members SET role='maintainer' WHERE user_id='a'");
  assert.equal(
    (await req("/" + row.id + "/take-ownership", "POST", { revision: 1 }))
      .status,
    200,
  );
  const taken = f.db
    .prepare("SELECT * FROM ci_variables WHERE id=?")
    .get(row.id)!;
  assert.equal(taken.owner_id, "a");
  assert.equal(taken.enabled, 0);
  assert.equal(
    (await req("/" + row.id, "DELETE", { revision: 2 })).status,
    200,
  );
});
