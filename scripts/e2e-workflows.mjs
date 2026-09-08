import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
const origin = process.env.TEST_ORIGIN || "http://localhost:8787";
const remote = !["localhost", "127.0.0.1"].includes(new URL(origin).hostname);
if (remote && process.env.ALLOW_REMOTE_ACCEPTANCE !== "1")
  throw Error("Remote acceptance requires opt-in");
const token = process.env.ONESTORAGE_TOKEN_FILE
  ? (await readFile(process.env.ONESTORAGE_TOKEN_FILE, "utf8")).trim()
  : "";
let cookie = "",
  requests = 0,
  checks = 0,
  createdSpace = false,
  repo,
  fork,
  runner,
  dir;
const name = "workflow_v14_" + crypto.randomUUID().slice(0, 8),
  ap = `/api/repos/${name}/project`;
async function api(path, method = "GET", body, expected = 200, extra = {}) {
  const response = await fetch(origin + path, {
    method,
    headers: {
      Origin: origin,
      ...(token ? { Authorization: "Bearer " + token } : { Cookie: cookie }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const raw = await response.text();
  assert.equal(
    response.status,
    expected,
    `${method} ${path}: ${raw.slice(0, 600)}`,
  );
  requests++;
  if (path === "/api/login")
    cookie = response.headers.get("set-cookie")?.split(";")[0] || "";
  return response.headers.get("content-type")?.includes("json") && raw
    ? JSON.parse(raw)
    : raw;
}
const check = (condition, message) => {
  assert.ok(condition, message);
  checks++;
};
async function waitRun(
  id,
  predicate = (run) => ["succeeded", "failed", "canceled"].includes(run.status),
) {
  for (let n = 0; n < 180; n++) {
    const run = await api(ap + "/ci/runs/" + id);
    if (predicate(run)) return run;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw Error("Workflow polling timed out: " + id);
}
async function done(id) {
  const run = await waitRun(id);
  check(
    run.status === "succeeded",
    JSON.stringify({
      status: run.status,
      error: run.error,
      jobs: run.jobs?.map((j) => ({
        job: j.job_key,
        status: j.status,
        error: j.error,
      })),
    }),
  );
  return run;
}
async function commit(files, path = ap, branch = "main") {
  return api(
    path + "/commit-files",
    "POST",
    {
      target_branch: branch,
      commit_message: "Workflow acceptance",
      files: Object.entries(files).map(([path, content]) => ({
        path,
        content,
      })),
    },
    201,
  );
}
const cloud = (entry, deploy) => ({
  runner: "worker",
  timeout_seconds: 90,
  steps: [{ type: "javascript", entry, files: [entry] }],
  ...(deploy ? { deploy } : {}),
});
const deployment = {
  kind: "static",
  entry: "index.html",
  files: ["index.html"],
  environment: "preview",
};
const config = {
  name: "Versioned parallel build",
  runner: "workflow",
  branches: ["main"],
  timeout_seconds: 300,
  jobs: [
    { id: "build", pipeline: cloud("build.js") },
    { id: "lint", pipeline: cloud("lint.js") },
    {
      id: "publish",
      needs: ["build", "lint"],
      pipeline: cloud("publish.js", deployment),
    },
  ],
};
const files = {
  ".onestorage-ci.json": JSON.stringify(config),
  "package.json": '{"name":"workflow-fixture"}',
  "build.js": `export default async ({sha}) => { const start=Date.now(); await new Promise(r=>setTimeout(r,4000)); return {logs:[JSON.stringify({kind:'build',start,end:Date.now()})],artifacts:{'index.html':'<h1>workflow '+sha+'</h1>','result.txt':'built'}}; };`,
  "lint.js": `export default async () => { const start=Date.now(); await new Promise(r=>setTimeout(r,4000)); return {logs:[JSON.stringify({kind:'lint',start,end:Date.now()})],artifacts:{'lint.json':'{"passed":true}'}}; };`,
  "publish.js": `export default async ({dependencies}) => { if(!JSON.parse(dependencies.lint['lint.json'].content).passed)throw Error('lint missing'); return {logs:['dependency artifacts verified'],artifacts:{'index.html':dependencies.build['index.html'].content}}; };`,
};
try {
  if (!token)
    await api("/api/login", "POST", {
      username: "owner",
      password: "local-test-password-123",
    });
  await api(
    "/api/workspaces",
    "POST",
    { slug: name, name: "Workflow acceptance" },
    201,
  );
  createdSpace = true;
  repo = await api(
    "/api/repos",
    "POST",
    { namespace: name, name: "project", visibility: "private" },
    201,
  );
  await writeFile(
    ".data/v14-last-fixture.json",
    JSON.stringify({ name, repoId: repo.id, ap }),
    { mode: 0o600 },
  );
  await commit(files);
  await api(ap + "/ci/config", "PUT", {
    source_path: ".onestorage-ci.json",
    enabled: true,
  });
  const current = await commit({ "README.md": "# Versioned workflow\n" });
  let triggered;
  for (let n = 0; n < 120; n++) {
    triggered = (await api(ap + "/ci/runs")).runs.find(
      (r) => r.sha === current.sha && r.trigger === "push",
    );
    if (triggered) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  check(!!triggered, "Git ref event creates versioned workflow");
  await done(triggered.id);
  // Initial commit alarms can be delivered after CI is enabled. Drain those runs before measuring one workflow's concurrency.
  let drained = false;
  for (let n = 0; n < 120; n++) {
    if (
      (await api(ap + "/ci/runs")).runs.every(
        (r) => !["queued", "running"].includes(r.status),
      )
    ) {
      drained = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  check(drained, "Initialization workflows drained");
  const measured = await api(ap + "/ci/runs", "POST", { ref: "main" }, 201);
  const successful = await done(measured.id);
  check(
    successful.config_sha === current.sha &&
      successful.config_path === ".onestorage-ci.json",
    "Configuration is bound to pushed SHA",
  );
  check(
    successful.jobs.length === 3 &&
      successful.jobs.every((j) => j.status === "succeeded"),
    "All three jobs succeeded",
  );
  const spans = [];
  for (const key of ["build", "lint"]) {
    const job = successful.jobs.find((j) => j.job_key === key),
      detail = await api(ap + "/ci/runs/" + job.id);
    check(!Object.hasOwn(detail, "lease_hash"), "Run API hides lease hashes");
    const line = detail.logs
      .map((l) => l.content)
      .join("\n")
      .split("\n")
      .find((l) => l.startsWith("{"));
    spans.push(JSON.parse(line));
  }
  check(
    Math.max(...spans.map((s) => s.start)) <
      Math.min(...spans.map((s) => s.end)),
    "Independent jobs execute concurrently: " + JSON.stringify(spans),
  );
  const publish = successful.jobs.find((j) => j.job_key === "publish");
  const published = await api(ap + "/ci/runs/" + publish.id);
  check(
    published.logs.some((l) =>
      l.content.includes("dependency artifacts verified"),
    ),
    "Downstream reads explicit dependency outputs",
  );
  const artifact = published.artifacts.find((a) => a.name === "index.html");
  check(
    (
      await api(ap + "/ci/runs/" + publish.id + "/artifacts/" + artifact.id)
    ).includes(current.sha),
    "Output contains exact source SHA",
  );
  const listing = await api(ap + "/ci/runs");
  check(
    listing.runs.every((r) => !r.parent_id),
    "Top-level list excludes child runs",
  );
  const dep = (await api(ap + "/deployments")).deployments.find(
    (d) => d.run_id === publish.id,
  );
  await api(ap + "/environments/preview", "PUT", {
    deployment_id: dep.id,
    expected_deployment_id: null,
    public: false,
  });
  await api(ap + "/ci/runs/" + publish.id + "/retry", "POST", {}, 409);
  console.log(
    JSON.stringify({
      stage: "cloud-workflow",
      workflow: successful.id,
      parallelSpans: spans,
    }),
  );

  // Invalid configuration must remain failed; it cannot be retried as a harmless file check.
  const broken = await commit({ ".onestorage-ci.json": "{invalid" });
  let invalid;
  for (let n = 0; n < 120; n++) {
    invalid = (await api(ap + "/ci/runs")).runs.find(
      (r) => r.sha === broken.sha,
    );
    if (invalid) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  check(
    invalid?.status === "failed" && !!invalid.config_error,
    "Bad configuration is a visible failed check",
  );
  await api(ap + "/ci/runs/" + invalid.id + "/retry", "POST", {}, 409);
  const retried = await api(
    ap + "/ci/runs/" + successful.id + "/retry",
    "POST",
    {},
    201,
  );
  const retry = await done(retried.id);
  check(
    retry.sha === current.sha && retry.config_sha === current.sha,
    "Retry preserves old source and configuration",
  );

  // A successful deployment job cannot be activated while the rest of the workflow is still waiting.
  const held = {
    name: "Held workflow",
    runner: "workflow",
    jobs: [
      { id: "publish", pipeline: cloud("build.js", deployment) },
      {
        id: "hold",
        pipeline: {
          runner: "external",
          steps: [{ type: "file", path: "package.json" }],
        },
      },
      {
        id: "later",
        needs: ["hold", "publish"],
        pipeline: {
          runner: "worker",
          steps: [{ type: "file", path: "package.json" }],
        },
      },
    ],
  };
  await api(ap + "/ci/config", "PUT", { config: held, enabled: false });
  runner = await api(
    ap + "/ci/runners",
    "POST",
    { name: "Workflow test runner" },
    201,
  );
  const run = await api(ap + "/ci/runs", "POST", { ref: "main" }, 201);
  const waiting = await waitRun(run.id, (r) =>
    r.jobs.some((j) => j.job_key === "publish" && j.status === "succeeded"),
  );
  check(
    waiting.status === "running" && waiting.jobs.length === 2,
    "Unfinished dependency keeps parent running",
  );
  const runnerHeaders = { Authorization: "Bearer " + runner.token };
  const claimed = await api(
    "/api/runner/claim",
    "POST",
    {},
    200,
    runnerHeaders,
  );
  check(
    claimed.run?.parent_id === run.id,
    "External runner claims the correct child",
  );
  const heldDeployment = (await api(ap + "/deployments")).deployments.find(
    (d) => d.run_id === waiting.jobs.find((j) => j.job_key === "publish").id,
  );
  await api(
    ap + "/environments/preview",
    "PUT",
    {
      deployment_id: heldDeployment.id,
      expected_deployment_id: dep.id,
      public: false,
    },
    400,
  );
  await api(ap + "/ci/runs/" + run.id + "/cancel", "POST", {});
  const canceled = await api(ap + "/ci/runs/" + run.id);
  check(
    canceled.status === "canceled" &&
      canceled.jobs.find((j) => j.job_key === "hold").status === "canceled",
    "Cancel atomically revokes children",
  );
  await api(
    "/api/runner/runs/" + claimed.run.id + "/complete",
    "POST",
    { status: "succeeded" },
    409,
    { ...runnerHeaders, "X-Run-Lease": claimed.lease },
  );
  check(
    !canceled.jobs.some((j) => j.job_key === "later"),
    "Downstream never started",
  );

  // Exercise the shipped external runner against actual cloud-produced inputs.
  const mixed = {
    name: "Cloud and generic build",
    runner: "workflow",
    jobs: [
      { id: "build", pipeline: cloud("build.js") },
      {
        id: "generic",
        needs: ["build"],
        pipeline: {
          runner: "external",
          steps: [
            {
              type: "run",
              name: "Read cloud artifact",
              command:
                'test "$(cat "$ONESTORAGE_DEPENDENCIES/build/result.txt")" = built\nprintf done > out.txt',
            },
          ],
          artifacts: ["out.txt"],
        },
      },
    ],
  };
  await api(ap + "/ci/config", "PUT", { config: mixed, enabled: false });
  const mixedRun = await api(ap + "/ci/runs", "POST", { ref: "main" }, 201);
  await waitRun(mixedRun.id, (r) =>
    r.jobs.some((j) => j.job_key === "generic" && j.status === "queued"),
  );
  dir = await mkdtemp(join(tmpdir(), "onestorage-workflow-"));
  const credential = join(dir, "runner-token");
  await writeFile(credential, runner.token, { mode: 0o600 });
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/runner.mjs"], {
      env: {
        ...process.env,
        ONESTORAGE_ORIGIN: origin,
        ONESTORAGE_RUNNER_TOKEN_FILE: credential,
        ONESTORAGE_RUNNER_ONCE: "1",
        ONESTORAGE_JOB_ENV: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(Error("Runner timed out"));
    }, 180000);
    child.stdout.on("data", (b) => (output += b));
    child.stderr.on("data", (b) => (output += b));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      code === 0
        ? resolve()
        : reject(
            Error(
              "Runner failed: " + output.replaceAll(runner.token, "[redacted]"),
            ),
          );
    });
  });
  const mixedDone = await done(mixedRun.id),
    generic = mixedDone.jobs.find((j) => j.job_key === "generic");
  const genericDetail = await api(ap + "/ci/runs/" + generic.id);
  check(
    genericDetail.artifacts.some((a) => a.name === "out.txt"),
    "Generic runner uploads its result",
  );
  console.log(
    JSON.stringify({ stage: "external-inputs", workflow: mixedRun.id }),
  );

  // MR configuration is from the target snapshot, even if the source fork changes it.
  await api(ap + "/ci/config", "PUT", {
    source_path: ".onestorage-ci.json",
    enabled: false,
  });
  const trusted = {
    name: "Trusted target configuration",
    runner: "worker",
    steps: [{ type: "file", path: "package.json", format: "json" }],
  };
  const target = await commit({
    ".onestorage-ci.json": JSON.stringify(trusted),
  });
  fork = await api(
    "/api/repos",
    "POST",
    {
      namespace: name,
      name: "fork",
      visibility: "private",
      base_repo: { id: repo.id },
    },
    201,
  );
  const fp = `/api/repos/${name}/fork`;
  await commit(
    {
      ".onestorage-ci.json": JSON.stringify({
        name: "Fork poison",
        runner: "external",
        steps: [{ type: "run", name: "unexpected", command: "exit 1" }],
      }),
      "contribution.txt": "review",
    },
    fp,
  );
  const mr = await api(
    ap + "/merges",
    "POST",
    {
      title: "Trusted CI configuration",
      source: "main",
      target: "main",
      source_repo: fork.id,
    },
    201,
  );
  const mrRun = await api(
    ap + "/merges/" + mr.id + "/pipeline",
    "POST",
    {},
    201,
  );
  const mrDone = await done(mrRun.id);
  check(
    mrDone.config.name === trusted.name &&
      mrDone.config_sha === target.sha &&
      mrDone.sha === mr.source_sha,
    "MR uses target config and source code snapshot",
  );
  await api(ap + "/merges/" + mr.id, "PATCH", { state: "closed" });
  console.log(
    JSON.stringify({
      checks,
      requests,
      workspace: name,
      repository: repo.id,
      workflow: successful.id,
      parallelSpans: spans,
      nativeRunner: "passed",
      configSnapshot: "push/retry/MR verified",
    }),
  );
} finally {
  if (dir) await rm(dir, { recursive: true, force: true });
  if (runner && repo) await api(ap + "/ci/runners/" + runner.id, "DELETE");
  if (fork) await api("/api/admin/repositories/" + fork.id, "DELETE");
  if (repo) await api("/api/admin/repositories/" + repo.id, "DELETE");
  if (createdSpace) {
    let removed = false;
    for (let n = 0; n < 180; n++) {
      const response = await fetch(origin + "/api/workspaces/" + name, {
        method: "DELETE",
        headers: {
          Origin: origin,
          ...(token
            ? { Authorization: "Bearer " + token }
            : { Cookie: cookie }),
        },
        signal: AbortSignal.timeout(30000),
      });
      if (response.status === 200) {
        removed = true;
        break;
      }
      assert.equal(response.status, 409);
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert.ok(removed, "Workflow fixtures collected");
  }
  console.log(
    JSON.stringify({
      cleanup:
        "repositories/workspace removed; runner revoked; temporary credentials removed",
      workspace: name,
    }),
  );
}
