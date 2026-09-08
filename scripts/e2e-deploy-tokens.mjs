import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
const origin = process.env.TEST_ORIGIN || "http://localhost:8787",
  remote = !["localhost", "127.0.0.1"].includes(new URL(origin).hostname);
if (remote && process.env.ALLOW_REMOTE_ACCEPTANCE !== "1")
  throw Error("Remote acceptance requires opt-in");
let ownerToken = process.env.ONESTORAGE_TOKEN_FILE
    ? (await readFile(process.env.ONESTORAGE_TOKEN_FILE, "utf8")).trim()
    : "",
  cookie = "",
  minted,
  checks = 0,
  requests = 0,
  browser;
const root = await mkdtemp(join(tmpdir(), "onestorage-deploy-")),
  space = "deploy_v26_" + crypto.randomUUID().slice(0, 8),
  second = space + "b",
  createdSpaces = [],
  repos = [],
  secrets = [];
let ap = `/api/repos/${space}/project`,
  gitURL = `${origin}/${space}/project.git`;
const scopes = [
  "read_repository",
  "read_package_registry",
  "write_package_registry",
  "delete_package_registry",
];
const check = (condition, message) => {
  assert.ok(condition, message);
  checks++;
};
const redact = (text) =>
  secrets
    .reduce((s, secret) => s.replaceAll(secret, "[REDACTED]"), String(text))
    .replaceAll(ownerToken || "unused-owner-token", "[REDACTED]");
async function request(
  path,
  method = "GET",
  body,
  expected = 200,
  credential = ownerToken,
  extra = {},
) {
  const response = await fetch(origin + path, {
    method,
    headers: {
      Origin: origin,
      ...(credential
        ? { Authorization: "Bearer " + credential }
        : { Cookie: cookie }),
      ...(body !== undefined && !(body instanceof Uint8Array)
        ? { "content-type": "application/json" }
        : {}),
      ...extra,
    },
    body:
      body === undefined
        ? undefined
        : body instanceof Uint8Array
          ? body
          : JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  requests++;
  if (path === "/api/login")
    cookie = response.headers.get("set-cookie")?.split(";")[0] || "";
  if (response.status !== expected)
    throw Error(
      redact(
        `${method} ${path}: expected ${expected}, got ${response.status}: ${(await response.text()).slice(0, 700)}`,
      ),
    );
  return response;
}
async function api(...args) {
  return (await request(...args)).json();
}
async function token(path, name, selected = scopes) {
  const t = await api(
    path + "/deploy-tokens",
    "POST",
    { name, scopes: selected, days: 1 },
    201,
  );
  secrets.push(t.token);
  return t;
}
const credentialsFile = join(root, "git.json"),
  askpass = join(root, "askpass.cjs");
await writeFile(
  askpass,
  '#!/usr/bin/env node\nconst fs=require("node:fs"),v=JSON.parse(fs.readFileSync(process.env.ONESTORAGE_TEST_GIT_AUTH,"utf8"));process.stdout.write(/username/i.test(process.argv[2]||"")?v.username:v.token);\n',
  { mode: 0o700 },
);
async function command(executable, args, cwd, env = {}, success = true) {
  return new Promise((resolve, reject) => {
    const variables = { ...process.env, ...env };
    for (const key of ["GIT_CURL_VERBOSE", "GIT_TRACE_CURL", "GIT_TRACE"])
      delete variables[key];
    const child = spawn(executable, args, {
      cwd,
      env: variables,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 180000);
    child.stdout.on("data", (b) => (output += b));
    child.stderr.on("data", (b) => (output += b));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (success ? code !== 0 : code === 0)
        reject(
          Error(
            redact(
              `${executable} ${args[0]} exited ${code}: ${output.slice(-1800)}`,
            ),
          ),
        );
      else resolve(redact(output));
    });
  });
}
async function git(args, cwd, auth, success = true) {
  await writeFile(credentialsFile, JSON.stringify(auth), { mode: 0o600 });
  return command(
    "git",
    [
      "-c",
      "credential.helper=",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    cwd,
    {
      GIT_ASKPASS: askpass,
      GIT_TERMINAL_PROMPT: "0",
      ONESTORAGE_TEST_GIT_AUTH: credentialsFile,
    },
    success,
  );
}
async function npm(args, cwd, deploy) {
  const registry = origin + ap + "/packages/npm/",
    config = join(root, ".npmrc");
  await writeFile(
    config,
    `${registry.replace(/^https?:/, "")}:_authToken=\${ONESTORAGE_DEPLOY_TOKEN}\n`,
    { mode: 0o600 },
  );
  return command(
    "npm",
    [
      ...args,
      "--registry=" + registry,
      "--userconfig=" + config,
      "--cache=" + join(root, "npm-cache"),
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--fetch-retries=0",
    ],
    cwd,
    {
      ONESTORAGE_DEPLOY_TOKEN: deploy.token,
      npm_config_loglevel: "error",
      npm_config_update_notifier: "false",
    },
  );
}
try {
  if (!ownerToken) {
    await api("/api/login", "POST", {
      username: "owner",
      password: "local-test-password-123",
    });
    minted = await api(
      "/api/tokens",
      "POST",
      { name: space, scope: "write", days: 1 },
      201,
    );
    ownerToken = minted.token;
  }
  const owner = (await api("/api/me")).user;
  for (const slug of [space, second]) {
    await api(
      "/api/workspaces",
      "POST",
      { slug, name: "Deploy token acceptance" },
      201,
    );
    createdSpaces.push(slug);
  }
  const project = await api(
    "/api/repos",
    "POST",
    { namespace: space, name: "project", visibility: "private" },
    201,
  );
  repos.push(project);
  const sibling = await api(
    "/api/repos",
    "POST",
    { namespace: space, name: "sibling", visibility: "private" },
    201,
  );
  repos.push(sibling);
  const outside = await api(
    "/api/repos",
    "POST",
    { namespace: second, name: "outside", visibility: "public" },
    201,
  );
  repos.push(outside);
  await writeFile(
    ".data/v26-last-fixture.json",
    JSON.stringify({
      spaces: createdSpaces,
      repositories: repos.map((r) => r.id),
      space,
      second,
    }),
    { mode: 0o600 },
  );
  const projectToken = await token(ap, "Project automation"),
    groupToken = await token(
      "/api/workspaces/" + space,
      "Workspace automation",
    ),
    readToken = await token(ap, "Packages read", ["read_package_registry"]),
    writeToken = await token(ap, "Packages publish", [
      "write_package_registry",
    ]);
  const list = await api(ap + "/deploy-tokens");
  check(
    list.tokens.length === 3 && list.tokens.every((t) => !t.token && !t.hash),
    "Only creation returns deploy secrets",
  );
  for (const [path, method] of [
    ["/api/me", "GET"],
    ["/api/tokens", "GET"],
    ["/api/admin/users", "GET"],
    [ap + "/issues", "POST"],
    [ap + "/deploy-tokens", "POST"],
    [ap + "/ci/runs", "POST"],
  ]) {
    await request(
      path,
      method,
      method === "POST" ? {} : undefined,
      403,
      projectToken.token,
    );
    checks++;
  }
  await request(
    `/api/repos/${space}/sibling/packages`,
    "GET",
    undefined,
    403,
    projectToken.token,
  );
  checks++;
  await request(
    `/api/repos/${second}/outside/packages`,
    "GET",
    undefined,
    403,
    groupToken.token,
  );
  checks++;
  await request(ap + "/packages", "GET", undefined, 401, projectToken.token, {
    Authorization: "Basic " + btoa("wrong:" + projectToken.token),
  });
  checks++;
  await request(ap + "/packages", "GET", undefined, 200, projectToken.token, {
    Authorization:
      "Basic " + btoa(projectToken.username + ":" + projectToken.token),
  });
  checks++;
  const work = join(root, "work");
  await mkdir(work);
  const ownerAuth = { username: owner.username, token: ownerToken };
  await git(["init", "-b", "main"], work, ownerAuth);
  await git(["config", "user.name", "Deploy acceptance"], work, ownerAuth);
  await git(
    ["config", "user.email", "deploy@example.invalid"],
    work,
    ownerAuth,
  );
  await writeFile(join(work, "README.md"), "# Deployment access\n");
  await git(["add", "."], work, ownerAuth);
  await git(["commit", "-m", "Deployment fixture"], work, ownerAuth);
  await git(["remote", "add", "origin", gitURL], work, ownerAuth);
  await git(["push", "-u", "origin", "main"], work, ownerAuth);
  const clone = join(root, "clone");
  await git(["clone", gitURL, clone], root, projectToken);
  await git(["fsck", "--strict"], clone, projectToken);
  checks++;
  await git(["config", "user.name", "Deploy acceptance"], clone, projectToken);
  await git(
    ["config", "user.email", "deploy@example.invalid"],
    clone,
    projectToken,
  );
  await writeFile(join(clone, "forbidden.txt"), "No write scope\n");
  await git(["add", "."], clone, projectToken);
  await git(["commit", "-m", "Forbidden deploy push"], clone, projectToken);
  await git(["push", "origin", "main"], clone, projectToken, false);
  checks++;
  await git(["ls-remote", gitURL], root, readToken, false);
  checks++;
  const lfs = new TextEncoder().encode("deploy-token-lfs"),
    lfsHash = createHash("sha256").update(lfs).digest("hex"),
    lfsBase = `/${space}/project.git/info/lfs/objects`;
  await request(lfsBase + "/" + lfsHash, "PUT", lfs, 200, ownerToken, {
    "content-type": "application/octet-stream",
  });
  const batch = await api(
    lfsBase + "/batch",
    "POST",
    { operation: "download", objects: [{ oid: lfsHash, size: lfs.length }] },
    200,
    projectToken.token,
  );
  check(
    batch.objects[0].authenticated && batch.objects[0].actions.download,
    "Deployment Git scope supports LFS download batch",
  );
  const lfsRead = await request(
    lfsBase + "/" + lfsHash,
    "GET",
    undefined,
    200,
    projectToken.token,
  );
  check(
    createHash("sha256")
      .update(new Uint8Array(await lfsRead.arrayBuffer()))
      .digest("hex") === lfsHash,
    "Deployment LFS bytes verified",
  );
  await request(
    lfsBase + "/batch",
    "POST",
    { operation: "upload", objects: [{ oid: lfsHash, size: lfs.length }] },
    403,
    projectToken.token,
  );
  checks++;
  const data = new TextEncoder().encode("scoped-package"),
    hash = createHash("sha256").update(data).digest("hex"),
    extra = {
      "content-type": "application/octet-stream",
      "x-package-sha256": hash,
    },
    generic = "/packages/generic/tool/1/data.bin";
  const pkg = await api(
    ap + generic,
    "PUT",
    data,
    201,
    writeToken.token,
    extra,
  );
  checks++;
  await request(ap + "/packages", "GET", undefined, 403, writeToken.token);
  checks++;
  const downloaded = await request(
    ap + generic,
    "GET",
    undefined,
    200,
    readToken.token,
  );
  check(
    (await downloaded.text()) === "scoped-package",
    "Independent package read scope",
  );
  await request(ap + generic + "2", "PUT", data, 403, readToken.token, extra);
  checks++;
  await request(
    ap + "/packages/versions/" + pkg.version_id,
    "DELETE",
    undefined,
    403,
    writeToken.token,
  );
  checks++;
  await api(
    `/api/repos/${space}/sibling` + generic,
    "PUT",
    data,
    201,
    groupToken.token,
    extra,
  );
  checks++;
  const future = await api(
    "/api/repos",
    "POST",
    { namespace: space, name: "future", visibility: "private" },
    201,
  );
  repos.push(future);
  await request(
    `/api/repos/${space}/future/packages`,
    "GET",
    undefined,
    200,
    groupToken.token,
  );
  checks++;
  const npmDir = join(root, "npm");
  await mkdir(npmDir);
  const name = "@" + space + "/demo";
  await writeFile(
    join(npmDir, "package.json"),
    JSON.stringify({ name, version: "1.0.0", main: "index.cjs" }),
  );
  await writeFile(
    join(npmDir, "index.cjs"),
    "module.exports = 'deploy-token-package';\n",
  );
  await npm(["publish", "--access=restricted"], npmDir, projectToken);
  checks++;
  const install = join(root, "install");
  await mkdir(install);
  await writeFile(
    join(install, "package.json"),
    '{"name":"consumer","version":"1.0.0","private":true}',
  );
  await npm(["install", name + "@1.0.0"], install, readToken);
  check(
    (
      await readFile(join(install, "node_modules", name, "index.cjs"), "utf8")
    ).includes("deploy-token-package"),
    "Native npm deploy-token install",
  );
  await npm(
    ["dist-tag", "add", name + "@1.0.0", "stable"],
    npmDir,
    projectToken,
  );
  await npm(["unpublish", name + "@1.0.0", "--force"], npmDir, projectToken);
  checks++;
  const rotated = await api(
    ap + "/deploy-tokens/" + projectToken.id + "/rotate",
    "POST",
    { revision: projectToken.revision, days: 1 },
  );
  secrets.push(rotated.token);
  await request(ap + "/packages", "GET", undefined, 401, projectToken.token);
  checks++;
  await git(["ls-remote", gitURL], root, projectToken, false);
  checks++;
  await git(["ls-remote", gitURL], root, rotated);
  checks++;
  await request(
    ap + "/deploy-tokens/" + projectToken.id + "/rotate",
    "POST",
    { revision: 1 },
    409,
  );
  checks++;
  await api(ap + "/lifecycle", "PUT", { archived: true, revision: 0 });
  await git(["ls-remote", gitURL], root, rotated);
  checks++;
  await request(ap + generic + "3", "PUT", data, 409, rotated.token, extra);
  checks++;
  await api(ap + "/lifecycle", "PUT", { archived: false, revision: 1 });
  const renamed = await api(ap + "/transfer", "POST", {
    namespace: space,
    name: "renamed",
    revision: 2,
  });
  const oldAPI = ap;
  ap = `/api/repos/${space}/renamed`;
  gitURL = `${origin}/${space}/renamed.git`;
  await git(["ls-remote", gitURL], root, rotated);
  checks++;
  const redirected = await fetch(origin + oldAPI + "/packages", {
    redirect: "manual",
    headers: { Authorization: "Bearer " + rotated.token },
  });
  check(
    redirected.status === 307,
    "Same-space rename preserves project deploy token",
  );
  await redirected.arrayBuffer();
  if (process.env.PLAYWRIGHT_MODULE && !remote) {
    const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await context.addCookies([
      {
        name: "onestorage_session",
        value: cookie.split("=").slice(1).join("="),
        url: origin,
      },
    ]);
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin + `/${space}/renamed/settings`);
    await page.getByRole("link", { name: "部署令牌", exact: true }).click();
    await page
      .locator('#deploy-token-create input[name="name"]')
      .fill("Browser credential");
    await page.getByRole("button", { name: "创建令牌", exact: true }).click();
    await page.locator("#deploy-secret-value").waitFor();
    const secret = await page.locator("#deploy-secret-value").inputValue();
    secrets.push(secret);
    check(/^odt_/.test(secret), "Browser creates a scoped deploy token");
    await page.getByRole("button", { name: "已保存，清除显示" }).click();
    const article = page
      .locator("[data-deploy-token]")
      .filter({ hasText: "Browser credential" });
    const id = await article.getAttribute("data-deploy-token");
    await article.getByText("轮换令牌", { exact: true }).click();
    page.once("dialog", (d) => d.accept());
    await article.getByRole("button", { name: "确认轮换" }).click();
    await page.locator("#deploy-secret-value").waitFor();
    const replacement = await page.locator("#deploy-secret-value").inputValue();
    secrets.push(replacement);
    check(
      replacement !== secret,
      "Browser rotates token and shows replacement once",
    );
    await page.getByRole("button", { name: "已保存，清除显示" }).click();
    page.once("dialog", (d) => d.accept());
    await page
      .locator(`[data-deploy-token="${id}"]`)
      .getByRole("button", { name: "撤销令牌" })
      .click();
    await page
      .locator(`[data-deploy-token="${id}"]`)
      .getByText("已撤销", { exact: true })
      .waitFor();
    checks++;
    await page.screenshot({
      path: ".data/v26-project-deploy-ui.png",
      fullPage: true,
    });
    await page.goto(origin + `/spaces/${space}`);
    await page.getByRole("link", { name: "部署令牌", exact: true }).click();
    await page
      .locator('#deploy-token-create input[name="name"]')
      .fill("Workspace browser");
    await page.getByRole("button", { name: "创建令牌", exact: true }).click();
    await page.locator("#deploy-secret-value").waitFor();
    secrets.push(await page.locator("#deploy-secret-value").inputValue());
    await page.getByRole("button", { name: "已保存，清除显示" }).click();
    checks++;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: ".data/v26-workspace-deploy-mobile.png",
      fullPage: true,
    });
    check(!errors.length, "Deployment pages have no runtime errors");
    await browser.close();
    browser = undefined;
  }
  const target = await token("/api/workspaces/" + second, "Destination", [
    "read_repository",
    "read_package_registry",
  ]);
  await api(ap + "/transfer", "POST", {
    namespace: second,
    name: "moved",
    revision: renamed.lifecycle_revision,
  });
  const before = ap;
  ap = `/api/repos/${second}/moved`;
  gitURL = `${origin}/${second}/moved.git`;
  await request(ap + "/packages", "GET", undefined, 401, rotated.token);
  checks++;
  await request(ap + "/packages", "GET", undefined, 403, groupToken.token);
  checks++;
  const hidden = await fetch(origin + before + "/packages", {
    redirect: "manual",
    headers: { Authorization: "Bearer " + groupToken.token },
  });
  check(
    hidden.status === 403 && !hidden.headers.has("location"),
    "Old workspace deploy token cannot discover private transfer destination",
  );
  await hidden.arrayBuffer();
  await git(["ls-remote", gitURL], root, target);
  checks++;
  await request(ap + generic, "GET", undefined, 200, target.token);
  checks++;
  const groupAPI =
    "/api/workspaces/" + space + "/deploy-tokens/" + groupToken.id;
  await api(groupAPI, "DELETE", { revision: groupToken.revision });
  await request(
    `/api/repos/${space}/sibling/packages`,
    "GET",
    undefined,
    401,
    groupToken.token,
  );
  checks++;
  console.log(
    JSON.stringify({
      checks,
      requests,
      spaces: createdSpaces,
      repositories: repos.map((r) => r.id),
      nativeGit:
        "clone/fsck, push denial, LFS, rotation/revocation, archive, rename and cross-space isolation",
      npm: "deploy-token publish/install/dist-tag/unpublish",
      ui: !!process.env.PLAYWRIGHT_MODULE && !remote,
    }),
  );
} catch (error) {
  console.error(redact(error.message));
  throw Error(redact(error.message));
} finally {
  await browser?.close();
  for (const repo of repos)
    await api("/api/admin/repositories/" + repo.id, "DELETE");
  for (const slug of createdSpaces) {
    let gone = false;
    for (let n = 0; n < 180; n++) {
      const response = await fetch(origin + "/api/workspaces/" + slug, {
        method: "DELETE",
        headers: { Origin: origin, Authorization: "Bearer " + ownerToken },
        signal: AbortSignal.timeout(30000),
      });
      await response.arrayBuffer();
      if (response.status === 200) {
        gone = true;
        break;
      }
      assert.equal(response.status, 409);
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert.ok(gone, "Deployment fixture space collected");
  }
  if (minted) {
    await api("/api/tokens/" + minted.id, "DELETE");
    ownerToken = "";
    await api("/api/logout", "POST", {});
  }
  await rm(root, { recursive: true, force: true });
  console.log(
    JSON.stringify({
      cleanup:
        "projects/spaces/deploy tokens removed; npm/Git/browser credentials and directories removed",
      spaces: createdSpaces,
    }),
  );
}
