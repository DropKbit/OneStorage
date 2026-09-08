import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support/review-fixture";
import { pipelineSchema } from "../src/ci-config";
import {
  enqueueRun,
  consumeCI,
  claimRun,
  publishCI,
  stagePush,
  consumeCIEvent,
} from "../src/ci";
import { cancelRun } from "../src/ci-workflow";
import { dependencyArtifacts } from "../src/ci-inputs";
import { resolvePipeline } from "../src/ci-source";
import { saveCloudOutput } from "../src/cloud-ci";
import { reviewGate } from "../src/review";
import type { CIRun } from "../src/ci";
import { registerCIRoutes } from "../src/ci";
import { digest } from "../src/security";
import { Hono } from "hono";
const execution = {
  runner: "worker",
  steps: [{ type: "file", path: "package.json", format: "json" }],
};
function workflow() {
  return pipelineSchema.parse({
    runner: "workflow",
    jobs: [
      { id: "build", pipeline: execution },
      { id: "lint", pipeline: execution },
      { id: "test", needs: ["build", "lint"], pipeline: execution },
    ],
  });
}
function setup() {
  const f = fixture(),
    messages: string[] = [],
    reads: string[] = [];
  f.env.EVENTS = {
    send: async (m: any) => {
      messages.push(m.id);
    },
    sendBatch: async (batch: any[]) => {
      messages.push(...batch.map((m) => m.body.id));
    },
  } as any;
  f.env.REPOSITORIES = {
    idFromName: (id: string) => id,
    get: () => ({
      fetch: async (request: Request) => {
        reads.push(request.url);
        return Response.json({ binary: false, content: '{"ok":true}' });
      },
    }),
  } as any;
  f.env.OBJECTS = {
    put: async (k: string, v: string) => {
      f.objects.set(k, new TextEncoder().encode(v));
    },
    get: async (k: string) => {
      const data = f.objects.get(k);
      return data
        ? { size: data.length, body: new Response(data as BodyInit).body }
        : null;
    },
    delete: async (k: string) => {
      f.objects.delete(k);
    },
  } as any;
  const row = (id: string) =>
    f.db
      .prepare("SELECT * FROM ci_runs WHERE id=?")
      .get(id) as unknown as CIRun;
  const jobs = (id: string) =>
    f.db
      .prepare("SELECT * FROM ci_runs WHERE parent_id=? ORDER BY job_key")
      .all(id) as unknown as CIRun[];
  return { ...f, messages, reads, row, jobs };
}
test("workflow schema rejects cycles, unknown/repeated dependencies, repeated IDs and nested/unsafe runtimes", () => {
  for (const jobs of [
    [{ id: "a", needs: ["a"], pipeline: execution }],
    [
      { id: "a", needs: ["b"], pipeline: execution },
      { id: "b", needs: ["a"], pipeline: execution },
    ],
    [{ id: "a", needs: ["missing"], pipeline: execution }],
    [
      { id: "a", pipeline: execution },
      { id: "a", pipeline: execution },
    ],
    [
      { id: "a", pipeline: execution },
      { id: "b", needs: ["a", "a"], pipeline: execution },
    ],
    [{ id: "a", pipeline: workflow() }],
    [
      {
        id: "a",
        pipeline: {
          runner: "worker",
          steps: [{ type: "run", name: "shell", command: "ls" }],
        },
      },
    ],
  ])
    assert.equal(
      pipelineSchema.safeParse({ runner: "workflow", jobs }).success,
      false,
    );
  assert.equal(workflow().runner, "workflow");
});
test("duplicate coordinators create roots once; descendants wait; only parent success satisfies MR gate", async () => {
  const f = setup();
  f.db.exec("UPDATE branch_protections SET require_ci=1,require_codeowners=0");
  const created = await enqueueRun(
    f.env,
    f.repo,
    "feature",
    "src",
    workflow(),
    "manual",
    "o",
  );
  const id = created!.id;
  await Promise.all([consumeCI(f.env, id), consumeCI(f.env, id)]);
  assert.deepEqual(
    f.jobs(id).map((j) => j.job_key),
    ["build", "lint"],
  );
  const [build, lint] = f.jobs(id);
  await consumeCI(f.env, build.id);
  await consumeCI(f.env, id);
  assert.equal(f.jobs(id).length, 2);
  const gate = await reviewGate(f.env, f.repo, f.mr("src", "dst"));
  assert.equal(gate.ci.id, id);
  assert.equal(gate.allowed, false);
  await consumeCI(f.env, lint.id);
  await Promise.all([consumeCI(f.env, id), consumeCI(f.env, id)]);
  const next = f.jobs(id).find((j) => j.job_key === "test")!;
  assert.ok(next);
  assert.equal(f.row(id).status, "running");
  await consumeCI(f.env, next.id);
  await consumeCI(f.env, id);
  assert.equal(f.row(id).status, "succeeded");
  assert.equal(
    (await reviewGate(f.env, f.repo, f.mr("src", "dst"))).allowed,
    true,
  );
  await consumeCI(f.env, id);
  assert.equal(f.jobs(id).length, 3);
});
test("cancel and failed/expired child revoke all in-flight leases atomically and prevent late artifact publication", async () => {
  for (const stop of ["cancel", "failure", "expiry"]) {
    const f = setup();
    const parent = (await enqueueRun(
      f.env,
      f.repo,
      "main",
      "sha",
      workflow(),
      "manual",
      "o",
    ))!.id;
    await consumeCI(f.env, parent);
    const [a, b] = f.jobs(parent);
    const claim = await claimRun(f.env, f.repo.id, "worker", "worker", b.id);
    assert.ok(claim);
    if (stop === "cancel") await cancelRun(f.env, parent);
    else {
      if (stop === "failure")
        f.db.prepare("UPDATE ci_runs SET status='failed' WHERE id=?").run(a.id);
      else {
        f.db
          .prepare(
            "UPDATE ci_runs SET status='running',lease_until=0 WHERE id=?",
          )
          .run(a.id);
        await publishCI(f.env);
      }
      await consumeCI(f.env, parent);
    }
    assert.ok(["failed", "canceled"].includes(f.row(parent).status));
    assert.equal(f.row(b.id).status, "canceled");
    assert.equal(f.row(b.id).lease_hash, null);
    await saveCloudOutput(f.env, f.repo, claim!.run, {
      "late.txt": { content: "must not publish" },
    });
    assert.equal(f.objects.size, 0);
    assert.equal(f.jobs(parent).length, 2);
    assert.equal(
      await claimRun(f.env, f.repo.id, "another", "worker", b.id),
      null,
    );
  }
});
test("workflow timeout and repository archive cannot spawn descendants or leave children running", async () => {
  for (const mode of ["timeout", "archive"]) {
    const f = setup();
    const id = (await enqueueRun(
      f.env,
      f.repo,
      "main",
      "sha",
      workflow(),
      "manual",
      "o",
    ))!.id;
    await consumeCI(f.env, id);
    if (mode === "timeout")
      f.db
        .prepare("UPDATE ci_runs SET started_at='2000-01-01' WHERE id=?")
        .run(id);
    else
      f.db.exec(
        "UPDATE repositories SET archived_at=datetime('now') WHERE id='r';UPDATE ci_runs SET status='canceled' WHERE repo_id='r' AND status IN ('running','queued')",
      );
    await consumeCI(f.env, id);
    assert.ok(["failed", "canceled"].includes(f.row(id).status));
    assert.ok(f.jobs(id).every((j) => j.status === "canceled"));
  }
});
test("artifact inputs are limited to declared successful siblings, preserve binary bytes and stop on cancellation or size excess", async () => {
  const f = setup();
  const id = (await enqueueRun(
    f.env,
    f.repo,
    "main",
    "sha",
    workflow(),
    "manual",
    "o",
  ))!.id;
  await consumeCI(f.env, id);
  const [a, b] = f.jobs(id);
  f.db
    .prepare("UPDATE ci_runs SET status='succeeded' WHERE parent_id=?")
    .run(id);
  const key = `ci/r/${a.id}/blob`;
  f.objects.set(key, Uint8Array.of(0, 1, 255));
  f.db
    .prepare(
      "INSERT INTO ci_artifacts(id,run_id,name,size,object_key) VALUES('artifact',?,'data.bin',3,?)",
    )
    .run(a.id, key);
  await consumeCI(f.env, id);
  const child = f.jobs(id).find((j) => j.job_key === "test")!;
  const inputs = await dependencyArtifacts(f.env, child);
  assert.equal(inputs.build["data.bin"].binary, true);
  assert.equal(inputs.build["data.bin"].content, "AAH/");
  assert.deepEqual(Object.keys(inputs), ["build", "lint"]);
  assert.deepEqual(Object.keys(await dependencyArtifacts(f.env, a)), []);
  await assert.rejects(dependencyArtifacts(f.env, child, 2), /budget/);
  await cancelRun(f.env, id);
  await assert.rejects(dependencyArtifacts(f.env, child), /stopped/);
  assert.equal(f.row(b.id).status, "succeeded");
});
test("versioned config reads an exact SHA, validates nested HTTP destinations, and rejects invalid UTF-8 or oversized config", async () => {
  const f = setup();
  let payload: BodyInit = JSON.stringify(workflow());
  f.env.REPOSITORIES = {
    idFromName: (id: string) => id,
    get: () => ({
      fetch: async (r: Request) => {
        f.reads.push(r.url);
        return new Response(payload);
      },
    }),
  } as any;
  const saved = { config: "null", source_path: ".onestorage-ci.json" };
  const loaded = await resolvePipeline(f.env, f.repo, saved, "a".repeat(40));
  assert.equal(loaded.config_sha, "a".repeat(40));
  assert.equal(loaded.config_path, saved.source_path);
  assert.equal(new URL(f.reads[0]).searchParams.get("ref"), "a".repeat(40));
  payload = JSON.stringify({
    runner: "workflow",
    jobs: [
      {
        id: "probe",
        pipeline: {
          runner: "worker",
          steps: [{ type: "http", url: "https://unapproved.invalid" }],
        },
      },
    ],
  });
  await assert.rejects(
    resolvePipeline(f.env, f.repo, saved, "sha"),
    /operator-approved/,
  );
  payload = Uint8Array.of(255);
  await assert.rejects(resolvePipeline(f.env, f.repo, saved, "sha"));
  payload = " ".repeat(128 * 1024 + 1);
  await assert.rejects(resolvePipeline(f.env, f.repo, saved, "sha"));
});
test("push outbox never reenters the repository DO and duplicate/failed queue delivery produces one immutable run", async () => {
  const f = setup();
  f.db
    .prepare(
      "INSERT INTO ci_pipelines(repo_id,config,source_path) VALUES('r','null','.onestorage-ci.json')",
    )
    .run();
  let raw = JSON.stringify(workflow());
  f.env.REPOSITORIES = {
    idFromName: (id: string) => id,
    get: () => ({
      fetch: async (r: Request) => {
        f.reads.push(r.url);
        return new Response(raw);
      },
    }),
  } as any;
  f.env.EVENTS = {
    send: async () => {
      throw Error("queue down");
    },
  } as any;
  const event = {
    id: "push",
    event: "push",
    repository_id: "r",
    ref: "refs/heads/main",
    after: "a".repeat(40),
  };
  await stagePush(f.env, event);
  await stagePush(f.env, event);
  assert.equal(f.reads.length, 0);
  assert.equal(f.db.prepare("SELECT count(*) n FROM ci_events").get()!.n, 1);
  await consumeCIEvent(f.env, "push");
  await consumeCIEvent(f.env, "push");
  assert.equal(f.db.prepare("SELECT count(*) n FROM ci_runs").get()!.n, 1);
  const run = f.db.prepare("SELECT * FROM ci_runs").get()!;
  assert.equal(run.config_sha, event.after);
  raw = "{invalid";
  await stagePush(f.env, { ...event, id: "bad" });
  await consumeCIEvent(f.env, "bad");
  const bad = f.db.prepare("SELECT * FROM ci_runs WHERE event_id='bad'").get()!;
  assert.equal(bad.status, "failed");
  assert.ok(bad.config_error);
  assert.equal(f.db.prepare("SELECT count(*) n FROM ci_events").get()!.n, 0);
});
test("runner input download rechecks authorization after a cancellation racing the R2 read", async () => {
  const f = setup(),
    token = "osr_test_workflow_reader";
  const config = pipelineSchema.parse({
    runner: "workflow",
    jobs: [
      { id: "build", pipeline: execution },
      {
        id: "consumer",
        needs: ["build"],
        pipeline: {
          runner: "external",
          steps: [{ type: "file", path: "package.json" }],
        },
      },
    ],
  });
  f.db
    .prepare(
      "INSERT INTO ci_runners(id,repo_id,name,token_hash) VALUES('runner','r','test',?)",
    )
    .run(await digest(token));
  const id = (await enqueueRun(
    f.env,
    f.repo,
    "main",
    "sha",
    config,
    "manual",
    "o",
  ))!.id;
  await consumeCI(f.env, id);
  const build = f.jobs(id)[0];
  f.db
    .prepare("UPDATE ci_runs SET status='succeeded' WHERE id=?")
    .run(build.id);
  f.db
    .prepare(
      "INSERT INTO ci_artifacts(id,run_id,name,size,object_key) VALUES('input',?,'private.txt',6,?)",
    )
    .run(build.id, `ci/r/${build.id}/private`);
  await consumeCI(f.env, id);
  const child = f.jobs(id).find((j) => j.job_key === "consumer")!;
  const claim = (await claimRun(f.env, "r", "runner", "external", child.id))!;
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => {
      release = resolve;
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve;
    });
  f.env.OBJECTS.get = (async () => {
    entered();
    await held;
    return { size: 6, body: new Response("secret").body };
  }) as any;
  const app = new Hono();
  registerCIRoutes(app as any, {
    access: async () => f.repo,
    audit: async () => {},
  });
  const response = app.request(
    "http://test/api/runner/runs/" + child.id + "/inputs",
    {
      headers: { Authorization: "Bearer " + token, "X-Run-Lease": claim.lease },
    },
    f.env,
  );
  await started;
  await cancelRun(f.env, id);
  release();
  const result = await response;
  assert.equal(result.status, 409);
  assert.doesNotMatch(await result.text(), /secret/);
});
