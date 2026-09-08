import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { generateKeyPair, exportSPKI, SignJWT } from "jose";
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
const suffix = randomBytes(4).toString("hex"),
  spaces = [],
  users = [],
  repos = [];
const directory = await mkdtemp(join(tmpdir(), "onestorage-transfer-"));
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
  for (const role of ["mover", "former", "newcomer"]) {
    const username = role + "_" + suffix,
      password = randomBytes(18).toString("hex");
    const u = await api("/users", "POST", { username, password }, admin, 201);
    users.push({
      ...u,
      username,
      auth: (await request("/login", "POST", { username, password }, {})).auth,
    });
  }
  const [mover, former, newcomer] = users,
    actor = mover.auth;
  const act = (path, method = "GET", body, status = 200, auth = actor) =>
    api(path, method, body, auth, status);
  for (const kind of ["source", "target"]) {
    const slug = kind + "_v11_" + suffix;
    await api(
      "/workspaces",
      "POST",
      { slug, name: kind + " transfer acceptance" },
      admin,
      201,
    );
    spaces.push(slug);
    await api("/workspaces/" + slug + "/members", "PUT", {
      username: mover.username,
      role: "owner",
    });
  }
  const [source, target] = spaces;
  await api("/workspaces/" + source + "/members", "PUT", {
    username: former.username,
    role: "reader",
  });
  await api("/workspaces/" + target + "/members", "PUT", {
    username: newcomer.username,
    role: "reader",
  });
  const minted = await act(
    "/tokens",
    "POST",
    { name: "Native Git transfer", days: 1, scope: "write" },
    201,
  );
  await writeFile(join(directory, "credential"), minted.token, { mode: 0o600 });
  await writeFile(
    join(directory, "askpass"),
    '#!/bin/sh\ncase "$1" in *Username*) echo git;; *) cat "' +
      join(directory, "credential") +
      '";; esac\n',
    { mode: 0o700 },
  );
  const repo = await act(
    "/repos",
    "POST",
    { name: "project", visibility: "private" },
    201,
  );
  repos.push(repo);
  const old = "/repos/" + mover.username + "/project";
  let ap = old;
  await act(
    ap + "/commit-files",
    "POST",
    {
      target_branch: "main",
      commit_message: "Transfer fixture",
      files: [
        { path: "README.md", content: "Preserved across namespaces\n" },
        {
          path: "ci.js",
          content:
            'export default async()=>({logs:["transfer publication"],artifacts:{"index.html":"<h1>transfer-app</h1>"}})',
        },
      ],
    },
    201,
  );
  const issue = await act(
    ap + "/issues",
    "POST",
    { title: "Preserved issue" },
    201,
  );
  await act(ap + "/wiki/home", "PUT", {
    title: "Home",
    body: "Preserved wiki",
    expected_version: 0,
  });
  await act(ap + "/members", "PUT", {
    username: newcomer.username,
    role: "developer",
  });
  const runner = await act(
    ap + "/ci/runners",
    "POST",
    { name: "Old namespace runner" },
    201,
  );
  await act(ap + "/ci/config", "PUT", {
    config: {
      runner: "external",
      steps: [{ type: "run", name: "Build", command: "echo build" }],
    },
    enabled: false,
  });
  const run = await act(ap + "/ci/runs", "POST", {}, 201);
  await act(ap + "/ci/config", "PUT", {
    enabled: false,
    config: {
      runner: "worker",
      steps: [{ type: "javascript", entry: "ci.js", files: ["ci.js"] }],
      deploy: {
        kind: "static",
        environment: "preview",
        entry: "index.html",
        files: ["index.html"],
      },
    },
  });
  const cloud = await act(ap + "/ci/runs", "POST", {}, 201);
  let done = false;
  for (let n = 0; n < 80; n++) {
    const status = await act(ap + "/ci/runs/" + cloud.id);
    if (!["queued", "running"].includes(status.status)) {
      assert.equal(status.status, "succeeded");
      done = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.ok(done, "cloud pipeline finished");
  const deployments = await act(ap + "/deployments"),
    deployment = deployments.deployments.find((d) => d.run_id === cloud.id);
  await act(ap + "/environments/preview", "PUT", {
    deployment_id: deployment.id,
    expected_deployment_id: null,
    public: true,
  });
  const appURL = deployments.environments.find((e) => e.name === "preview").url;
  if (remote) {
    const response = await fetch(appURL);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /transfer-app/);
    checks++;
  }
  const runnerAuth = { Authorization: "Bearer " + runner.token };
  const claimed = await api("/runner/claim", "POST", {}, runnerAuth);
  assert.equal(claimed.run.id, run.id);
  const key = await generateKeyPair("ES256");
  const registered = await act(
    "/api-keys",
    "POST",
    {
      name: "Transfer JWT",
      algorithm: "ES256",
      public_key: await exportSPKI(key.publicKey),
    },
    201,
  );
  const jwt = await new SignJWT({
    repo: mover.username + "/project",
    scopes: ["git:read", "git:write"],
  })
    .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: registered.id })
    .setIssuer(mover.username)
    .setSubject("transfer-test")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(key.privateKey);
  await api(ap, "GET", undefined, { Authorization: "Bearer " + jwt });
  const gitURL = origin + "/" + mover.username + "/project.git";
  await git(["clone", gitURL, "checkout"]);
  const lfs = Buffer.from("Transfer LFS bytes"),
    oid = createHash("sha256").update(lfs).digest("hex");
  const raw = async (
    path,
    {
      method = "GET",
      body,
      auth = actor,
      status = 200,
      redirect = "manual",
      headers = {},
    } = {},
  ) => {
    const r = await fetch(origin + path, {
      method,
      headers: { Origin: origin, ...auth, ...headers },
      body,
      redirect,
      signal: AbortSignal.timeout(60000),
    });
    assert.equal(r.status, status, method + " " + path);
    checks++;
    return r;
  };
  await raw("/" + mover.username + "/project.git/info/lfs/objects/" + oid, {
    method: "PUT",
    body: lfs,
  });
  const readToken = await act(
    "/tokens",
    "POST",
    { name: "Read-only transfer", scope: "read", days: 1 },
    201,
  );
  await act(ap + "/transfer", "POST", { namespace: source, revision: 0 }, 403, {
    Authorization: "Bearer " + readToken.token,
  });
  await act("/tokens/" + readToken.id, "DELETE");
  await act(
    ap + "/transfer",
    "POST",
    { namespace: newcomer.username, revision: 0 },
    403,
  );
  const moved = await act(ap + "/transfer", "POST", {
    namespace: source,
    name: "renamed",
    revision: 0,
  });
  assert.equal(moved.id, repo.id);
  assert.equal(moved.lifecycle_revision, 1);
  ap = "/repos/" + source + "/renamed";
  assert.equal((await act(ap + "/ci/runs/" + run.id)).status, "canceled");
  assert.equal((await act(ap + "/ci/config")).enabled, 0);
  assert.equal((await act(ap + "/deployments")).environments[0].public, 0);
  if (remote) {
    assert.equal((await fetch(appURL)).status, 404);
    checks++;
  }
  assert.equal((await act(ap + "/ci/runners")).runners.length, 0);
  await api("/runner/claim", "POST", {}, runnerAuth, 401);
  const redirect = await raw(
    "/api" + old + "/issues/" + issue.id + "?comments_after=0",
    { status: 307 },
  );
  assert.equal(
    new URL(redirect.headers.get("location")).pathname,
    "/api" + ap + "/issues/" + issue.id,
  );
  assert.equal(
    new URL(redirect.headers.get("location")).search,
    "?comments_after=0",
  );
  await raw("/api" + old, {
    auth: { Authorization: "Bearer " + jwt },
    status: 403,
  });
  const hidden = await raw("/api" + old, { auth: {}, status: 404 });
  assert.equal(hidden.headers.get("location"), null);
  await act(old + "/issues", "POST", { title: "Stale path" }, 409);
  await act("/repos", "POST", { name: "project", visibility: "private" }, 409);
  await act(ap, "GET", undefined, 200, former.auth);
  assert.equal(
    (await act(ap + "/issues/" + issue.id)).title,
    "Preserved issue",
  );
  assert.equal((await act(ap + "/wiki/home")).body, "Preserved wiki");
  const conflicting = await act(
    "/repos",
    "POST",
    { namespace: target, name: "taken", visibility: "private" },
    201,
  );
  repos.push(conflicting);
  await act(
    ap + "/transfer",
    "POST",
    { namespace: target, name: "taken", revision: 1 },
    409,
  );
  assert.equal((await act(ap)).namespace, source);
  await act(ap + "/lifecycle", "PUT", { archived: true, revision: 1 });
  const twice = await act(ap + "/transfer", "POST", {
    namespace: target,
    name: "final",
    revision: 2,
  });
  assert.ok(twice.archived_at);
  assert.equal(twice.id, repo.id);
  const sourcePath = ap;
  ap = "/repos/" + target + "/final";
  const removed = await raw("/api" + sourcePath, {
    auth: former.auth,
    status: 404,
  });
  assert.equal(removed.headers.get("location"), null);
  await act(ap, "GET", undefined, 404, former.auth);
  await act(ap, "GET", undefined, 200, newcomer.auth);
  const lfsResponse = await raw(
    "/" + target + "/final.git/info/lfs/objects/" + oid,
  );
  assert.equal(
    Buffer.from(await lfsResponse.arrayBuffer()).toString(),
    lfs.toString(),
  );
  const stable = await act("/repo-url/" + repo.id);
  assert.equal(stable.namespace, target);
  assert.equal(stable.name, "final");
  await git(["-C", "checkout", "fetch", "origin"]);
  await act(ap + "/lifecycle", "PUT", { archived: false, revision: 3 });
  await git(["-C", "checkout", "config", "user.name", "Transfer test"]);
  await git([
    "-C",
    "checkout",
    "config",
    "user.email",
    "test@onestorage.invalid",
  ]);
  await writeFile(
    join(directory, "checkout", "README.md"),
    "New namespace writes\n",
  );
  await git(["-C", "checkout", "add", "README.md"]);
  await git(["-C", "checkout", "commit", "-m", "Write after transfer"]);
  await git(["-C", "checkout", "push", "origin", "main"]);
  await git(["clone", origin + "/" + target + "/final.git", "verified"]);
  await git(["-C", "verified", "fsck", "--full", "--strict"]);
  assert.equal(
    (await git(["-C", "checkout", "rev-parse", "HEAD"])).trim(),
    (await git(["-C", "verified", "rev-parse", "HEAD"])).trim(),
  );
  await act(
    ap + "/issues/" + issue.id + "/comments",
    "POST",
    { body: "New target member" },
    201,
    newcomer.auth,
  );
  // Reclaiming one of our own historical addresses works without redirect loops.
  const back = await act(ap + "/transfer", "POST", {
    namespace: mover.username,
    name: "project",
    revision: 4,
  });
  assert.equal(back.id, repo.id);
  const oldTarget = await raw("/api" + ap, { status: 307 });
  assert.equal(
    new URL(oldTarget.headers.get("location")).pathname,
    "/api" + old,
  );
  const retainedRunner = await act(
    old + "/ci/runners",
    "POST",
    { name: "Preserved on rename" },
    201,
  );
  await act(old + "/transfer", "POST", {
    namespace: mover.username,
    name: "renamed-only",
    revision: 5,
  });
  assert.equal(
    (await act("/repos/" + mover.username + "/renamed-only/ci/runners"))
      .runners[0].id,
    retainedRunner.id,
  );
  await git(["-C", "checkout", "fetch", "origin"]);
  console.log(
    JSON.stringify({
      checks,
      spaces,
      transfer: "passed",
      permissions: "passed",
      aliases: "passed",
      nativeGit: "clone/fetch/push/fsck passed",
      lfs: "preserved",
    }),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
  for (const repo of repos.reverse())
    await api("/admin/repositories/" + repo.id, "DELETE");
  for (const u of users)
    await api("/admin/users/" + u.id, "PATCH", {
      disabled: true,
      revoke_sessions: true,
    });
  for (const space of spaces) {
    let removed = false;
    for (let i = 0; i < 100; i++) {
      const r = await fetch(origin + "/api/workspaces/" + space, {
        method: "DELETE",
        headers: { Origin: origin, ...admin },
      });
      if (r.status === 200) {
        removed = true;
        break;
      }
      assert.equal(r.status, 409, "workspace cleanup");
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!removed) throw Error("Workspace cleanup pending: " + space);
  }
  console.log(
    JSON.stringify({
      cleanup:
        "repositories/workspaces removed; test users disabled and credentials revoked",
      spaces,
    }),
  );
}
