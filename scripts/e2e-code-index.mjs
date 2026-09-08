import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile),
  { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const origin = process.env.TEST_ORIGIN || "http://localhost:8787",
  remote = !["localhost", "127.0.0.1"].includes(new URL(origin).hostname);
if (remote && process.env.ALLOW_REMOTE_ACCEPTANCE !== "1")
  throw Error("Remote acceptance requires opt-in");
const shared = process.env.ONESTORAGE_SHARED_CODE === "1";
const prefix =
    ".data/" +
    (shared ? "v34-" : "v32-") +
    (remote ? "production" : "local") +
    "-index",
  suffix = randomBytes(4).toString("hex"),
  keyword = "needle_v32_" + suffix;
const token = process.env.ONESTORAGE_TOKEN_FILE
  ? (await fs.readFile(process.env.ONESTORAGE_TOKEN_FILE, "utf8")).trim()
  : "";
let admin = token ? { Authorization: "Bearer " + token } : {},
  owner = {},
  reader = {},
  user,
  guest,
  repo,
  checks = 0;
const browser = await chromium.launch({ headless: true }),
  ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } }),
  page = await ctx.newPage(),
  errors = [];
page.on("pageerror", () => errors.push("pageerror"));
page.setDefaultTimeout(30000);
async function req(path, method = "GET", body, auth = owner, status = 200) {
  const r = await fetch(origin + "/api" + path, {
    method,
    headers: {
      Origin: origin,
      ...auth,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const data = r.headers.get("content-type")?.includes("json")
    ? await r.json()
    : await r.text();
  assert.equal(
    r.status,
    status,
    method + " " + path + ": " + r.status + " " + (data.error || ""),
  );
  checks++;
  return {
    data,
    auth: { Cookie: r.headers.get("set-cookie")?.split(";")[0] || "" },
  };
}
const api = async (...a) => (await req(...a)).data,
  delay = (ms) => new Promise((r) => setTimeout(r, ms));
let rp,
  base,
  gitEnv,
  work = prefix + "-work-" + suffix;
async function git(...args) {
  return exec("git", ["-c", "credential.helper=", ...args], {
    env: gitEnv,
    timeout: 180000,
    maxBuffer: 1024 * 1024,
  });
}
async function indexedRows() {
  const sql = `SELECT d.path,d.content_id,c.grams FROM code_documents d JOIN code_contents c ON c.id=d.content_id JOIN code_index_state s ON s.repo_id=d.repo_id AND s.generation=d.generation WHERE d.repo_id='${repo.id}' ORDER BY d.path`;
  const { stdout } = await exec(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      "DB",
      ...(remote
        ? ["--remote"]
        : ["--local", "--config", "wrangler.local.jsonc"]),
      "--command",
      sql,
      "--json",
    ],
    { maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(stdout)[0].results;
}
async function waitIndex(sha, after = 0) {
  for (let i = 0; i < 120; i++) {
    const s = await api(rp + "/code-index");
    if (
      s.indexed_sha === sha &&
      !s.stale &&
      s.indexed_at > after &&
      ["ready", "partial"].includes(s.status)
    )
      return s;
    if (i % 15 === 0)
      console.log(
        JSON.stringify({
          stage: "indexing",
          status: s.status,
          files: s.indexed_files,
          stale: s.stale,
        }),
      );
    await delay(2000);
  }
  throw Error("Code index did not complete");
}
const query = (auth = owner, extra = "") =>
  api("/search?type=code&q=" + keyword + extra, "GET", undefined, auth);
try {
  if (!token)
    admin = (
      await req(
        "/login",
        "POST",
        { username: "owner", password: "local-test-password-123" },
        {},
      )
    ).auth;
  const username = "index_v32_" + suffix,
    password = randomBytes(20).toString("hex"),
    guestname = "index_reader_" + suffix,
    guestpass = randomBytes(20).toString("hex");
  user = await api("/users", "POST", { username, password }, admin, 201);
  owner = (await req("/login", "POST", { username, password }, {})).auth;
  guest = await api(
    "/users",
    "POST",
    { username: guestname, password: guestpass },
    admin,
    201,
  );
  reader = (
    await req(
      "/login",
      "POST",
      { username: guestname, password: guestpass },
      {},
    )
  ).auth;
  repo = await api(
    "/repos",
    "POST",
    { name: "index-proof", visibility: "private" },
    owner,
    201,
  );
  rp = "/repos/" + username + "/index-proof";
  base = "/" + username + "/index-proof";
  await fs.writeFile(
    prefix + "-fixture.json",
    JSON.stringify({ user: user.id, guest: guest.id, repo: repo.id, username }),
    { mode: 0o600 },
  );
  await api(rp + "/members", "PUT", { username: guestname, role: "reader" });
  const files = Array.from({ length: 18 }, (_, i) => ({
    path: "src/file" + i + ".ts",
    content: "// index fixture\nconst " + keyword + " = " + i + ";",
  }));
  files.push(
    {
      path: "src/alpha.ts",
      content:
        "// first line\nexport const " + keyword + ' = "中文搜索";\n// end',
    },
    { path: "large.txt", content: keyword + "x".repeat(256 * 1024) },
    { path: "binary.dat", content: "a\0" + keyword },
  );
  const first = await api(
    rp + "/commit-files",
    "POST",
    { target_branch: "main", commit_message: "Index fixture", files },
    owner,
    201,
  );
  const initial = await waitIndex(first.sha);
  assert.equal(initial.status, "partial");
  assert.equal(initial.coverage.indexed_files, 19);
  assert.equal(initial.coverage.skipped.large_file, 1);
  assert.equal(initial.coverage.skipped.binary, 1);
  const originalRows = shared ? await indexedRows() : [];
  if (shared) {
    assert.equal(initial.coverage.index_version, 2);
    assert.equal(initial.coverage.created_contents, 19);
    assert.equal(initial.coverage.reused_files, 0);
  }
  let found = await query();
  assert.equal(found.results.length, 19);
  assert.ok(found.results.every((r) => r.indexed_sha === first.sha));
  assert.equal((await query({})).results.length, 0);
  assert.equal((await query(reader)).results.length, 19);
  assert.equal(
    (await query(owner, "&path=alpha&extension=ts")).results.length,
    1,
  );
  await api(rp + "/code-index/rebuild", "POST", {}, reader, 403);
  const cookie = owner.Cookie.split("=");
  await ctx.addCookies([
    { name: cookie[0], value: cookie.slice(1).join("="), url: origin },
  ]);
  await page.goto(origin + "/search?type=code&q=" + keyword + "&path=alpha");
  await page.locator(".search-result").waitFor();
  assert.equal(await page.locator(".search-result").count(), 1);
  await page.screenshot({ path: prefix + "-desktop.png", fullPage: true });
  await page.getByRole("link", { name: "src/alpha.ts", exact: true }).click();
  await page.locator("#highlight-target").waitFor();
  assert.ok(page.url().includes(first.sha));
  assert.ok(page.url().endsWith("#L2"));
  await page.locator("#L2").waitFor({ state: "visible" });
  await page.goto(origin + base + "/search");
  await page.locator("[data-rebuild-index]").waitFor();
  const rebuild = page.waitForResponse(
    (r) =>
      r.url().endsWith("/code-index/rebuild") &&
      r.request().method() === "POST",
  );
  await page.locator("[data-rebuild-index]").click();
  assert.equal((await rebuild).status(), 202);
  const rebuilt = await waitIndex(first.sha, initial.indexed_at),
    rebuiltRows = shared ? await indexedRows() : [];
  if (shared) {
    assert.equal(rebuilt.coverage.created_contents, 19);
    assert.equal(rebuilt.coverage.reused_files, 0);
    assert.ok(
      rebuiltRows.every(
        (r) => !originalRows.some((o) => o.content_id === r.content_id),
      ),
    );
  }
  const pat = (
    await api(
      "/tokens",
      "POST",
      { name: "code index Git acceptance", scope: "write", days: 1 },
      owner,
      201,
    )
  ).token;
  await fs.writeFile(prefix + "-token", pat, { mode: 0o600 });
  await fs.writeFile(
    prefix + "-askpass.cjs",
    '#!/usr/bin/env node\nprocess.stdout.write(process.argv[2].includes("Username")?"index-acceptance":require("node:fs").readFileSync(process.env.INDEX_TOKEN_FILE,"utf8").trim());\n',
    { mode: 0o700 },
  );
  gitEnv = {
    ...process.env,
    GIT_ASKPASS: process.cwd() + "/" + prefix + "-askpass.cjs",
    GIT_TERMINAL_PROMPT: "0",
    INDEX_TOKEN_FILE: process.cwd() + "/" + prefix + "-token",
    GIT_AUTHOR_NAME: "Index acceptance",
    GIT_AUTHOR_EMAIL: "index@example.invalid",
    GIT_COMMITTER_NAME: "Index acceptance",
    GIT_COMMITTER_EMAIL: "index@example.invalid",
  };
  delete gitEnv.GIT_TRACE;
  delete gitEnv.GIT_TRACE_CURL;
  delete gitEnv.GIT_CURL_VERBOSE;
  await git("clone", origin + base + ".git", work);
  await git("-C", work, "mv", "src/alpha.ts", "src/renamed.ts");
  await git("-C", work, "rm", "src/file0.ts");
  await fs.writeFile(
    work + "/src/new.py",
    "# added\n" + keyword + ' = "native push"\n',
  );
  await git("-C", work, "add", "src/new.py");
  if (shared) {
    await fs.copyFile(work + "/src/file1.ts", work + "/src/copy.ts");
    await git("-C", work, "add", "src/copy.ts");
  }
  await git("-C", work, "commit", "-m", "Reindex native rename and deletion");
  await git("-C", work, "push", "origin", "HEAD:main");
  const sha = (await git("-C", work, "rev-parse", "HEAD")).stdout.trim();
  const updated = await waitIndex(sha);
  const updatedRows = shared ? await indexedRows() : [];
  if (shared) {
    assert.equal(updated.coverage.indexed_files, 20);
    assert.equal(updated.coverage.reused_files, 19);
    assert.equal(updated.coverage.created_contents, 1);
    const old = new Map(rebuiltRows.map((r) => [r.path, r.content_id])),
      ids = new Set(rebuiltRows.map((r) => r.content_id));
    assert.equal(
      updatedRows.find((r) => r.path === "src/renamed.ts").content_id,
      old.get("src/alpha.ts"),
    );
    assert.equal(
      updatedRows.find((r) => r.path === "src/copy.ts").content_id,
      old.get("src/file1.ts"),
    );
    const fresh = updatedRows.filter((r) => !ids.has(r.content_id));
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0].path, "src/new.py");
    assert.equal(updated.coverage.written_postings, fresh[0].grams);
    assert.ok(
      updated.coverage.written_postings < updated.coverage.postings / 4,
    );
    await page.goto(origin + base + "/search");
    await page
      .getByText("本次复用 19 个文件的内容索引", { exact: false })
      .waitFor();
    await page.screenshot({ path: prefix + "-reuse.png", fullPage: true });
  }
  found = await query();
  assert.equal(found.results.length, shared ? 20 : 19);
  assert.ok(found.results.every((r) => r.indexed_sha === sha));
  assert.equal(
    found.results.some((r) =>
      ["src/alpha.ts", "src/file0.ts"].includes(r.path),
    ),
    false,
  );
  assert.equal(
    found.results.some((r) => r.path === "src/new.py"),
    true,
  );
  await git("-C", work, "fsck", "--strict");
  await api(rp + "/members/" + guestname, "DELETE");
  assert.equal((await query(reader)).results.length, 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin + "/search?type=code&q=" + keyword + "&extension=py");
  await page.locator(".search-result").waitFor();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.screenshot({ path: prefix + "-mobile.png", fullPage: true });
  assert.deepEqual(errors, []);
  await git("-C", work, "push", "origin", first.sha + ":refs/heads/stable");
  await api(rp, "PATCH", { default_branch: "stable" });
  const switched = await waitIndex(first.sha, updated.indexed_at);
  found = await query();
  assert.equal(found.results.length, 19);
  assert.ok(
    found.results.every(
      (r) => r.indexed_branch === "stable" && r.indexed_sha === first.sha,
    ),
  );
  assert.ok(found.results.some((r) => r.path === "src/alpha.ts"));
  assert.ok(!found.results.some((r) => r.path === "src/new.py"));
  const result = {
    shared,
    rebuilt,
    ...(shared ? { originalRows, rebuiltRows, updatedRows } : {}),
    switched,
    origin,
    checks,
    repo: repo.id,
    firstSHA: first.sha,
    finalSHA: sha,
    initial,
    updated,
    nativeGit: "push/rename/delete index update and fsck passed",
    browserErrors: errors.length,
  };
  await fs.writeFile(prefix + ".json", JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ stage: "passed", checks, origin }));
} catch (error) {
  console.error(JSON.stringify({ stage: "failed", message: error.message }));
  throw error;
} finally {
  console.log(JSON.stringify({ stage: "cleanup" }));
  await browser.close();
  for (const path of [prefix + "-token", prefix + "-askpass.cjs"])
    await fs.rm(path, { force: true });
  try {
    if (repo)
      await api("/admin/repositories/" + repo.id, "DELETE", undefined, admin);
  } finally {
    for (const u of [user, guest].filter(Boolean))
      await api(
        "/admin/users/" + u.id,
        "PATCH",
        { disabled: true, revoke_sessions: true },
        admin,
      );
  }
  if (user) {
    let contentIDs = [];
    if (shared && repo) {
      const { stdout } = await exec(
        "npx",
        [
          "wrangler",
          "d1",
          "execute",
          "DB",
          ...(remote
            ? ["--remote"]
            : ["--local", "--config", "wrangler.local.jsonc"]),
          "--command",
          `SELECT id FROM code_contents WHERE repo_id='${repo.id}'`,
          "--json",
        ],
        { maxBuffer: 1024 * 1024 },
      );
      contentIDs = JSON.parse(stdout)[0].results.map((r) => "'" + r.id + "'");
    }
    const ids = [user, guest]
      .filter(Boolean)
      .map((u) => "'" + u.id.replaceAll("'", "''") + "'")
      .join(",");
    const repoId = repo ? "'" + repo.id + "'" : "''";
    const sql = `SELECT (SELECT count(*) FROM repositories WHERE owner_id IN(${ids})) repositories,(SELECT count(*) FROM credentials WHERE user_id IN(${ids})) credentials,(SELECT count(*) FROM users WHERE id IN(${ids}) AND disabled=0) enabled_users,(SELECT count(*) FROM code_documents WHERE repo_id=${repoId}) documents,(SELECT count(*) FROM code_index_state WHERE repo_id=${repoId}) index_states${shared ? `,(SELECT count(*) FROM code_contents WHERE repo_id=${repoId}) contents,(SELECT count(*) FROM code_content_grams WHERE content_id IN(${contentIDs.join(",") || "''"})) content_grams` : ""}`;
    let counts;
    for (let i = 0; i < 60; i++) {
      const { stdout } = await exec(
        "npx",
        [
          "wrangler",
          "d1",
          "execute",
          "DB",
          ...(remote
            ? ["--remote"]
            : ["--local", "--config", "wrangler.local.jsonc"]),
          "--command",
          sql,
          "--json",
        ],
        { maxBuffer: 1024 * 1024 },
      );
      counts = JSON.parse(stdout)[0].results[0];
      if (Object.values(counts).every((n) => n === 0)) break;
      await delay(3000);
    }
    for (const [k, n] of Object.entries(counts))
      assert.equal(n, 0, k + " cleanup");
    await fs.writeFile(
      prefix + "-cleanup.json",
      JSON.stringify(counts, null, 2) + "\n",
    );
  }
  console.log(JSON.stringify({ stage: "cleanup complete" }));
}
