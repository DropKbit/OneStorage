import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
const origin = process.env.TEST_ORIGIN || "http://localhost:8787",
  remote = !["localhost", "127.0.0.1"].includes(new URL(origin).hostname);
if (remote && process.env.ALLOW_REMOTE_ACCEPTANCE !== "1")
  throw Error("Remote acceptance requires opt-in");
const token = process.env.ONESTORAGE_TOKEN_FILE
  ? (await readFile(process.env.ONESTORAGE_TOKEN_FILE, "utf8")).trim()
  : "";
let admin = token ? { Authorization: "Bearer " + token } : {},
  checks = 0;
async function request(path, method = "GET", body, auth = admin, status = 200) {
  const r = await fetch(origin + "/api" + path, {
    method,
    headers: {
      Origin: origin,
      ...auth,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const raw = await r.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw Error(
      method + " " + path + " HTTP " + r.status + ": " + raw.slice(0, 160),
    );
  }
  assert.equal(
    r.status,
    status,
    method + " " + path + " " + (data.error || ""),
  );
  checks++;
  return {
    data,
    auth: { Cookie: r.headers.get("set-cookie")?.split(";")[0] || "" },
  };
}
const api = async (...args) => (await request(...args)).data;
if (!token)
  admin = (
    await request(
      "/login",
      "POST",
      { username: "owner", password: "local-test-password-123" },
      {},
    )
  ).auth;
const owner = (await api("/me")).user,
  suffix = randomBytes(4).toString("hex"),
  workspace = "archive_v10_" + suffix,
  users = [],
  repos = [];
let created = false;
const directory = await mkdtemp(join(tmpdir(), "onestorage-archive-"));
let temporaryToken;
async function git(args, expected = 0) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn("git", ["-c", "credential.helper=", ...args], {
      cwd: directory,
      env: {
        ...process.env,
        GIT_ASKPASS: join(directory, "askpass"),
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    let output = "";
    child.stdout.on("data", (b) => (output += b));
    child.stderr.on("data", (b) => (output += b));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
  if (expected === 0) assert.equal(result.code, 0, result.output);
  else assert.notEqual(result.code, 0, "Git push must fail while archived");
  checks++;
  return result.output;
}
try {
  if (!token)
    temporaryToken = await api(
      "/tokens",
      "POST",
      { name: "archive-acceptance", scope: "write", days: 1 },
      admin,
      201,
    );
  await writeFile(
    join(directory, "credential"),
    token || temporaryToken.token,
    { mode: 0o600 },
  );
  await writeFile(
    join(directory, "askpass"),
    '#!/bin/sh\ncase "$1" in *Username*) echo git;; *) cat "' +
      join(directory, "credential") +
      '";; esac\n',
    { mode: 0o700 },
  );
  await api(
    "/workspaces",
    "POST",
    { slug: workspace, name: "Archive acceptance" },
    admin,
    201,
  );
  created = true;
  const repo = await api(
    "/repos",
    "POST",
    { namespace: workspace, name: "project", visibility: "private" },
    admin,
    201,
  );
  repos.push(repo);
  const ap = "/repos/" + workspace + "/project",
    gitURL = origin + "/" + workspace + "/project.git";
  const commit = await api(
    ap + "/commit-files",
    "POST",
    {
      target_branch: "main",
      commit_message: "Archive fixture",
      files: [{ path: "README.md", content: "Archive fixture\n" }],
    },
    admin,
    201,
  );
  const issue = await api(
    ap + "/issues",
    "POST",
    { title: "Preserved issue", body: "Original" },
    admin,
    201,
  );
  await api(ap + "/wiki/home", "PUT", {
    title: "Home",
    body: "Preserved wiki",
    expected_version: 0,
  });
  const pipeline = {
    runner: "external",
    steps: [{ type: "run", name: "Build", command: "echo build" }],
  };
  await api(ap + "/ci/config", "PUT", { config: pipeline, enabled: false });
  const run = await api(ap + "/ci/runs", "POST", {}, admin, 201);
  const runner = await api(
    ap + "/ci/runners",
    "POST",
    { name: "Archive runner" },
    admin,
    201,
  );
  const runnerAuth = { Authorization: "Bearer " + runner.token };
  const claimed = await api("/runner/claim", "POST", {}, runnerAuth);
  assert.equal(claimed.run.id, run.id);
  const leaseAuth = { ...runnerAuth, "x-run-lease": claimed.lease };
  const lfs = Buffer.from("preserved LFS object"),
    oid = createHash("sha256").update(lfs).digest("hex");
  async function raw(path, method = "GET", body, status = 200, headers = {}) {
    const response = await fetch(origin + path, {
      method,
      headers: { Origin: origin, ...admin, ...headers },
      body,
    });
    assert.equal(response.status, status, path);
    checks++;
    return response;
  }
  await raw(
    "/" + workspace + "/project.git/info/lfs/objects/" + oid,
    "PUT",
    lfs,
  );
  await git(["clone", gitURL, "checkout"]);
  await git(["-C", "checkout", "config", "user.name", "Archive test"]);
  await git([
    "-C",
    "checkout",
    "config",
    "user.email",
    "test@onestorage.invalid",
  ]);
  await writeFile(
    join(directory, "checkout", "README.md"),
    "Native Git change after restore\n",
  );
  await git(["-C", "checkout", "add", "README.md"]);
  await git(["-C", "checkout", "commit", "-m", "Verify restore"]);
  const username = "archivist_" + suffix,
    password = randomBytes(18).toString("hex");
  const member = await api(
    "/users",
    "POST",
    { username, password },
    admin,
    201,
  );
  users.push(member);
  const memberAuth = (
    await request("/login", "POST", { username, password }, {})
  ).auth;
  await api("/workspaces/" + workspace + "/members", "PUT", {
    username,
    role: "maintainer",
  });
  await api(
    ap + "/lifecycle",
    "PUT",
    { archived: true, revision: 0 },
    memberAuth,
    403,
  );
  await api("/workspaces/" + workspace + "/members", "PUT", {
    username,
    role: "owner",
  });
  const readToken = await api(
    "/tokens",
    "POST",
    { name: "readonly archive test", scope: "read", days: 1 },
    memberAuth,
    201,
  );
  await api(
    ap + "/lifecycle",
    "PUT",
    { archived: true, revision: 0 },
    { Authorization: "Bearer " + readToken.token },
    403,
  );
  await api("/tokens/" + readToken.id, "DELETE", undefined, memberAuth);
  const before = await api(ap);
  const state = await api(ap + "/lifecycle", "PUT", {
    archived: true,
    revision: before.lifecycle_revision,
  });
  assert.ok(state.archived_at);
  await api(
    ap + "/lifecycle",
    "PUT",
    { archived: false, revision: before.lifecycle_revision },
    admin,
    409,
  );
  await api(
    ap + "/lifecycle",
    "PUT",
    { archived: false, revision: state.lifecycle_revision },
    {},
    401,
  );
  const frozen = await api(ap);
  assert.equal(frozen.id, repo.id);
  assert.ok(frozen.archived_at);
  assert.equal(
    (await api(ap + "/issues/" + issue.id)).title,
    "Preserved issue",
  );
  assert.equal((await api(ap + "/wiki/home")).body, "Preserved wiki");
  assert.equal((await api(ap + "/ci/runs/" + run.id)).status, "canceled");
  await api("/runner/claim", "POST", {}, runnerAuth, 401);
  await api(
    "/runner/runs/" + run.id + "/complete",
    "POST",
    { status: "succeeded" },
    leaseAuth,
    401,
  );
  await api(ap + "/ci/runs", "POST", {}, admin, 409);
  await api(ap + "/issues", "POST", { title: "Late" }, admin, 409);
  await api(
    ap + "/issues/" + issue.id + "/comments",
    "POST",
    { body: "Late" },
    admin,
    409,
  );
  await api(
    ap + "/issues/" + issue.id,
    "PATCH",
    { state: "closed" },
    admin,
    409,
  );
  await api(
    ap + "/wiki/home",
    "PUT",
    { title: "Late", body: "Late", expected_version: 1 },
    admin,
    409,
  );
  await api(ap + "/labels", "POST", { name: "Late" }, admin, 409);
  await api(ap, "PATCH", { visibility: "public" }, admin, 409);
  await api(ap + "/pull-upstream", "POST", {}, admin, 409);
  await api(
    ap + "/commit-files",
    "POST",
    {
      target_branch: "main",
      commit_message: "Late",
      files: [{ path: "late.txt", content: "No" }],
    },
    admin,
    409,
  );
  await api(
    ap + "/commit-files",
    "POST",
    {
      target_branch: "main",
      ephemeral: true,
      commit_message: "Late",
      files: [{ path: "late.txt", content: "No" }],
    },
    admin,
    409,
  );
  await raw(
    "/" + workspace + "/project.git/info/lfs/objects/" + oid,
    "PUT",
    lfs,
    409,
  );
  const downloaded = await raw(
    "/" + workspace + "/project.git/info/lfs/objects/" + oid,
  );
  assert.equal(
    Buffer.from(await downloaded.arrayBuffer()).toString(),
    lfs.toString(),
  );
  await raw(
    "/api" + ap + "/archive",
    "POST",
    JSON.stringify({ ref: "main", format: "tar" }),
    200,
    { "content-type": "application/json" },
  );
  await git(["clone", gitURL, "archived-clone"]);
  await git(["-C", "archived-clone", "fsck", "--full", "--strict"]);
  await git(["-C", "checkout", "push", "origin", "main"], 1);
  await api(ap + "/lifecycle", "PUT", {
    archived: false,
    revision: state.lifecycle_revision,
  });
  await api(
    "/runner/runs/" + run.id + "/complete",
    "POST",
    { status: "succeeded" },
    leaseAuth,
    409,
  );
  await git(["-C", "checkout", "push", "origin", "main"]);
  await git(["-C", "archived-clone", "fetch", "origin"]);
  await git(["-C", "archived-clone", "fsck", "--full", "--strict"]);
  assert.equal(
    (await git(["-C", "checkout", "rev-parse", "HEAD"])).trim(),
    (await git(["-C", "archived-clone", "rev-parse", "origin/main"])).trim(),
  );
  await api(
    ap + "/issues/" + issue.id + "/comments",
    "POST",
    { body: "Restored" },
    admin,
    201,
  );
  assert.equal((await api(ap + "/ci/runs/" + run.id)).status, "canceled");
  // Cleanup must also work for a project which remains archived.
  const restored = await api(ap);
  await api(ap + "/lifecycle", "PUT", {
    archived: true,
    revision: restored.lifecycle_revision,
  });
  console.log(
    JSON.stringify({
      checks,
      workspace,
      archive: "passed",
      nativeGit: "clone, rejected push, restored push, fetch and fsck passed",
      lfs: "passed",
      runnerRevocation: "passed",
    }),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
  if (temporaryToken) await api("/tokens/" + temporaryToken.id, "DELETE");
  for (const r of repos.reverse())
    await api("/admin/repositories/" + r.id, "DELETE");
  for (const u of users)
    await api("/admin/users/" + u.id, "PATCH", {
      disabled: true,
      revoke_sessions: true,
    });
  if (created) {
    let removed = false;
    for (let i = 0; i < 100; i++) {
      const response = await fetch(origin + "/api/workspaces/" + workspace, {
        method: "DELETE",
        headers: { Origin: origin, ...admin },
      });
      if (response.status === 200) {
        removed = true;
        break;
      }
      if (response.status !== 409)
        throw Error("Workspace cleanup failed: " + response.status);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!removed) throw Error("Workspace GC pending: " + workspace);
    console.log(
      JSON.stringify({
        cleanup:
          "repositories/workspace removed, users disabled and credentials revoked",
        workspace,
      }),
    );
  }
}
