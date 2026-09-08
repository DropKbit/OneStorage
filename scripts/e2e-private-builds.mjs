import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
const verifyCache = process.env.ONESTORAGE_NPM_CACHE === "1";
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
  registryRepo,
  deployToken,
  variable,
  uiBrowser,
  fork,
  runner,
  dir;
const name = "private_v27_" + crypto.randomUUID().slice(0, 8),
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
    `${method} ${path}: ${redact(raw.slice(0, 600))}`,
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
let lock = {
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
  `import {label} from '@${name}/component'; const title: string = label + '${version}'; export default {fetch(){const v = <h1>{title}</h1>; return Response.json({type: v.type, text: v.props.children})}}`;
const build = {
  runner: "worker",
  timeout_seconds: 110,
  variables: ["PACKAGE_TOKEN"],
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
const secrets = [];
const redact = (value) =>
  secrets
    .reduce((s, t) => s.replaceAll(t, "[REDACTED]"), String(value))
    .replaceAll(token || "unused-owner-secret", "[REDACTED]");
async function npm(args, cwd) {
  const env = {
    ...process.env,
    PRIVATE_BUILD_TOKEN: deployToken.token,
    NPM_CONFIG_USERCONFIG: join(dir, ".npmrc"),
    NPM_CONFIG_CACHE: join(dir, "cache"),
  };
  return new Promise((resolve, reject) => {
    const p = spawn("npm", args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      }),
      timer = setTimeout(() => p.kill("SIGTERM"), 180000);
    let output = "";
    p.stdout.on("data", (d) => (output += d));
    p.stderr.on("data", (d) => (output += d));
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(output) : reject(Error(redact(output)));
    });
  });
}
async function prepareRegistry() {
  registryRepo = await api(
    "/api/repos",
    "POST",
    { namespace: name, name: "packages", visibility: "private" },
    201,
  );
  const rp = "/api/repos/" + name + "/packages";
  deployToken = await api(
    rp + "/deploy-tokens",
    "POST",
    {
      name: "Private cloud build",
      scopes: ["read_package_registry", "write_package_registry"],
      days: 1,
    },
    201,
  );
  secrets.push(deployToken.token);
  dir = await mkdtemp(join(tmpdir(), "onestorage-private-build-"));
  const pkg = join(dir, "package"),
    consumer = join(dir, "consumer");
  await mkdir(pkg);
  await mkdir(consumer);
  const registry = origin + rp + "/packages/npm/";
  await writeFile(
    join(dir, ".npmrc"),
    "@" +
      name +
      ":registry=" +
      registry +
      "\n" +
      registry.replace(/^https?:/, "") +
      ":_authToken=${PRIVATE_BUILD_TOKEN}\n",
    { mode: 0o600 },
  );
  await writeFile(
    join(pkg, "package.json"),
    JSON.stringify({
      name: "@" + name + "/component",
      version: "1.0.0",
      main: "index.js",
    }),
  );
  await writeFile(
    join(pkg, "index.js"),
    "export const label = 'Cloud private npm ';\n",
  );
  await npm(
    [
      "publish",
      "--registry=" + registry,
      "--access=public",
      "--ignore-scripts",
    ],
    pkg,
  );
  manifest.dependencies["@" + name + "/component"] = "1.0.0";
  await writeFile(join(consumer, "package.json"), JSON.stringify(manifest));
  await npm(
    [
      "install",
      "--package-lock-only",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    consumer,
  );
  lock = JSON.parse(
    await readFile(join(consumer, "package-lock.json"), "utf8"),
  );
  check(
    !!lock.packages["node_modules/@" + name + "/component"]?.integrity,
    "Native npm lock records private dependency integrity",
  );
  variable = await api(
    ap + "/ci/variables",
    "POST",
    {
      key: "PACKAGE_TOKEN",
      value: deployToken.token,
      secret: true,
      protected: false,
      refs: ["main"],
    },
    201,
  );
  build.steps[0].private_registries = [
    { project_id: registryRepo.id, token_variable: "PACKAGE_TOKEN" },
  ];
  await writeFile(
    verifyCache
      ? ".data/v35-private-fixture.json"
      : ".data/v27-private-fixture.json",
    JSON.stringify({ space: name, repositories: [repo.id, registryRepo.id] }),
    { mode: 0o600 },
  );
  if (process.env.PLAYWRIGHT_MODULE && !remote) {
    const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
    uiBrowser = await chromium.launch({ headless: true });
    const context = await uiBrowser.newContext();
    await context.request.post(origin + "/api/login", {
      headers: { Origin: origin },
      data: { username: "owner", password: "local-test-password-123" },
    });
    const page = await context.newPage();
    await page.goto(origin + "/" + name + "/project/ci");
    await page
      .getByRole("button", { name: "私有 npm 云端构建", exact: true })
      .click();
    const config = JSON.parse(
      await page.locator("#pipeline-config textarea").inputValue(),
    );
    check(
      config.variables.includes("PACKAGE_TOKEN") &&
        config.steps[0].private_registries[0].project_id === repo.id,
      "Browser private-build template selects explicit secret and project",
    );
    await page.screenshot({
      path: ".data/v27-private-build-ui.png",
      fullPage: true,
    });
    await context.request.post(origin + "/api/logout", {
      headers: { Origin: origin },
      data: {},
    });
    await uiBrowser.close();
    uiBrowser = undefined;
  }
}
async function extraChecks() {
  await commit({ "src/index.tsx": source("three") });
  const missing = structuredClone(build);
  delete missing.steps[0].private_registries;
  const denied = await waitRun((await start(missing)).id);
  check(
    denied.status === "failed" && !denied.artifacts.length,
    "Undeclared private registry publishes nothing",
  );
  const rp = "/api/repos/" + name + "/packages/deploy-tokens/" + deployToken.id;
  const rotated = await api(rp + "/rotate", "POST", {
    revision: deployToken.revision,
  });
  secrets.push(rotated.token);
  const stale = await waitRun((await start()).id);
  check(
    stale.status === "failed" && !stale.artifacts.length,
    "Old CI secret fails after deploy-token rotation",
  );
  deployToken = rotated;
  await api(ap + "/ci/variables/" + variable.id, "PUT", {
    key: "PACKAGE_TOKEN",
    secret: true,
    protected: false,
    refs: ["main"],
    value: deployToken.token,
    revision: variable.revision,
  });
  const recovered = await done((await start()).id);
  check(
    recovered.artifacts.length > 0,
    "Updating selected encrypted variable restores native build",
  );
  await api(rp, "DELETE", { revision: deployToken.revision });
  const revoked = await waitRun((await start()).id);
  check(
    revoked.status === "failed" && !revoked.artifacts.length,
    "Revoked credential cannot publish new build",
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
    verifyCache
      ? ".data/v35-private-build-fixture.json"
      : ".data/v27-last-build-fixture.json",
    JSON.stringify({ name, repoId: repo.id, ap }),
    { mode: 0o600 },
  );
  await prepareRegistry();
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
        l.content.includes("2 integrity-verified npm packages"),
      ),
    "Native WASM build uses exact commit and verified dependency",
  );
  if (verifyCache)
    check(
      first.logs.some((l) =>
        /2 integrity-verified npm packages; npm cache enabled: 1 hits, 0 misses, 0 writes, 0 errors, 0 downloaded bytes/.test(
          l.content,
        ),
      ),
      "Only the public dependency uses warm cache; private package still follows supplied authorization path",
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
  await activate(dep1.id, null, "Cloud private npm one");
  await commit({ "src/index.tsx": source("two") });
  const second = await done((await start()).id),
    dep2 = await deployment(second);
  await activate(dep2.id, dep1.id, "Cloud private npm two");
  await activate(dep1.id, dep2.id, "Cloud private npm one");
  await api(
    ap + "/environments/preview",
    "PUT",
    { deployment_id: dep2.id, expected_deployment_id: null, public: true },
    409,
  );
  check(true, "Stale activation rejected");
  console.log(
    JSON.stringify({
      phase: "private and public npm compiled, activated and rolled back",
      checks,
    }),
  );

  const badLock = structuredClone(lock);
  badLock.packages["node_modules/@" + name + "/component"].integrity =
    "sha512-" + "A".repeat(86) + "==";
  await commit({ "package-lock.json": JSON.stringify(badLock) });
  const failed = await waitRun((await start()).id);
  check(
    failed.status === "failed" && /lock does not match/.test(failed.error),
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
        variables: ["PACKAGE_TOKEN"],
        steps: [
          {
            type: "build",
            entry: "src/client.tsx",
            outfile: "dist/client.js",
            platform: "browser",
            private_registries: [
              { project_id: registryRepo.id, token_variable: "PACKAGE_TOKEN" },
            ],
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
  await extraChecks();
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
} catch (e) {
  console.error(redact(e.message));
  throw Error(redact(e.message));
} finally {
  await uiBrowser?.close();
  if (registryRepo)
    await api("/api/admin/repositories/" + registryRepo.id, "DELETE");
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
  if (!token && cookie) await api("/api/logout", "POST", {});
  if (dir) await rm(dir, { recursive: true, force: true });
  console.log(
    JSON.stringify({
      cleanup: "repositories/workspace and hosted build fixtures removed",
      workspace: name,
    }),
  );
}
