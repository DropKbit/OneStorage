import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support/review-fixture";
import { enqueueRun, claimRun, consumeCI } from "../src/ci";
import { pipelineSchema } from "../src/ci-config";
import {
  loadRunVariables,
  variableContext,
  workspaceVariableContext,
  maskRunLog,
} from "../src/ci-variables";
import { seal } from "../src/sync-config";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { registerWorkspaceVariableRoutes } from "../src/workspace-ci-variable-routes";
import type { App } from "../src/types";
const sha = "a".repeat(40),
  secret = "shared-secret-123456789";
function setup() {
  const f = fixture();
  f.env.CREDENTIAL_ENCRYPTION_KEY = btoa("w".repeat(32));
  f.db.exec(
    "INSERT INTO workspaces(id,slug,name) VALUES('w','team','Team'),('x','second','Second');INSERT INTO workspace_members VALUES('w','o','owner'),('w','a','owner'),('w','d','maintainer'),('x','o','owner');UPDATE repositories SET workspace_id='w',namespace='team' WHERE id IN('r','other');INSERT INTO branch_protections(repo_id,branch,require_mr) VALUES('other','main',1);",
  );
  let onBranch = async () => {};
  f.env.REPOSITORIES = {
    idFromName: (id: string) => id,
    get: () => ({
      fetch: async () => {
        await onBranch();
        return Response.json({ sha });
      },
    }),
  } as any;
  async function variable(id = "wcv_one", options: any = {}) {
    const {
      scope = "workspace",
      owner = "o",
      value = secret,
      key = "TOKEN",
      environment = "*",
      enabled = 1,
      protected: protect = 1,
      secret: hidden = 1,
      refs = ["main"],
    } = options;
    const space = scope === "workspace",
      table = space ? "ci_workspace_variables" : "ci_variables",
      scopeId = space ? "w" : "r";
    f.db
      .prepare(
        `INSERT INTO ${table}(id,${space ? "workspace_id" : "repo_id"},owner_id,key,environment,encrypted,enabled,protected,secret,refs) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        scopeId,
        owner,
        key,
        environment,
        await seal(
          f.env,
          space
            ? workspaceVariableContext(scopeId, id)
            : variableContext(scopeId, id),
          value,
        ),
        enabled,
        protect,
        hidden,
        JSON.stringify(refs),
      );
  }
  async function run(id = "r", options: any = {}, trigger = "manual") {
    const repo = f.db
      .prepare("SELECT * FROM repositories WHERE id=?")
      .get(id) as any;
    const made = await enqueueRun(
      f.env,
      repo,
      "main",
      sha,
      pipelineSchema.parse({
        runner: "worker",
        variables: ["TOKEN"],
        steps: [{ type: "file", path: "README.md" }],
        ...options,
      }),
      trigger,
      "o",
    );
    return (await claimRun(f.env, id, "worker", "worker", made!.id))!.run;
  }
  return {
    ...f,
    variable,
    run,
    onBranch: (hook: () => Promise<void>) => {
      onBranch = hook;
    },
    status: (id: string) =>
      f.db.prepare("SELECT status FROM ci_runs WHERE id=?").get(id)!.status,
  };
}
test("workspace variables decrypt per scope across projects and retain encrypted historical masking", async () => {
  const f = setup();
  await f.variable();
  for (const repo of ["r", "other"]) {
    const run = await f.run(repo);
    assert.equal((await loadRunVariables(f.env, run)).variables.TOKEN, secret);
    assert.equal(
      await maskRunLog(f.env, run.id, "value " + secret),
      "value [MASKED]",
    );
  }
  assert.ok(
    !String(
      f.db.prepare("SELECT encrypted FROM ci_workspace_variables").get()!
        .encrypted,
    ).includes(secret),
  );
  f.db.prepare("DELETE FROM ci_workspace_variables").run();
  for (const r of f.db.prepare("SELECT id FROM ci_runs").all()) {
    assert.equal(f.status(String(r.id)), "canceled");
    assert.equal(await maskRunLog(f.env, String(r.id), secret), "[MASKED]");
  }
});
test("project scope wins before environment; paused winning definitions deny fallback", async () => {
  const f = setup();
  await f.variable("wcv_all");
  await f.variable("wcv_prod", {
    environment: "production",
    value: "space-production",
  });
  let r = await f.run("r", { environment: "production" });
  assert.equal(
    (await loadRunVariables(f.env, r)).variables.TOKEN,
    "space-production",
  );
  await f.variable("project", { scope: "project", value: "project-global" });
  r = await f.run("r", { environment: "production" });
  assert.equal(
    (await loadRunVariables(f.env, r)).variables.TOKEN,
    "project-global",
  );
  f.db.prepare("UPDATE ci_variables SET enabled=0,revision=revision+1").run();
  r = await f.run("r", { environment: "production" });
  await assert.rejects(loadRunVariables(f.env, r), /unavailable/);
  f.db.prepare("DELETE FROM ci_variables").run();
  r = await f.run("r", { environment: "production" });
  assert.equal(
    (await loadRunVariables(f.env, r)).variables.TOKEN,
    "space-production",
  );
  f.db
    .prepare(
      "UPDATE ci_workspace_variables SET enabled=0,revision=revision+1 WHERE environment='production'",
    )
    .run();
  r = await f.run("r", { environment: "production" });
  await assert.rejects(loadRunVariables(f.env, r), /unavailable/);
});
test("workspace owner revocation cancels all bound projects even when project maintenance remains", async () => {
  for (const mode of ["role", "member", "disabled"]) {
    const f = setup();
    await f.variable();
    const runs = await Promise.all(["r", "other"].map((id) => f.run(id)));
    for (const run of runs) await loadRunVariables(f.env, run);
    f.db.prepare("INSERT INTO members VALUES('r','o','maintainer')").run();
    if (mode === "role")
      f.db
        .prepare(
          "UPDATE workspace_members SET role='maintainer' WHERE workspace_id='w' AND user_id='o'",
        )
        .run();
    if (mode === "member")
      f.db
        .prepare(
          "DELETE FROM workspace_members WHERE workspace_id='w' AND user_id='o'",
        )
        .run();
    if (mode === "disabled")
      f.db.prepare("UPDATE users SET disabled=1 WHERE id='o'").run();
    assert.equal(
      f.db.prepare("SELECT enabled FROM ci_workspace_variables").get()!.enabled,
      0,
    );
    for (const run of runs) {
      assert.equal(f.status(run.id), "canceled");
      await assert.rejects(loadRunVariables(f.env, run), /authorization|lease/);
    }
  }
});
test("inherited snapshot cannot survive project transfer despite other projects authorizing the same variable", async () => {
  const f = setup();
  await f.variable();
  const run = await f.run();
  await loadRunVariables(f.env, run);
  f.db
    .prepare(
      "UPDATE repositories SET workspace_id='x',namespace='second' WHERE id='r'",
    )
    .run();
  assert.equal(f.status(run.id), "canceled");
  const fresh = await f.run();
  await assert.rejects(loadRunVariables(f.env, fresh), /unavailable/);
  assert.equal(
    (await loadRunVariables(f.env, await f.run("other"))).variables.TOKEN,
    secret,
  );
});
test("in-flight inheritance checks reject a new higher-priority override, scope movement and owner revocation", async () => {
  for (const mode of ["override", "move", "revoke"]) {
    const f = setup();
    await f.variable();
    const run = await f.run();
    f.onBranch(async () => {
      if (mode === "override")
        await f.variable("override", { scope: "project", enabled: 0 });
      if (mode === "move")
        f.db
          .prepare(
            "UPDATE repositories SET workspace_id='x',namespace='second' WHERE id='r'",
          )
          .run();
      if (mode === "revoke")
        f.db
          .prepare(
            "UPDATE workspace_members SET role='maintainer' WHERE workspace_id='w' AND user_id='o'",
          )
          .run();
    });
    await assert.rejects(
      loadRunVariables(f.env, run),
      /permissions|authorization|lease/,
    );
    assert.equal(
      f.db.prepare("SELECT count(*) n FROM ci_run_variables").get()!.n,
      0,
    );
  }
});
test("workspace secrets retain MR, branch protection and ref restrictions", async () => {
  for (const mode of ["mr", "protection", "ref"]) {
    const f = setup();
    await f.variable("wcv_one", mode === "ref" ? { refs: ["release"] } : {});
    if (mode === "protection")
      f.db.prepare("DELETE FROM branch_protections WHERE repo_id='r'").run();
    const run = await f.run(
      "r",
      {},
      mode === "mr" ? "merge_request" : "manual",
    );
    await assert.rejects(
      loadRunVariables(f.env, run),
      /merge-request|permissions|branch scope/,
    );
  }
});
test("workspace variable API requires owner and live write credential, preserves write-only values and supports paused takeover", async () => {
  const f = setup(),
    app = new Hono<App>();
  f.db
    .prepare(
      "INSERT INTO credentials(hash,id,user_id,name,kind,expires_at) VALUES('owner','owner','o','test','pat',?),('second','second','a','test','pat',?)",
    )
    .run(Date.now() + 600000, Date.now() + 600000);
  let actor = "o",
    credential = "owner",
    scope = "write";
  app.use("*", async (c, next) => {
    c.set("user", { id: actor, username: actor, admin: 1 });
    c.set("credential", credential);
    c.set("kind", "pat");
    c.set("scope", scope as any);
    await next();
  });
  app.onError((e, c) =>
    c.json({ error: e.message }, e instanceof HTTPException ? e.status : 400),
  );
  registerWorkspaceVariableRoutes(app);
  const root = "/api/workspaces/team/ci/variables";
  async function req(path: string, method = "GET", body?: any, status = 200) {
    const r = await app.request(
      "https://git.example" + path,
      {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      f.env,
    );
    assert.equal(r.status, status, await r.clone().text());
    return r.json() as Promise<any>;
  }
  let v = await req(root, "POST", { key: "TOKEN", value: secret }, 201);
  assert.equal(v.encrypted, undefined);
  assert.equal(v.value, undefined);
  actor = "d";
  await req(root, "GET", undefined, 403);
  actor = "g";
  await req(root, "GET", undefined, 404);
  actor = "o";
  scope = "read";
  await req(root, "POST", { key: "OTHER", value: secret }, 403);
  scope = "write";
  await req(root + "/" + v.id, "PUT", { key: "TOKEN", revision: 9 }, 409);
  const run = await f.run();
  await loadRunVariables(f.env, run);
  actor = "a";
  credential = "second";
  await req(root + "/" + v.id + "/take-ownership", "POST", { revision: 0 });
  assert.equal(f.status(run.id), "canceled");
  v = (await req(root)).variables[0];
  assert.equal(v.enabled, 0);
  assert.equal(v.owner_id, "a");
  await req(root + "/" + v.id, "PUT", {
    key: "TOKEN",
    revision: v.revision,
    enabled: true,
  });
  const fresh = await f.run();
  assert.equal((await loadRunVariables(f.env, fresh)).variables.TOKEN, secret);
  f.db.prepare("DELETE FROM credentials WHERE hash='second'").run();
  await req(root + "/" + v.id, "DELETE", { revision: 2 }, 409);
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM ci_workspace_variables").get()!.n,
    1,
  );
});

test("rotating inherited input from a completed child cancels the active workflow and siblings", async () => {
  const f = setup();
  await f.variable();
  const config = pipelineSchema.parse({
    runner: "workflow",
    jobs: [
      {
        id: "first",
        pipeline: {
          runner: "worker",
          variables: ["TOKEN"],
          steps: [{ type: "file", path: "x" }],
        },
      },
      {
        id: "second",
        pipeline: { runner: "worker", steps: [{ type: "file", path: "x" }] },
      },
    ],
  });
  const repo = f.db
    .prepare("SELECT * FROM repositories WHERE id='r'")
    .get() as any;
  const parent = await enqueueRun(
    f.env,
    repo,
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
    String(child.id),
  );
  await loadRunVariables(f.env, claimed!.run);
  f.db
    .prepare("UPDATE ci_runs SET status='succeeded' WHERE id=?")
    .run(child.id);
  f.db.prepare("UPDATE ci_workspace_variables SET revision=revision+1").run();
  assert.equal(f.status(parent!.id), "canceled");
  assert.equal(
    f.db.prepare("SELECT status FROM ci_runs WHERE job_key='second'").get()!
      .status,
    "canceled",
  );
});
