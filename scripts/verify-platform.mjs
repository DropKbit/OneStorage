// Opt-in production acceptance; only generated workspace/repository/runner records are created.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
if (process.env.ALLOW_REMOTE_ACCEPTANCE !== "1")
  throw Error("Set ALLOW_REMOTE_ACCEPTANCE=1");
const origin = process.env.ONESTORAGE_ORIGIN || "https://git.1s.hk",
  token = (await readFile(process.env.ONESTORAGE_TOKEN_FILE, "utf8")).trim();
let checks = 0;
async function req(
  path,
  method = "GET",
  body,
  status = 200,
  authenticated = true,
) {
  const r = await fetch(origin + path, {
    method,
    headers: {
      ...(authenticated ? { Authorization: "Bearer " + token } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const text = await r.text();
  assert.equal(
    r.status,
    status,
    method + " " + path + ": " + text.slice(0, 300),
  );
  checks++;
  return text && r.headers.get("content-type")?.includes("json")
    ? JSON.parse(text)
    : text;
}
assert.equal((await req("/api/health")).version, "0.4.0");
await req("/api/admin/overview");
await req("/api/admin/overview", "GET", undefined, 401, false);
const slug = "accept_v04_" + crypto.randomUUID().slice(0, 8),
  workspace = await req(
    "/api/workspaces",
    "POST",
    { slug, name: "v0.4 acceptance" },
    201,
  );
let repo;
try {
  repo = await req(
    "/api/repos",
    "POST",
    { namespace: slug, name: "ci-check", visibility: "private" },
    201,
  );
  const ap = "/api/repos/" + slug + "/ci-check",
    root = ap + "/ci";
  assert.equal((await req(ap)).role, "owner");
  assert.equal(
    (await req("/api/repos?namespace=" + slug)).repositories.length,
    1,
  );
  await req(root + "/runs", "GET", undefined, 401, false);
  const config = {
    name: "Cloud checks",
    runner: "worker",
    branches: ["main"],
    steps: [{ type: "file", path: "package.json", format: "json" }],
  };
  await req(root + "/config", "PUT", { config, enabled: true });
  const commit = await req(
    ap + "/commit-files",
    "POST",
    {
      target_branch: "main",
      commit_message: "Cloud platform acceptance",
      files: [
        {
          path: "package.json",
          content: JSON.stringify({
            name: "ci-acceptance",
            version: "1.0.0",
            private: true,
            scripts: { test: "node test.cjs" },
          }),
        },
        {
          path: "test.cjs",
          content:
            "require('node:fs').writeFileSync('result.txt',process.env.ONESTORAGE_COMMIT_SHA);console.log('Cloud runner test passed')",
        },
      ],
    },
    201,
  );
  async function wait(id) {
    for (let i = 0; i < 60; i++) {
      const r = await req(root + "/runs/" + id);
      if (!["running", "queued"].includes(r.status)) {
        assert.equal(r.status, "succeeded", JSON.stringify(r));
        return r;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw Error("Cloud run timed out");
  }
  let automatic;
  for (let i = 0; i < 40; i++) {
    automatic = (await req(root + "/runs")).runs.find(
      (r) => r.trigger === "push",
    );
    if (automatic) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.ok(automatic);
  await wait(automatic.id);
  const manual = await req(root + "/runs", "POST", {}, 201);
  await wait(manual.id);
  const external = {
    name: "Cloud external runner",
    runner: "external",
    branches: ["main"],
    steps: [{ type: "run", name: "npm test", command: "npm test" }],
    artifacts: ["result.txt"],
  };
  await req(root + "/config", "PUT", { config: external, enabled: true });
  const runner = await req(
      root + "/runners",
      "POST",
      { name: "temporary-acceptance" },
      201,
    ),
    run = await req(root + "/runs", "POST", {}, 201);
  const dir = await mkdtemp(join(tmpdir(), "onestorage-cloud-runner-")),
    file = join(dir, "token");
  await writeFile(file, runner.token, { mode: 0o600 });
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["scripts/runner.mjs"], {
        env: {
          ...process.env,
          ONESTORAGE_ORIGIN: origin,
          ONESTORAGE_RUNNER_TOKEN_FILE: file,
          ONESTORAGE_RUNNER_ONCE: "1",
          ONESTORAGE_JOB_ENV: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (b) => (out += b));
      child.stderr.on("data", (b) => (out += b));
      child.on("exit", (code) => (code === 0 ? resolve() : reject(Error(out))));
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const finished = await wait(run.id);
  assert.equal(finished.artifacts.length, 1);
  assert.equal(
    await req(
      root + "/runs/" + run.id + "/artifacts/" + finished.artifacts[0].id,
    ),
    commit.sha,
  );
  await req(root + "/runners/" + runner.id, "DELETE");
  const bundle = await req(ap + "/browse?path=&view=tree");
  assert.equal(bundle.data.ref, commit.sha);
  await req("/api/admin/repositories/" + repo.id, "PATCH", {
    description: "Verified platform controls",
    visibility: "private",
  });
  console.log(
    "Core checks passed: " +
      checks +
      " cloud platform checks including workspace creation, push-triggered Worker CI, external npm runner, logs, R2 artifact and admin metadata",
  );
} finally {
  if (repo) await req("/api/admin/repositories/" + repo.id, "DELETE");
  for (let i = 0; i < 120; i++) {
    const r = await fetch(origin + "/api/workspaces/" + slug, {
      method: "DELETE",
      headers: { Authorization: "Bearer " + token },
    });
    if (r.ok) break;
    if (r.status !== 409) throw Error("Workspace cleanup failed " + r.status);
    await new Promise((r) => setTimeout(r, 1000));
    if (i === 119) throw Error("Workspace cleanup timed out");
  }
}

console.log("PASS: cloud acceptance and generated workspace cleanup completed");
