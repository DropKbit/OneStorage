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
const name = "cache_v21_" + crypto.randomUUID().slice(0, 8),
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
const spec = {
  id: "deps",
  key: "dependencies",
  paths: [".cache"],
  key_files: ["lock.json"],
};
const cloud = (policy = "pull-push") => ({
  name: "Cloud cache",
  runner: "worker",
  caches: [{ ...spec, policy }],
  steps: [{ type: "javascript", entry: "ci.js", files: ["ci.js"] }],
});
const logs = (r) => r.logs.map((l) => l.content).join("");
async function start(config) {
  await api(ap + "/ci/config", "PUT", { config, enabled: false });
  return api(ap + "/ci/runs", "POST", { ref: "main" }, 201);
}
async function runnerOnce(credential) {
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
      code === 0
        ? resolve()
        : reject(
            Error(
              "Runner failed: " + output.replaceAll(runner.token, "[REDACTED]"),
            ),
          );
    });
  });
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
    { slug: name, name: "Cache acceptance" },
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
    ".data/v21-last-fixture.json",
    JSON.stringify({ name, repoId: repo.id, ap }),
    { mode: 0o600 },
  );
  await commit({
    "lock.json": '{"version":1}',
    "ci.js": `export default async({caches})=>{const n=Number(caches.deps['.cache/count']?.content||0);if(n&&caches.deps['.cache/binary'].content!=='AP8=')throw Error('binary cache invalid');return {logs:['cache-count='+n],artifacts:{'proof.txt':String(n)},caches:{deps:{'.cache/count':{content:String(n+1)},'.cache/binary':{content:'AP8=',binary:true}}}};}`,
    "cache.cjs": `const fs=require('node:fs'),crypto=require('node:crypto');fs.mkdirSync('.cache',{recursive:true});if(fs.existsSync('.cache/blob')){const hash=crypto.createHash('sha256').update(fs.readFileSync('.cache/blob')).digest('hex');if(hash!==fs.readFileSync('.cache/hash','utf8'))throw Error('cache corrupt');console.log('binary-cache-restored');}else{const b=crypto.randomBytes(2*1024*1024);fs.writeFileSync('.cache/blob',b);fs.writeFileSync('.cache/hash',crypto.createHash('sha256').update(b).digest('hex'));console.log('binary-cache-created');}fs.writeFileSync('proof.txt','passed');`,
  });
  const first = await done((await start(cloud())).id);
  check(
    logs(first).includes("cache-count=0") &&
      logs(first).includes("Cache SAVED deps"),
    "Cloud cache miss and save",
  );
  const second = await done((await start(cloud())).id);
  check(
    logs(second).includes("cache-count=1") &&
      logs(second).includes("Cache HIT deps"),
    "Cloud cache restored across runs",
  );
  const listed = await api(ap + "/ci/caches");
  check(
    listed.entries.length >= 1 && listed.used.bytes > 0,
    "Persistent metadata and quota usage",
  );
  const gated = await start({
    name: "Gated cache",
    runner: "workflow",
    jobs: [
      { id: "build", pipeline: cloud() },
      {
        id: "failure",
        needs: ["build"],
        pipeline: {
          runner: "worker",
          steps: [{ type: "file", path: "missing-file" }],
        },
      },
    ],
  });
  const failed = await waitRun(gated.id);
  check(
    failed.status === "failed" &&
      failed.jobs.find((j) => j.job_key === "build").status === "succeeded",
    "Failed parent after successful cache job",
  );
  const after = await done((await start(cloud("pull"))).id);
  check(
    logs(after).includes("cache-count=2"),
    "Failed workflow cannot replace a successful cache",
  );
  runner = await api(ap + "/ci/runners", "POST", { name: "Cache runner" }, 201);
  dir = await mkdtemp(join(tmpdir(), "onestorage-cache-"));
  const credential = join(dir, "token");
  await writeFile(credential, runner.token, { mode: 0o600 });
  const external = {
    name: "Binary cache",
    runner: "external",
    caches: [spec],
    steps: [{ type: "run", name: "Cache files", command: "node cache.cjs" }],
    artifacts: ["proof.txt"],
  };
  const externalFirst = await start(external);
  await runnerOnce(credential);
  const r1 = await done(externalFirst.id);
  check(
    logs(r1).includes("binary-cache-created") &&
      logs(r1).includes("Cache SAVED deps"),
    "External 2 MiB binary archive saved to R2",
  );
  const externalSecond = await start(external);
  await runnerOnce(credential);
  const r2 = await done(externalSecond.id);
  check(
    logs(r2).includes("binary-cache-restored") &&
      logs(r2).includes("Cache HIT deps"),
    "Shipped runner restores checksum-verified binary cache",
  );
  const corrupt = await start(external),
    badClaim = await api("/api/runner/claim", "POST", {}, 200, {
      Authorization: "Bearer " + runner.token,
    });
  check(badClaim.run.id === corrupt.id, "Checksum test owns its lease");
  const beforeBad = await api(ap + "/ci/caches");
  const rejected = await fetch(
    origin + "/api/runner/runs/" + corrupt.id + "/caches/deps",
    {
      method: "PUT",
      headers: {
        Authorization: "Bearer " + runner.token,
        "X-Run-Lease": badClaim.lease,
        "content-length": "3",
        "x-cache-sha256": "0".repeat(64),
      },
      body: "bad",
    },
  );
  check(!rejected.ok, "R2 rejects a mismatched cache checksum");
  await rejected.body.cancel();
  check(
    (await api(ap + "/ci/caches")).used.bytes <= beforeBad.used.bytes,
    "Failed R2 upload releases reservation",
  );
  await api(ap + "/ci/runs/" + corrupt.id + "/cancel", "POST", {});
  const hold = await start(external),
    claimed = await api("/api/runner/claim", "POST", {}, 200, {
      Authorization: "Bearer " + runner.token,
    });
  check(claimed.run.id === hold.id, "Held cache run lease");
  const rh = {
    Authorization: "Bearer " + runner.token,
    "X-Run-Lease": claimed.lease,
  };
  // Bind the generation before the clear, with a download that does not expose the archive to test output.
  const download = await fetch(
    origin + "/api/runner/runs/" + hold.id + "/caches/deps",
    { headers: rh },
  );
  check(
    download.status === 200 && download.headers.get("x-cache-sha256"),
    "Runner cache authorization",
  );
  await download.body.cancel();
  const state = await api(ap + "/ci/caches");
  await api(ap + "/ci/caches/clear", "POST", { generation: state.generation });
  await api(
    ap + "/ci/caches/clear",
    "POST",
    { generation: state.generation },
    409,
  );
  await api(
    "/api/runner/runs/" + hold.id + "/caches/deps",
    "GET",
    undefined,
    409,
    rh,
  );
  const payload = new TextEncoder().encode("late");
  const hash = await import("node:crypto").then((m) =>
    m.createHash("sha256").update(payload).digest("hex"),
  );
  const late = await fetch(
    origin + "/api/runner/runs/" + hold.id + "/caches/deps",
    {
      method: "PUT",
      headers: {
        ...rh,
        "content-length": String(payload.length),
        "x-cache-sha256": hash,
      },
      body: payload,
    },
  );
  check(late.status === 409, "Clear rejects old in-flight upload");
  await late.body.cancel();
  await api(ap + "/ci/runs/" + hold.id + "/cancel", "POST", {});
  const cleared = await done((await start(cloud("pull"))).id);
  check(
    logs(cleared).includes("cache-count=0"),
    "Clear invalidates old cache data",
  );
  check(
    (await api(ap + "/ci/caches")).entries.length === 0,
    "Only retired storage awaits cleanup",
  );
  let collected = false;
  for (let i = 0; i < 90; i++) {
    if ((await api(ap + "/ci/caches")).used.bytes === 0) {
      collected = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  check(collected, "Queued cache collection releases repository quota");
  console.log(
    JSON.stringify({
      checks,
      requests,
      workspace: name,
      cloud: first.id,
      restored: second.id,
      external: r2.id,
      workflowGate: failed.id,
      cache:
        "cloud/binary R2 round-trip, workflow success gate, generation clear, stale lease upload denial",
    }),
  );
} catch (error) {
  console.error(error.message);
  throw error;
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
    assert.ok(removed, "Cache fixtures collected");
  }
  console.log(
    JSON.stringify({
      cleanup:
        "repositories/workspace removed; runner revoked; temporary credentials removed",
      workspace: name,
    }),
  );
}
