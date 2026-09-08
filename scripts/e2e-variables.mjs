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
const workspaceVariables = process.env.ONESTORAGE_WORKSPACE_VARIABLES === "1";
let cookie = "",
  requests = 0,
  checks = 0,
  createdSpace = false,
  repo,
  fork,
  sibling,
  runner,
  dir;
const name =
    (workspaceVariables ? "variables_v24_" : "variables_v20_") +
    crypto.randomUUID().slice(0, 8),
  ap = `/api/repos/${name}/project`,
  variablesAPI = workspaceVariables
    ? `/api/workspaces/${name}/ci/variables`
    : ap + "/ci/variables";
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
  path = ap,
) {
  for (let n = 0; n < 180; n++) {
    const run = await api(path + "/ci/runs/" + id);
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
const secret = "fixture-" + crypto.randomUUID() + '-"雪/';
const spec = {
  key: "API_TOKEN",
  environment: "production",
  refs: ["main"],
  secret: true,
  protected: true,
  enabled: true,
};
const config = (entry = "ci.js") => ({
  name: "Encrypted inputs",
  runner: "worker",
  variables: ["API_TOKEN", "LABEL"],
  environment: "production",
  steps: [{ type: "javascript", entry, files: [entry] }],
});
const start = async (configuration) => {
  await api(ap + "/ci/config", "PUT", {
    config: configuration,
    enabled: false,
  });
  return api(ap + "/ci/runs", "POST", { ref: "main" }, 201);
};
function masked(run) {
  const output = JSON.stringify(run);
  for (const pattern of [
    secret,
    JSON.stringify(secret).slice(1, -1),
    encodeURIComponent(secret),
    Buffer.from(secret).toString("base64"),
  ])
    check(!output.includes(pattern), "Secret absent from run response");
  check(
    /\[(MASKED|REDACTED)\]/.test(run.logs.map((l) => l.content).join("")),
    "Masked logs retained",
  );
}
try {
  if (!token)
    await api("/api/login", "POST", {
      username: "owner",
      password: "local-test-password-123",
    });
  await api(
    "/api/workspaces",
    "POST",
    { slug: name, name: "CI variable acceptance" },
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
    ".data/v20-last-fixture.json",
    JSON.stringify({ name, repoId: repo.id, ap }),
    { mode: 0o600 },
  );
  await commit({
    "ci.js": `export default async ({variables:v})=>{if(v.LABEL!=="production"||!v.API_TOKEN)throw Error("variables missing");console.log("console:",v.API_TOKEN);return {logs:[v.API_TOKEN,encodeURIComponent(v.API_TOKEN),btoa(unescape(encodeURIComponent(v.API_TOKEN)))],artifacts:{"proof.txt":"environment-selected; secret-present"}};}`,
    "scope.js": `export default async ({variables:v})=>({logs:["selected:"+v.LABEL],artifacts:{"scope.txt":v.LABEL}})`,
    "error.js": `export default async ({variables:v})=>{throw Error("failure: "+v.API_TOKEN)}`,
    "invalid.js": `export default async ()=>42`,
    "external.cjs": `const v=process.env.API_TOKEN;if(!v||process.env.LABEL!=="production")throw Error("variables missing");const b=Buffer.from(v);process.stdout.write(b.subarray(0,b.length-3));setTimeout(()=>{process.stdout.write(b.subarray(b.length-3));process.stdout.write("\\n"+encodeURIComponent(v)+"\\n"+b.toString("base64"));require("node:fs").writeFileSync("proof.txt","external-variables-verified")},80);`,
  });
  await api(
    ap + "/branches/create",
    "POST",
    { target_branch: "feature", base_branch: "main" },
    201,
  );
  await commit({ "feature.txt": "MR variable check" }, ap, "feature");
  await api(ap + "/protections", "PUT", { branch: "main", require_mr: true });
  let variable = await api(
    variablesAPI,
    "POST",
    { ...spec, value: secret },
    201,
  );
  check(
    Array.isArray(variable.refs) &&
      !("value" in variable) &&
      !("encrypted" in variable),
    "Create returns metadata only",
  );
  await api(
    variablesAPI,
    "POST",
    {
      key: "LABEL",
      value: "fallback",
      secret: false,
      protected: false,
      refs: ["*"],
    },
    201,
  );
  await api(
    variablesAPI,
    "POST",
    {
      key: "LABEL",
      value: "production",
      environment: "production",
      secret: false,
      protected: false,
      refs: ["*"],
    },
    201,
  );
  const listed = await api(variablesAPI);
  check(
    listed.variables.every((v) => !("value" in v) && !("encrypted" in v)),
    "List is write-only for plain and secret values",
  );
  const cloudRun = await done((await start(config())).id);
  masked(cloudRun);
  check(cloudRun.artifacts.length === 1, "Worker produced proof artifact");

  if (workspaceVariables) {
    const inherited = await api(ap + "/ci/variables");
    check(
      inherited.inherited.length === 3 && inherited.variables.length === 0,
      "Project lists inherited metadata separately",
    );
    check(
      inherited.inherited.every((v) => !("value" in v) && !("encrypted" in v)),
      "Inherited metadata is write-only",
    );
    const overrideSpec = {
      key: "LABEL",
      environment: "*",
      refs: ["*"],
      secret: false,
      protected: false,
      enabled: true,
    };
    let override = await api(
      ap + "/ci/variables",
      "POST",
      { ...overrideSpec, value: "project-choice" },
      201,
    );
    let selected = await done((await start(config("scope.js"))).id);
    check(
      selected.logs.some((l) => l.content.includes("selected:project-choice")),
      "Project general value overrides workspace exact environment",
    );
    override = await api(ap + "/ci/variables/" + override.id, "PUT", {
      ...overrideSpec,
      enabled: false,
      revision: override.revision,
    });
    const denied = await waitRun((await start(config("scope.js"))).id);
    check(
      denied.status === "failed" && denied.error.includes("unavailable"),
      "Paused project override blocks space fallback",
    );
    await api(ap + "/ci/variables/" + override.id, "DELETE", {
      revision: override.revision,
    });
    selected = await done((await start(config("scope.js"))).id);
    check(
      selected.logs.some((l) => l.content.includes("selected:production")),
      "Deleting project override restores space environment",
    );
    sibling = await api(
      "/api/repos",
      "POST",
      { namespace: name, name: "sibling", visibility: "private" },
      201,
    );
    const sp = "/api/repos/" + name + "/sibling";
    await commit(
      {
        "ci.js":
          'export default async ({variables:v})=>{if(v.LABEL!=="production"||!v.API_TOKEN)throw Error("missing inherited inputs");return {logs:["sibling inheritance verified"]}}',
      },
      sp,
    );
    await api(sp + "/protections", "PUT", { branch: "main", require_mr: true });
    await api(sp + "/ci/config", "PUT", { config: config(), enabled: false });
    const sr = await api(sp + "/ci/runs", "POST", { ref: "main" }, 201);
    const completed = await waitRun(sr.id, undefined, sp);
    check(
      completed.status === "succeeded",
      "Sibling project consumes the same space definition",
    );
  }

  await api(
    variablesAPI,
    "POST",
    { ...spec, environment: "*", value: "fallback-" + crypto.randomUUID() },
    201,
  );
  variable = await api(variablesAPI + "/" + variable.id, "PUT", {
    ...spec,
    revision: variable.revision,
    enabled: false,
  });
  const paused = await waitRun((await start(config())).id);
  check(
    paused.status === "failed" && paused.error.includes("unavailable"),
    "Paused environment does not fall back to another credential",
  );
  variable = await api(variablesAPI + "/" + variable.id, "PUT", {
    ...spec,
    revision: variable.revision,
    enabled: true,
  });
  const failed = await waitRun((await start(config("error.js"))).id);
  check(
    failed.status === "failed" && failed.error.includes("[MASKED]"),
    "Worker exception redacted",
  );
  check(!failed.error.includes(secret), "Exception contains no raw secret");
  const invalid = await waitRun((await start(config("invalid.js"))).id);
  check(
    invalid.status === "failed" &&
      invalid.error.includes("Job must return an object"),
    "Invalid Worker return rejected",
  );

  runner = await api(
    ap + "/ci/runners",
    "POST",
    { name: "Variable acceptance" },
    201,
  );
  const external = {
    ...config(),
    runner: "external",
    steps: [
      { type: "run", name: "Read variables", command: "node external.cjs" },
    ],
    artifacts: ["proof.txt"],
  };
  const native = await start(external);
  dir = await mkdtemp(join(tmpdir(), "onestorage-variables-"));
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
    const timer = setTimeout(() => child.kill("SIGTERM"), 180000);
    child.stdout.on("data", (b) => (output += b));
    child.stderr.on("data", (b) => (output += b));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (
        code === 0 &&
        !output.includes(secret) &&
        !output.includes(runner.token)
      )
        resolve();
      else
        reject(
          Error("External variable runner failed or exposed a credential"),
        );
    });
  });
  const externalRun = await done(native.id);
  masked(externalRun);
  check(externalRun.artifacts.length === 1, "Shipped runner produced artifact");
  const hold = await start(external);
  const claim = await api("/api/runner/claim", "POST", {}, 200, {
    Authorization: "Bearer " + runner.token,
  });
  check(claim.run.id === hold.id, "Lease belongs to held run");
  const leaseHeaders = {
    Authorization: "Bearer " + runner.token,
    "X-Run-Lease": claim.lease,
  };
  const privateInputs = await api(
    "/api/runner/runs/" + hold.id + "/variables",
    "GET",
    undefined,
    200,
    leaseHeaders,
  );
  check(
    privateInputs.variables.API_TOKEN === secret,
    "Lease permits private variable retrieval",
  );
  await api(
    "/api/runner/runs/" + hold.id + "/variables",
    "GET",
    undefined,
    409,
    { ...leaseHeaders, "X-Run-Lease": "invalid" },
  );
  await api(
    "/api/runner/runs/" + hold.id + "/logs",
    "POST",
    { seq: 0, content: secret.slice(0, 20) },
    200,
    leaseHeaders,
  );
  await api(
    "/api/runner/runs/" + hold.id + "/logs",
    "POST",
    { seq: 1, content: secret.slice(20) },
    200,
    leaseHeaders,
  );
  masked(await api(ap + "/ci/runs/" + hold.id));
  variable = await api(variablesAPI + "/" + variable.id, "PUT", {
    ...spec,
    revision: variable.revision,
    value: "rotated-" + crypto.randomUUID(),
  });
  check(
    (await api(ap + "/ci/runs/" + hold.id)).status === "canceled",
    "Rotation cancels bound run",
  );
  await api(
    "/api/runner/runs/" + hold.id + "/complete",
    "POST",
    { status: "succeeded" },
    409,
    leaseHeaders,
  );
  await api(
    "/api/runner/runs/" + hold.id + "/variables",
    "GET",
    undefined,
    409,
    leaseHeaders,
  );
  await api(variablesAPI + "/" + variable.id, "DELETE", {
    revision: variable.revision,
  });
  masked(await api(ap + "/ci/runs/" + hold.id));
  masked(await api(ap + "/ci/runs/" + cloudRun.id));
  await api(variablesAPI, "POST", { ...spec, value: secret, refs: ["*"] }, 201);
  await api(ap + "/ci/config", "PUT", {
    config: {
      name: "MR secret test",
      runner: "workflow",
      jobs: [{ id: "private", pipeline: config() }],
    },
    enabled: false,
  });
  const mr = await api(
    ap + "/merges",
    "POST",
    { title: "Variable origin", source: "feature", target: "main" },
    201,
  );
  const requested = await api(
    ap + "/merges/" + mr.id + "/pipeline",
    "POST",
    {},
    201,
  );
  const mrRun = await waitRun(requested.id);
  check(mrRun.status === "failed", "MR workflow cannot read secrets");
  const mrJob = await api(ap + "/ci/runs/" + mrRun.jobs[0].id);
  check(
    mrJob.error.includes("merge-request"),
    "MR child keeps original origin",
  );
  const retry = await api(
    ap + "/ci/runs/" + mrRun.id + "/retry",
    "POST",
    {},
    201,
  );
  const retryRun = await waitRun(retry.id);
  check(retryRun.status === "failed", "MR retry cannot obtain secret access");
  await api(ap + "/merges/" + mr.id, "PATCH", { state: "closed" });
  console.log(
    JSON.stringify({
      checks,
      requests,
      workspace: name,
      scope: workspaceVariables ? "workspace" : "project",
      worker: cloudRun.id,
      external: externalRun.id,
      rotation: hold.id,
      variables:
        "environment override, encrypted input, write-only metadata, console/error/chunked logs, lease denial, rotation cancellation, retained masking",
    }),
  );
} catch (error) {
  console.error(error.message);
  throw error;
} finally {
  if (dir) await rm(dir, { recursive: true, force: true });
  if (runner && repo) await api(ap + "/ci/runners/" + runner.id, "DELETE");
  if (sibling) await api("/api/admin/repositories/" + sibling.id, "DELETE");
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
    assert.ok(removed, "Variable fixtures collected");
  }
  console.log(
    JSON.stringify({
      cleanup:
        "repositories/workspace removed; runner revoked; temporary credentials removed",
      workspace: name,
    }),
  );
}
