import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
const origin = process.env.TEST_ORIGIN || "http://localhost:8787";
if (!["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw Error("Local tests only");
const suffix = randomBytes(4).toString("hex"),
  admin = process.env.TEST_ADMIN_USERNAME || "owner",
  password = process.env.TEST_ADMIN_PASSWORD || "local-test-password-123";
let checks = 0;
async function req(
  path,
  method = "GET",
  body,
  cookie = "",
  status = 200,
  headers = {},
) {
  const r = await fetch(origin + path, {
    method,
    headers: {
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await r.text();
  assert.equal(
    r.status,
    status,
    method + " " + path + ": " + raw.slice(0, 250),
  );
  checks++;
  return {
    data:
      raw && r.headers.get("content-type")?.includes("json")
        ? JSON.parse(raw)
        : raw,
    cookie: r.headers.get("set-cookie")?.split(";")[0],
  };
}
const ac = (await req("/api/login", "POST", { username: admin, password }))
  .cookie;
const dev = "dev_" + suffix,
  reader = "read_" + suffix;
const devUser = (
  await req("/api/users", "POST", { username: dev, password }, ac, 201)
).data;
await req("/api/users", "POST", { username: reader, password }, ac, 201);
const dc = (await req("/api/login", "POST", { username: dev, password }))
    .cookie,
  rc = (await req("/api/login", "POST", { username: reader, password })).cookie;
const slug = "team_" + suffix,
  w = (
    await req(
      "/api/workspaces",
      "POST",
      { slug, name: "Platform test" },
      ac,
      201,
    )
  ).data;
await req(
  "/api/workspaces",
  "POST",
  { slug: admin, name: "Collision" },
  ac,
  409,
);
await req("/api/users", "POST", { username: slug, password }, ac, 409);
await req(
  "/api/workspaces/" + slug + "/members",
  "PUT",
  { username: dev, role: "developer" },
  ac,
);
await req(
  "/api/workspaces/" + slug + "/members",
  "PUT",
  { username: reader, role: "reader" },
  ac,
);
await req(
  "/api/workspaces/" + slug + "/members",
  "PUT",
  { username: dev, role: "owner" },
  dc,
  403,
);
await req(
  "/api/workspaces/" + slug + "/members/" + admin,
  "DELETE",
  undefined,
  ac,
  409,
);
const repo = (
    await req("/api/repos", "POST", { namespace: slug, name: "app" }, dc, 201)
  ).data,
  ap = "/api/repos/" + slug + "/app";
assert.equal(repo.namespace, slug);
assert.equal((await req(ap, "GET", undefined, dc)).data.role, "developer");
assert.equal((await req(ap, "GET", undefined, ac)).data.role, "owner");
assert.ok(
  (
    await req("/api/repos?namespace=" + slug, "GET", undefined, rc)
  ).data.repositories.some((r) => r.id === repo.id),
);
await req("/api/repos", "POST", { namespace: slug, name: "blocked" }, rc, 403);
await req(
  "/api/workspaces/" + slug + "/members/" + dev,
  "DELETE",
  undefined,
  ac,
);
await req(ap, "GET", undefined, dc, 404);
await req("/api/repo-url/" + repo.id, "GET", undefined, dc, 404);
assert.equal(
  (await req("/api/repos?namespace=" + slug, "GET", undefined, dc)).data
    .repositories.length,
  0,
);
await req(
  "/api/workspaces/" + slug + "/members",
  "PUT",
  { username: dev, role: "developer" },
  ac,
);
const pkg = {
  name: "runner-fixture",
  version: "1.0.0",
  private: true,
  scripts: { test: "node test.cjs" },
};
const first = (
  await req(
    ap + "/commit-files",
    "POST",
    {
      target_branch: "main",
      commit_message: "CI fixture",
      files: [
        { path: "package.json", content: JSON.stringify(pkg) },
        {
          path: "package-lock.json",
          content: JSON.stringify({
            name: pkg.name,
            version: "1.0.0",
            lockfileVersion: 3,
            requires: true,
            packages: { "": { name: pkg.name, version: "1.0.0" } },
          }),
        },
        {
          path: "test.cjs",
          content:
            "const fs=require('node:fs'); console.log('npm test passed'); console.log(process.env.CI_TEST_SECRET); fs.writeFileSync('artifact.txt','built:'+process.env.ONESTORAGE_COMMIT_SHA);",
        },
      ],
    },
    dc,
    201,
  )
).data;
const token = (
  await req("/api/tokens", "POST", { name: "git-platform-test" }, dc, 201)
).data.token;
await req(
  "/" + slug + "/app.git/info/refs?service=git-upload-pack",
  "GET",
  undefined,
  "",
  200,
  {
    Authorization: "Basic " + Buffer.from(dev + ":" + token).toString("base64"),
  },
);
await req("/api/admin/overview", "GET", undefined, dc, 403);
const overview = (await req("/api/admin/overview", "GET", undefined, ac)).data;
assert.ok(overview.workspaces > 0);
const self = (await req("/api/me", "GET", undefined, ac)).data.user;
await req("/api/admin/users/" + self.id, "PATCH", { disabled: true }, ac, 409);
await req("/api/admin/users/" + devUser.id, "PATCH", { disabled: true }, ac);
await req(ap, "GET", undefined, "", 401, { Authorization: "Bearer " + token });
await req("/api/login", "POST", { username: dev, password }, "", 401);
await req("/api/admin/users/" + devUser.id, "PATCH", { disabled: false }, ac);
const root = ap + "/ci",
  workerConfig = {
    name: "JSON checks",
    runner: "worker",
    branches: ["main"],
    steps: [{ type: "file", path: "package.json", format: "json" }],
  };
await req(
  root + "/config",
  "PUT",
  { config: workerConfig, enabled: true },
  rc,
  403,
);
await req(root + "/config", "PUT", { config: workerConfig, enabled: true }, ac);
const check = (await req(root + "/runs", "POST", {}, ac, 201)).data;
async function waitRun(id, expected) {
  for (let i = 0; i < 80; i++) {
    const row = (await req(root + "/runs/" + id, "GET", undefined, ac)).data;
    if (!["queued", "running"].includes(row.status)) {
      assert.equal(row.status, expected, JSON.stringify(row));
      return row;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw Error("Run timeout " + id);
}
await waitRun(check.id, "succeeded");
await req(
  ap + "/commit-files",
  "POST",
  {
    target_branch: "main",
    commit_message: "Trigger CI",
    files: [{ path: "README.md", content: "auto trigger" }],
  },
  ac,
  201,
);
let automatic;
for (let i = 0; i < 60; i++) {
  automatic = (await req(root + "/runs", "GET", undefined, ac)).data.runs.find(
    (r) => r.trigger === "push" && r.sha !== first.sha,
  );
  if (automatic) break;
  await new Promise((r) => setTimeout(r, 500));
}
assert.ok(automatic);
await waitRun(automatic.id, "succeeded");
const external = {
  name: "npm build",
  runner: "external",
  branches: ["main"],
  timeout_seconds: 120,
  steps: [
    {
      type: "run",
      name: "Install and test",
      command: "npm ci --ignore-scripts && npm test",
    },
  ],
  artifacts: ["artifact.txt"],
};
await req(root + "/config", "PUT", { config: external, enabled: false }, ac);
const runner = (
    await req(root + "/runners", "POST", { name: "e2e runner" }, ac, 201)
  ).data,
  run = (await req(root + "/runs", "POST", {}, ac, 201)).data;
const dir = await mkdtemp(join(tmpdir(), "onestorage-runner-test-")),
  file = join(dir, "token");
await writeFile(file, runner.token, { mode: 0o600 });
try {
  await new Promise((ok, bad) => {
    const proc = spawn(process.execPath, ["scripts/runner.mjs"], {
      env: {
        ...process.env,
        ONESTORAGE_ORIGIN: origin,
        ONESTORAGE_RUNNER_TOKEN_FILE: file,
        ONESTORAGE_RUNNER_ONCE: "1",
        ONESTORAGE_JOB_ENV: "CI_TEST_SECRET",
        CI_TEST_SECRET: "test-secret-redact-" + suffix,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    proc.stdout.on("data", (b) => (output += b));
    proc.stderr.on("data", (b) => (output += b));
    proc.on("exit", (code) => (code === 0 ? ok() : bad(Error(output))));
  });
} finally {
  await rm(dir, { recursive: true, force: true });
}
const done = await waitRun(run.id, "succeeded");
assert.ok(done.logs.some((l) => l.content.includes("npm test passed")));
assert.ok(!JSON.stringify(done).includes("test-secret-redact-" + suffix));
assert.ok(done.logs.some((l) => l.content.includes("[REDACTED]")));
assert.equal(done.artifacts.length, 1);
assert.equal(
  (
    await req(
      root + "/runs/" + run.id + "/artifacts/" + done.artifacts[0].id,
      "GET",
      undefined,
      ac,
    )
  ).data,
  "built:" + done.sha,
);
const canceled = (await req(root + "/runs", "POST", {}, ac, 201)).data;
const claim = (
  await req("/api/runner/claim", "POST", {}, "", 200, {
    Authorization: "Bearer " + runner.token,
  })
).data;
assert.equal(claim.run.id, canceled.id);
assert.equal(
  (
    await req("/api/runner/claim", "POST", {}, "", 200, {
      Authorization: "Bearer " + runner.token,
    })
  ).data.run,
  null,
);
await req(root + "/runs/" + canceled.id + "/cancel", "POST", {}, ac);
await req(
  "/api/runner/runs/" + canceled.id + "/complete",
  "POST",
  { status: "succeeded" },
  "",
  409,
  { Authorization: "Bearer " + runner.token, "X-Run-Lease": claim.lease },
);
await req(root + "/runners/" + runner.id, "DELETE", undefined, ac);
await req("/api/runner/claim", "POST", {}, "", 401, {
  Authorization: "Bearer " + runner.token,
});
await req("/api/admin/audit", "GET", undefined, ac);
await req(
  "/api/admin/repositories/" + repo.id,
  "PATCH",
  { description: "Managed by admin", visibility: "private" },
  ac,
);
await req("/api/admin/repositories/" + repo.id, "DELETE", undefined, rc, 403);
await req("/api/admin/repositories/" + repo.id, "DELETE", undefined, ac);
console.log(
  "PASS: " +
    checks +
    " platform HTTP assertions, npm runner/artifact/redaction, push-triggered Worker CI, workspace inheritance and admin revocation",
);
