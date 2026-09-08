import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
const origin = process.env.TEST_ORIGIN || "http://localhost:8787",
  remote = !["localhost", "127.0.0.1"].includes(new URL(origin).hostname);
if (remote && process.env.ALLOW_REMOTE_ACCEPTANCE !== "1")
  throw Error("Remote acceptance requires opt-in");
let token = process.env.ONESTORAGE_TOKEN_FILE
    ? (await readFile(process.env.ONESTORAGE_TOKEN_FILE, "utf8")).trim()
    : "",
  cookie = "",
  minted,
  spaceCreated = false,
  repo,
  requests = 0,
  checks = 0,
  browser;
const space = "pkg_v25_" + crypto.randomUUID().slice(0, 8),
  ap = `/api/repos/${space}/project`,
  root = await mkdtemp(join(tmpdir(), "onestorage-packages-")),
  registry = origin + ap + "/packages/npm/";
const check = (condition, message) => {
  assert.ok(condition, message);
  checks++;
};
async function request(
  path,
  method = "GET",
  body,
  expected = 200,
  headers = {},
  anonymous = false,
) {
  const response = await fetch(origin + path, {
    method,
    headers: {
      Origin: origin,
      ...(anonymous
        ? {}
        : token
          ? { Authorization: "Bearer " + token }
          : { Cookie: cookie }),
      ...(body !== undefined && !(body instanceof Uint8Array)
        ? { "content-type": "application/json" }
        : {}),
      ...headers,
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
  if (response.status !== expected) {
    const text = (await response.text()).replaceAll(
      token || "unused",
      "[REDACTED]",
    );
    throw Error(
      `${method} ${path}: expected ${expected}, got ${response.status}: ${text.slice(0, 700)}`,
    );
  }
  return response;
}
async function api(...args) {
  const r = await request(...args);
  return r.json();
}
async function npm(args, cwd, expected = 0) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "npm",
      [
        ...args,
        "--registry=" + registry,
        "--userconfig=" + join(root, ".npmrc"),
        "--cache=" + join(root, "cache"),
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--fetch-retries=0",
      ],
      {
        cwd,
        env: {
          ...process.env,
          ONESTORAGE_PACKAGE_TOKEN: token,
          npm_config_loglevel: "error",
          npm_config_update_notifier: "false",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 120000);
    child.stdout.on("data", (b) => (output += b));
    child.stderr.on("data", (b) => (output += b));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      output = output.replaceAll(token, "[REDACTED]");
      if (expected === 0 ? code !== 0 : code === 0)
        reject(Error(`npm ${args[0]} exited ${code}: ${output.slice(-2500)}`));
      else resolve(output);
    });
  });
}
try {
  if (!token) {
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
    token = minted.token;
  }
  await api(
    "/api/workspaces",
    "POST",
    { slug: space, name: "Package acceptance" },
    201,
  );
  spaceCreated = true;
  repo = await api(
    "/api/repos",
    "POST",
    { namespace: space, name: "project", visibility: "private" },
    201,
  );
  await writeFile(
    ".data/v25-last-package-fixture.json",
    JSON.stringify({ space, repoId: repo.id, ap }),
    { mode: 0o600 },
  );
  await writeFile(
    join(root, ".npmrc"),
    `${registry.replace(/^https?:/, "")}:_authToken=\${ONESTORAGE_PACKAGE_TOKEN}\n`,
    { mode: 0o600 },
  );
  const tarballs = [];
  for (const name of ["demo-" + space, "@" + space + "/demo"]) {
    const dir = join(root, name.replaceAll("/", "-"));
    await mkdir(dir);
    const manifest = {
      name,
      version: "1.0.0",
      main: "index.cjs",
      description: "OneStorage npm acceptance",
      files: ["index.cjs", "binary.bin"],
    };
    await writeFile(
      join(dir, "index.cjs"),
      "module.exports = 'verified-package';\n",
    );
    await writeFile(
      join(dir, "binary.bin"),
      randomBytes(
        process.env.PACKAGE_LARGE === "1" && name.startsWith("@")
          ? 15 * 1024 * 1024
          : 16384,
      ),
    );
    await writeFile(join(dir, "package.json"), JSON.stringify(manifest));
    await npm(
      [
        "publish",
        name.startsWith("@") ? "--access=restricted" : "--access=public",
      ],
      dir,
    );
    checks++;
    const first = await api(ap + "/packages/npm/" + encodeURIComponent(name));
    check(
      first["dist-tags"].latest === "1.0.0",
      "npm publication creates latest tag",
    );
    const tarball = first.versions["1.0.0"].dist.tarball;
    tarballs.push(tarball);
    check(
      tarball.startsWith(registry),
      "Registry generates its own tarball URL",
    );
    const tgz = new Uint8Array(
      await (await request(new URL(tarball).pathname)).arrayBuffer(),
    );
    check(
      "sha512-" + createHash("sha512").update(tgz).digest("base64") ===
        first.versions["1.0.0"].dist.integrity,
      "npm tarball SRI matches uploaded bytes",
    );
    await request(new URL(tarball).pathname, "GET", undefined, 401, {}, true);
    checks++;
    await npm(
      [
        "publish",
        name.startsWith("@") ? "--access=restricted" : "--access=public",
      ],
      dir,
      1,
    );
    checks++;
    manifest.version = "1.1.0";
    await writeFile(join(dir, "package.json"), JSON.stringify(manifest));
    await npm(
      [
        "publish",
        name.startsWith("@") ? "--access=restricted" : "--access=public",
        "--tag=next",
      ],
      dir,
    );
    checks++;
    await npm(["dist-tag", "add", name + "@1.1.0", "stable"], dir);
    check(
      (
        await api(
          ap +
            "/packages/npm/-/package/" +
            encodeURIComponent(name) +
            "/dist-tags",
        )
      ).stable === "1.1.0",
      "Native npm dist-tag add",
    );
    await npm(["dist-tag", "rm", name, "next"], dir);
    check(
      !(
        await api(
          ap +
            "/packages/npm/-/package/" +
            encodeURIComponent(name) +
            "/dist-tags",
        )
      ).next,
      "Native npm dist-tag rm",
    );
    const install = join(dir, "consumer");
    await mkdir(install);
    await writeFile(
      join(install, "package.json"),
      '{"name":"consumer","version":"1.0.0","private":true}',
    );
    await npm(["install", name + "@stable"], install);
    check(
      JSON.parse(
        await readFile(
          join(install, "node_modules", name, "package.json"),
          "utf8",
        ),
      ).version === "1.1.0",
      "Native npm install resolves private scoped/unscoped version",
    );
    check(
      (
        await readFile(join(install, "node_modules", name, "index.cjs"), "utf8")
      ).includes("verified-package"),
      "Installed package content matches source",
    );
    await npm(["unpublish", name + "@1.1.0", "--force"], dir);
    const left = await api(ap + "/packages/npm/" + encodeURIComponent(name));
    check(
      Object.keys(left.versions).join() === "1.0.0" &&
        !left["dist-tags"].stable,
      "Native npm unpublish version retires metadata and tags",
    );
    await npm(
      [
        "publish",
        name.startsWith("@") ? "--access=restricted" : "--access=public",
      ],
      dir,
      1,
    );
    checks++;
    await request(
      ap + "/packages/npm/" + encodeURIComponent(name) + "/-rev/" + first._rev,
      "DELETE",
      undefined,
      409,
    );
    checks++;
    await npm(["unpublish", name, "--force"], dir);
    await request(
      ap + "/packages/npm/" + encodeURIComponent(name),
      "GET",
      undefined,
      404,
    );
    checks++;
    await request(new URL(tarball).pathname, "GET", undefined, 404);
    checks++;
  }
  console.log(
    JSON.stringify({
      phase: "native npm",
      checks,
      requests,
      clients:
        "unscoped/scoped publish, install, SRI, dist-tags, unpublish, stale revision, immutable tombstones",
    }),
  );
  const data = randomBytes(2 * 1024 * 1024),
    sha = createHash("sha256").update(data).digest("hex"),
    path = ap + "/packages/generic/tool/1.0.0/tool.bin",
    extra = {
      "content-type": "application/octet-stream",
      "x-package-sha256": sha,
    };
  const published = await api(path, "PUT", data, 201, extra);
  checks++;
  const download = await request(path),
    loaded = new Uint8Array(await download.arrayBuffer());
  check(
    createHash("sha256").update(loaded).digest("hex") === sha,
    "Generic binary R2 round trip",
  );
  const head = await request(path, "HEAD");
  check(
    Number(head.headers.get("content-length")) === data.length &&
      head.headers.get("x-package-sha256") === sha,
    "HEAD has length and digest",
  );
  const partial = await request(path, "GET", undefined, 206, {
    Range: "bytes=13-1024",
  });
  check(
    Buffer.from(await partial.arrayBuffer()).equals(data.subarray(13, 1025)),
    "Generic Range bytes match",
  );
  const suffix = await request(path, "GET", undefined, 206, {
    Range: "bytes=-19",
  });
  check(
    Buffer.from(await suffix.arrayBuffer()).equals(data.subarray(-19)),
    "Suffix range bytes match",
  );
  await request(path, "GET", undefined, 416, { Range: "bytes=999999999-" });
  checks++;
  await request(path, "GET", undefined, 304, {
    "If-None-Match": head.headers.get("etag"),
  });
  checks++;
  await request(path, "PUT", data, 409, extra);
  checks++;
  await request(path + "2", "PUT", data, 400, {
    ...extra,
    "x-package-sha256": "0".repeat(64),
  });
  checks++;
  await request(path, "GET", undefined, 401, {}, true);
  checks++;
  await request(path, "GET", undefined, 401, {
    Authorization: "Bearer os_invalid",
  });
  checks++;
  const results = await Promise.all(
    [0, 1].map(async () => {
      const response = await fetch(origin + path + "3", {
        method: "PUT",
        headers: { Authorization: "Bearer " + token, ...extra },
        body: data,
      });
      await response.arrayBuffer();
      return response.status;
    }),
  );
  check(
    results.sort().join() === "201,409",
    "Concurrent generic publishers cannot overwrite",
  );
  if (process.env.PACKAGE_LARGE === "1") {
    const large = randomBytes(64 * 1024 * 1024),
      checksum = createHash("sha256").update(large).digest("hex"),
      largePath = ap + "/packages/generic/large/1/data.bin";
    await api(largePath, "PUT", large, 201, {
      ...extra,
      "x-package-sha256": checksum,
    });
    checks++;
    const response = await request(largePath),
      hash = createHash("sha256");
    for await (const chunk of response.body) hash.update(chunk);
    check(
      hash.digest("hex") === checksum,
      "64 MiB generic streaming upload and download",
    );
  }
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
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin + `/${space}/project/packages`);
    await page
      .getByRole("link", { name: "tool · 1.0.0", exact: true })
      .waitFor();
    checks++;
    await page.locator('#package-upload input[name="name"]').fill("browser");
    await page.locator('#package-upload input[name="version"]').fill("1.0.0");
    await page.locator('#package-upload input[type="file"]').setInputFiles({
      name: "browser.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("browser-upload"),
    });
    await page.getByRole("button", { name: "校验并发布" }).click();
    await page
      .getByRole("link", { name: "browser.txt", exact: true })
      .waitFor();
    checks++;
    await page.screenshot({ path: ".data/v25-package-ui.png", fullPage: true });
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "撤回此版本" }).click();
    await page.getByRole("button", { name: "校验并发布" }).waitFor();
    checks++;
    check(!errors.length, "Package browser pages have no runtime errors");
    await browser.close();
    browser = undefined;
  }
  await api(ap, "PATCH", { visibility: "public" });
  const publicResponse = await request(path, "GET", undefined, 200, {}, true);
  await publicResponse.body.cancel();
  checks++;
  await request(path, "GET", undefined, 401, {
    Authorization: "Bearer os_invalid",
  });
  checks++;
  await api(ap + "/packages/versions/" + published.version_id, "DELETE");
  await request(path, "GET", undefined, 404);
  checks++;
  await request(path, "PUT", data, 409, extra);
  checks++;
  const movePath = ap + "/packages/generic/move/1/move.bin";
  await api(movePath, "PUT", data, 201, extra);
  const moved = await api(ap + "/transfer", "POST", {
    namespace: space,
    name: "renamed",
    revision: repo.lifecycle_revision || 0,
  });
  check(moved.id === repo.id, "Package project rename preserves UUID");
  const alias = await fetch(origin + movePath, {
    redirect: "manual",
    headers: { Authorization: "Bearer " + token },
  });
  check(
    alias.status === 307 &&
      new URL(alias.headers.get("location")).pathname.includes("/renamed/"),
    "Old package URL redirects authorized reads",
  );
  await alias.arrayBuffer();
  await request(movePath, "PUT", data, 409, extra);
  checks++;
  const movedAPI = `/api/repos/${space}/renamed`,
    movedPath = movePath.replace(ap, movedAPI);
  const movedBytes = await request(movedPath);
  check(
    createHash("sha256")
      .update(new Uint8Array(await movedBytes.arrayBuffer()))
      .digest("hex") === sha,
    "Renamed project keeps package bytes",
  );
  await api(movedAPI + "/lifecycle", "PUT", {
    archived: true,
    revision: moved.lifecycle_revision,
  });
  await request(movedPath + "2", "PUT", data, 409, extra);
  checks++;
  const archivedRead = await request(movedPath);
  await archivedRead.body.cancel();
  checks++;
  console.log(
    JSON.stringify({
      checks,
      requests,
      workspace: space,
      generic:
        "R2, hashes, HEAD, Range, duplicate/concurrent publication, private/public access, visibility changes, immutable deletion",
      npm: "native publish/install/dist-tag/unpublish scoped and unscoped",
    }),
  );
} finally {
  await browser?.close();
  if (repo) await api("/api/admin/repositories/" + repo.id, "DELETE");
  if (spaceCreated) {
    let removed = false;
    for (let n = 0; n < 180; n++) {
      const response = await fetch(origin + "/api/workspaces/" + space, {
        method: "DELETE",
        headers: { Origin: origin, Authorization: "Bearer " + token },
        signal: AbortSignal.timeout(30000),
      });
      await response.arrayBuffer();
      if (response.status === 200) {
        removed = true;
        break;
      }
      assert.equal(response.status, 409);
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert.ok(removed, "Package fixtures collected");
  }
  if (minted) {
    await api("/api/tokens/" + minted.id, "DELETE");
    token = "";
    await api("/api/logout", "POST", {});
  }
  await rm(root, { recursive: true, force: true });
  console.log(
    JSON.stringify({
      cleanup:
        "repositories/workspace removed, temporary credentials and npm directories removed",
      workspace: space,
    }),
  );
}
