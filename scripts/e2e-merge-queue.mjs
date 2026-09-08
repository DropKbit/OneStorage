import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
const origin = process.env.TEST_ORIGIN || "http://localhost:8787";
const remote = !["localhost", "127.0.0.1"].includes(new URL(origin).hostname);
if (remote && process.env.ALLOW_REMOTE_ACCEPTANCE !== "1")
  throw Error("Remote acceptance requires opt-in");
const prefix = ".data/v31-" + (remote ? "production" : "local") + "-queue";
const token = process.env.ONESTORAGE_TOKEN_FILE
  ? (await fs.readFile(process.env.ONESTORAGE_TOKEN_FILE, "utf8")).trim()
  : "";
let admin = token ? { Authorization: "Bearer " + token } : {},
  checks = 0;
const suffix = randomBytes(4).toString("hex"),
  username = "queue_v31_" + suffix,
  password = randomBytes(20).toString("hex");
let user,
  reviewer,
  repo,
  owner = {},
  reviewerAuth = {},
  cloneToken;
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  }),
  page = await ctx.newPage();
const errors = [];
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
    method + " " + path + " HTTP " + r.status + " " + (data.error || ""),
  );
  checks++;
  return {
    data,
    auth: { Cookie: r.headers.get("set-cookie")?.split(";")[0] || "" },
  };
}
const api = async (...a) => (await req(...a)).data;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let rp, base;
async function queueEntry(id) {
  const q = await api(rp + "/merge-queue");
  return [...q.entries, ...q.history].find((x) => x.id === id);
}
async function waitQueue(id, predicate, label) {
  for (let i = 0; i < 120; i++) {
    const e = await queueEntry(id);
    if (e && predicate(e)) return e;
    if (i % 12 === 0)
      console.log(
        JSON.stringify({
          stage: label,
          state: e?.state,
          hasCandidate: !!e?.candidate_sha,
          hasRun: !!e?.run_id,
        }),
      );
    await delay(2500);
  }
  throw Error("Queue timed out: " + label);
}
const commit = async (branch, files) =>
  api(
    rp + "/commit-files",
    "POST",
    {
      target_branch: branch,
      commit_message: "Merge queue acceptance",
      files: Object.entries(files).map(([path, content]) => ({
        path,
        content,
      })),
    },
    owner,
    201,
  );
async function approve(m) {
  return api(
    rp + "/merges/" + m.id + "/reviews",
    "POST",
    {
      verdict: "approve",
      body: "Reviewed exact queue baseline",
      source_sha: m.source_sha,
      target_sha: m.target_sha,
    },
    reviewerAuth,
    201,
  );
}
async function submit(selector, path) {
  const pending = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api" + path &&
      r.request().method() === "POST",
  );
  await page.locator(selector).getByRole("button", { name: /./ }).click();
  const r = await pending;
  assert.equal(r.status(), 201);
  checks++;
  return r.json();
}
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
  user = await api("/users", "POST", { username, password }, admin, 201);
  owner = (await req("/login", "POST", { username, password }, {})).auth;
  const reviewPassword = randomBytes(20).toString("hex");
  reviewer = await api(
    "/users",
    "POST",
    { username: "queue_review_" + suffix, password: reviewPassword },
    admin,
    201,
  );
  reviewerAuth = (
    await req(
      "/login",
      "POST",
      { username: "queue_review_" + suffix, password: reviewPassword },
      {},
    )
  ).auth;
  repo = await api(
    "/repos",
    "POST",
    { name: "queue-proof", visibility: "private" },
    owner,
    201,
  );
  await fs.writeFile(
    prefix + "-fixture.json",
    JSON.stringify({
      user: user.id,
      reviewer: reviewer.id,
      repo: repo.id,
      username,
    }),
    { mode: 0o600 },
  );
  rp = "/repos/" + username + "/queue-proof";
  base = "/" + username + "/queue-proof";
  await api(rp + "/members", "PUT", {
    username: "queue_review_" + suffix,
    role: "developer",
  });
  const config = {
    runner: "worker",
    steps: [{ type: "file", path: "base.txt" }],
  };
  const initial = await commit("main", {
    "base.txt": "base",
    "pipeline.json": JSON.stringify(config),
  });
  await api(rp + "/ci/config", "PUT", {
    source_path: "pipeline.json",
    enabled: false,
  });
  for (const branch of ["one", "two", "bad"])
    await api(
      rp + "/branches/create",
      "POST",
      { target_branch: branch, base_branch: "main" },
      owner,
      201,
    );
  const one = await commit("one", { "one.txt": "one" }),
    two = await commit("two", { "two.txt": "two" });
  // The source attempts to replace configuration. Queue must use the target's valid configuration.
  await commit("bad", {
    "pipeline.json": "{invalid source config",
    "bad.txt": "unmerged",
  });
  await api(rp + "/protections", "PUT", {
    branch: "main",
    require_queue: true,
    approvals: 1,
    require_mr: true,
    require_ci: true,
  });
  const issue = await api(
    rp + "/issues",
    "POST",
    { title: "Closed by queued merge" },
    owner,
    201,
  );
  const m1 = await api(
    rp + "/merges",
    "POST",
    {
      source: "one",
      target: "main",
      title: "First queued merge",
      body: "Closes #" + issue.id,
    },
    owner,
    201,
  );
  const m2 = await api(
    rp + "/merges",
    "POST",
    { source: "two", target: "main", title: "Second queued merge" },
    owner,
    201,
  );
  let d1 = await api(rp + "/merges/" + m1.id),
    d2 = await api(rp + "/merges/" + m2.id);
  await approve(d1);
  await approve(d2);
  await api(
    rp + "/merges/" + m1.id + "/merge",
    "POST",
    { revision: d1.revision },
    owner,
    403,
  );
  await api(
    rp + "/merges/" + m1.id + "/queue",
    "POST",
    { revision: d1.revision },
    reviewerAuth,
    403,
  );
  await api(rp + "/merge-queue", "GET", undefined, {}, 401);
  const cookie = owner.Cookie.split("=");
  await ctx.addCookies([
    { name: cookie[0], value: cookie.slice(1).join("="), url: origin },
  ]);
  await page.goto(origin + base + "/merges/" + m1.id);
  await page.locator("#enqueue-merge").waitFor();
  assert.equal(
    await page.locator("#merge-reviewed button[type=submit]").isDisabled(),
    true,
  );
  await page.locator("#enqueue-merge [name=strategy]").selectOption("merge");
  const q1 = await submit("#enqueue-merge", rp + "/merges/" + m1.id + "/queue");
  assert.equal(Object.hasOwn(q1, "actor_epoch"), false);
  const q2 = await api(
    rp + "/merges/" + m2.id + "/queue",
    "POST",
    { revision: d2.revision, strategy: "merge" },
    owner,
    201,
  );
  await page.goto(origin + base + "/merges");
  await page.locator('[data-queue-entry="' + q2.id + '"]').waitFor();
  await page.screenshot({ path: prefix + "-desktop.png", fullPage: true });
  const done = await waitQueue(
    q1.id,
    (e) => e.state === "merged",
    "first candidate",
  );
  const run = await api(rp + "/ci/runs/" + done.run_id);
  assert.equal(run.sha, done.candidate_sha);
  assert.equal(run.status, "succeeded");
  assert.equal(run.config_sha, initial.sha);
  assert.equal(run.source_trigger, "merge_request");
  assert.notEqual(done.merged_sha, one.sha);
  assert.equal(done.merged_sha, done.candidate_sha);
  assert.equal((await api(rp + "/issues/" + issue.id)).state, "closed");
  const blocked = await waitQueue(
    q2.id,
    (e) => e.state === "blocked" && e.generation === 1,
    "fresh target review",
  );
  assert.equal(blocked.candidate_sha, null);
  assert.equal(blocked.target_sha, done.merged_sha);
  d2 = await api(rp + "/merges/" + m2.id);
  assert.equal(d2.gate.approvals, 0);
  await approve(d2);
  const second = await waitQueue(
    q2.id,
    (e) => e.state === "merged",
    "second candidate",
  );
  assert.equal(second.merged_sha, second.candidate_sha);
  assert.notEqual(second.merged_sha, two.sha);
  await api(rp + "/file?ref=main&path=one.txt");
  await api(rp + "/file?ref=main&path=two.txt");
  const bad = await api(
    rp + "/merges",
    "POST",
    { source: "bad", target: "main", title: "Target configuration proof" },
    owner,
    201,
  );
  const dbad = await api(rp + "/merges/" + bad.id);
  await approve(dbad);
  // Block this candidate intentionally, prove FIFO UI cancel and unchanged main.
  await api(rp + "/ci/config", "PUT", {
    config: {
      runner: "worker",
      steps: [{ type: "file", path: "missing-required-file.txt" }],
    },
    enabled: false,
  });
  const qb = await api(
    rp + "/merges/" + bad.id + "/queue",
    "POST",
    { revision: dbad.revision },
    owner,
    201,
  );
  const failed = await waitQueue(
    qb.id,
    (e) => e.state === "blocked" && !!e.run_id,
    "failed candidate",
  );
  assert.match(failed.reason, /pipeline failed/);
  assert.equal((await api(rp + "/branch?branch=main")).sha, second.merged_sha);
  await page.goto(origin + base + "/merges/" + bad.id);
  await page.locator('[data-queue-cancel="' + qb.id + '"]').waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.screenshot({ path: prefix + "-mobile.png", fullPage: true });
  const canceled = page.waitForResponse(
    (r) =>
      r.request().method() === "DELETE" &&
      r.url().endsWith("/merge-queue/" + qb.id),
  );
  await page.locator('[data-queue-cancel="' + qb.id + '"]').click();
  assert.equal((await canceled).status(), 200);
  assert.equal((await queueEntry(qb.id)).state, "canceled");
  assert.deepEqual(errors, []);
  cloneToken = (
    await api(
      "/tokens",
      "POST",
      { name: "queue acceptance", scope: "read", days: 1 },
      owner,
      201,
    )
  ).token;
  const privateToken = prefix + "-token",
    askpass = prefix + "-askpass.cjs";
  await fs.writeFile(privateToken, cloneToken, { mode: 0o600 });
  await fs.writeFile(
    askpass,
    '#!/usr/bin/env node\nprocess.stdout.write(process.argv[2].includes("Username")?"queue":require("node:fs").readFileSync(process.env.QUEUE_TOKEN_FILE,"utf8").trim());\n',
    { mode: 0o700 },
  );
  const env = {
    ...process.env,
    GIT_ASKPASS: process.cwd() + "/" + askpass,
    GIT_TERMINAL_PROMPT: "0",
    QUEUE_TOKEN_FILE: process.cwd() + "/" + privateToken,
  };
  delete env.GIT_CURL_VERBOSE;
  delete env.GIT_TRACE_CURL;
  delete env.GIT_TRACE;
  try {
    await exec(
      "git",
      [
        "-c",
        "credential.helper=",
        "clone",
        "--bare",
        origin + "/" + username + "/queue-proof.git",
        prefix + "-clone.git",
      ],
      { env, timeout: 180000 },
    );
    const { stdout } = await exec(
      "git",
      ["--git-dir=" + prefix + "-clone.git", "rev-parse", "refs/heads/main"],
      { env },
    );
    assert.equal(stdout.trim(), second.merged_sha);
    await exec(
      "git",
      ["--git-dir=" + prefix + "-clone.git", "fsck", "--strict"],
      { env, timeout: 60000 },
    );
  } finally {
    await fs.rm(privateToken, { force: true });
    await fs.rm(askpass, { force: true });
  }
  const result = {
    checks,
    origin,
    repo: repo.id,
    first: done,
    second,
    failedCandidate: failed.candidate_sha,
    nativeClone: "main matches exact tested candidate; strict fsck passed",
    browserErrors: errors.length,
  };
  await fs.writeFile(prefix + ".json", JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ checks, stage: "passed", origin }));
} catch (error) {
  console.error(JSON.stringify({ stage: "failed", message: error.message }));
  throw error;
} finally {
  console.log(JSON.stringify({ stage: "cleanup" }));
  await browser.close();
  try {
    if (repo)
      await api("/admin/repositories/" + repo.id, "DELETE", undefined, admin);
  } finally {
    for (const u of [user, reviewer].filter(Boolean))
      await api(
        "/admin/users/" + u.id,
        "PATCH",
        { disabled: true, revoke_sessions: true },
        admin,
      );
  }
  if (user) {
    const ids = [user, reviewer]
      .filter(Boolean)
      .map((u) => "'" + u.id.replaceAll("'", "''") + "'")
      .join(",");
    const sql = `SELECT (SELECT count(*) FROM repositories WHERE owner_id IN(${ids})) repositories,(SELECT count(*) FROM credentials WHERE user_id IN(${ids})) credentials,(SELECT count(*) FROM users WHERE id IN(${ids}) AND disabled=0) enabled_users`;
    let counts;
    for (let i = 0; i < 40; i++) {
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
      if (Object.values(counts).every((v) => v === 0)) break;
      await delay(3000);
    }
    for (const [name, n] of Object.entries(counts))
      assert.equal(n, 0, name + " cleanup");
    await fs.writeFile(
      prefix + "-cleanup.json",
      JSON.stringify(counts, null, 2) + "\n",
    );
  }
  console.log(JSON.stringify({ stage: "cleanup complete" }));
}
