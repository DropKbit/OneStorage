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
const name = "build_v22_" + crypto.randomUUID().slice(0, 8),
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
const manifest = { dependencies: { preact: "10.29.3" } };
const lock = {
  lockfileVersion: 3,
  packages: {
    "": manifest,
    "node_modules/preact": {
      version: "10.29.3",
      resolved: "https://registry.npmjs.org/preact/-/preact-10.29.3.tgz",
      integrity:
        "sha512-D9NL1GAnJZhc3RndVs4gDdxEeU9TcHgywMrhhOsnpdlvFjdbx0gAsLUnH6JEhlJH5giL7Tx5biWPUSEXE/HPzw==",
    },
  },
};
const source = (version) =>
  `import {label} from './label'; const title: string = label + '${version}'; export default {fetch(){const v = <h1>{title}</h1>; return Response.json({type: v.type, text: v.props.children})}}`;
const build = {
  runner: "worker",
  timeout_seconds: 110,
  steps: [
    { type: "build", entry: "src/index.tsx", jsx_import_source: "preact" },
  ],
  deploy: {
    kind: "worker",
    entry: "dist/index.js",
    files: ["dist/index.js"],
    environment: "preview",
  },
};
async function start(config = build) {
  await api(ap + "/ci/config", "PUT", { config, enabled: false });
  return api(ap + "/ci/runs", "POST", { ref: "main" }, 201);
}
async function deployment(run) {
  const result = (await api(ap + "/deployments")).deployments.find(
    (d) => d.run_id === run.id,
  );
  check(!!result && result.sha === run.sha, "Deployment tied to source SHA");
  return result;
}
async function activate(id, expected, expectedText) {
  await api(ap + "/environments/preview", "PUT", {
    deployment_id: id,
    expected_deployment_id: expected,
    public: true,
  });
  const originApps =
    process.env.TEST_APPS_ORIGIN ||
    (remote
      ? "https://onestorage-apps.xbitfun.workers.dev"
      : "http://localhost:8789");
  const r = await fetch(originApps + "/apps/" + repo.id + "/preview/", {
    signal: AbortSignal.timeout(30000),
  });
  check(r.status === 200, "Hosted compiled Worker responds");
  assert.deepEqual(await r.json(), { type: "h1", text: expectedText });
  checks++;
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
    { slug: name, name: "Cloud build acceptance" },
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
    ".data/v22-last-fixture.json",
    JSON.stringify({ name, repoId: repo.id, ap }),
    { mode: 0o600 },
  );
  const initial = await commit({
    "src/index.tsx": source("one"),
    "src/label.ts": "export const label: string = 'Cloud npm ';",
    "package.json": JSON.stringify(manifest),
    "package-lock.json": JSON.stringify(lock),
  });
  const first = await done((await start()).id);
  check(
    first.sha === initial.sha &&
      first.logs.some((l) =>
        l.content.includes("1 integrity-verified npm packages"),
      ),
    "Native WASM build uses exact commit and verified dependency",
  );
  const artifact = first.artifacts.find((a) => a.name === "dist/index.js");
  check(
    !!artifact && artifact.size > 1000,
    "Compiled npm bundle persisted in R2",
  );
  const js = await api(
    ap + "/ci/runs/" + first.id + "/artifacts/" + artifact.id,
  );
  check(!js.includes("const title: string"), "TypeScript syntax erased");
  const dep1 = await deployment(first);
  await activate(dep1.id, null, "Cloud npm one");
  await commit({ "src/index.tsx": source("two") });
  const second = await done((await start()).id),
    dep2 = await deployment(second);
  await activate(dep2.id, dep1.id, "Cloud npm two");
  await activate(dep1.id, dep2.id, "Cloud npm one");
  await api(
    ap + "/environments/preview",
    "PUT",
    { deployment_id: dep2.id, expected_deployment_id: null, public: true },
    409,
  );
  check(true, "Stale activation rejected");

  const badLock = structuredClone(lock);
  badLock.packages["node_modules/preact"].integrity =
    "sha512-" + "A".repeat(86) + "==";
  await commit({ "package-lock.json": JSON.stringify(badLock) });
  const failed = await waitRun((await start()).id);
  check(
    failed.status === "failed" && /integrity mismatch/.test(failed.error),
    "Tampered npm tar checksum fails pipeline",
  );
  check(
    !failed.artifacts.length &&
      !(await api(ap + "/deployments")).deployments.some(
        (d) => d.run_id === failed.id,
      ),
    "Failed build publishes no artifact or application",
  );

  await commit({
    "package-lock.json": JSON.stringify(lock),
    "src/index.tsx": "import fs from 'node:fs'; export default fs",
  });
  const unsupported = await waitRun((await start()).id);
  check(
    unsupported.status === "failed" &&
      /Unsupported import/.test(unsupported.error),
    "Native filesystem import fails at build time",
  );
  await commit({
    "src/client.tsx":
      "import './style.css'; document.body.textContent = 'browser build';",
    "src/style.css": "body { color: rgb(20, 40, 60); }",
    "index.html":
      '<!doctype html><link rel="stylesheet" href="dist/client.css"><script type="module" src="dist/client.js"></script>',
  });
  const browser = await done(
    (
      await start({
        runner: "worker",
        steps: [
          {
            type: "build",
            entry: "src/client.tsx",
            outfile: "dist/client.js",
            platform: "browser",
          },
        ],
        deploy: {
          kind: "static",
          environment: "web",
          entry: "index.html",
          files: ["index.html", "dist/client.js", "dist/client.css"],
        },
      })
    ).id,
  );
  check(
    browser.artifacts.some((a) => a.name === "dist/client.css") &&
      browser.artifacts.some((a) => a.name === "dist/client.js"),
    "Browser build preserves JS and CSS outputs",
  );
  const webDep = await deployment(browser);
  await api(ap + "/environments/web", "PUT", {
    deployment_id: webDep.id,
    expected_deployment_id: null,
    public: true,
  });
  const originApps =
    process.env.TEST_APPS_ORIGIN ||
    (remote
      ? "https://onestorage-apps.xbitfun.workers.dev"
      : "http://localhost:8789");
  for (const path of ["", "dist/client.js", "dist/client.css"]) {
    const r = await fetch(originApps + "/apps/" + repo.id + "/web/" + path, {
      signal: AbortSignal.timeout(30000),
    });
    check(r.ok, "Static compiled asset served: " + path);
    await r.body.cancel();
  }
  console.log(
    JSON.stringify({
      checks,
      requests,
      workspace: name,
      first: first.id,
      second: second.id,
      failed: failed.id,
      browser: browser.id,
    }),
  );
} finally {
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
      await response.body?.cancel();
      if (response.status === 200) {
        removed = true;
        break;
      }
      assert.equal(response.status, 409);
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert.ok(removed, "Build fixtures collected");
  }
  console.log(
    JSON.stringify({
      cleanup: "repositories/workspace and hosted build fixtures removed",
      workspace: name,
    }),
  );
}
