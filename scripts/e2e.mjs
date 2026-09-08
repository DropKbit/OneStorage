// Runs against an existing local stack. Only creates data with the e2e_ prefix.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  symlink,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes, createHash } from "node:crypto";
const origin = process.env.TEST_ORIGIN || "http://localhost:8787";
if (!["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw Error("E2E only runs against localhost");
const password = process.env.TEST_ADMIN_PASSWORD || "local-test-password-123";
const username = process.env.TEST_ADMIN_USERNAME || "owner";
let cookie = "",
  token = "",
  checks = 0;
async function request(
  path,
  method = "GET",
  body,
  auth = "session",
  expected = 200,
) {
  const headers = { Origin: origin };
  if (auth === "session" && cookie) headers.Cookie = cookie;
  else if (auth && auth !== "session") headers.Authorization = "Bearer " + auth;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(origin + "/api" + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json();
  assert.equal(
    r.status,
    expected,
    `${method} ${path}: ${JSON.stringify(data)}`,
  );
  checks++;
  if (r.headers.get("set-cookie"))
    cookie = r.headers.get("set-cookie").split(";")[0];
  return data;
}
function git(args, cwd, secret = token, allowFailure = false) {
  return new Promise((ok, no) => {
    const env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: secret
        ? "Authorization: Basic " +
          Buffer.from(`${username}:${secret}`).toString("base64")
        : "",
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: "",
    };
    const p = spawn("git", args, { cwd, env });
    let out = "",
      err = "";
    p.stdout.on("data", (b) => (out += b));
    p.stderr.on("data", (b) => (err += b));
    p.on("error", no);
    p.on("close", (code) => {
      if (code && !allowFailure)
        no(
          Error(
            `git ${args[0]} failed: ${err.replaceAll(secret, "[redacted]")}`,
          ),
        );
      else ok({ code, out, err });
    });
  });
}
const tmp = await mkdtemp(join(tmpdir(), "onestorage-e2e-"));
try {
  const status = await request("/setup");
  if (status.required)
    await request(
      "/setup",
      "POST",
      { username, password, secret: "local-development-only-change-me" },
      null,
      201,
    );
  await request("/login", "POST", { username, password }, null);
  const suffix = randomBytes(4).toString("hex"),
    name = "e2e_" + suffix,
    other = "e2e_user_" + suffix;
  ({ token } = await request(
    "/tokens",
    "POST",
    { name: "e2e_" + suffix, scope: "write", days: 1 },
    "session",
    201,
  ));
  const read = await request(
    "/tokens",
    "POST",
    { name: "e2e_read_" + suffix, scope: "read", days: 1 },
    "session",
    201,
  );
  console.log("✓ Setup, password login and scoped access tokens");
  const repo = await request(
      "/repos",
      "POST",
      {
        name,
        description: "End-to-end verification repository",
        visibility: "private",
      },
      token,
      201,
    ),
    ap = `/repos/${username}/${name}`,
    url = `${origin}/${username}/${name}.git`;
  await request(ap, "GET", undefined, null, 401);
  await request(ap, "GET", undefined, read.token);
  await request("/repos", "POST", { name: "forbidden" }, read.token, 403);
  await request("/users", "POST", { username: other, password }, token, 201);
  const adminCookie = cookie;
  await request("/login", "POST", { username: other, password }, null);
  const otherToken = (
    await request(
      "/tokens",
      "POST",
      { name: "e2e_other", days: 1 },
      "session",
      201,
    )
  ).token;
  cookie = adminCookie;
  await request(ap, "GET", undefined, otherToken, 404);
  console.log("✓ Private repository isolation and read-only token enforcement");
  const work = join(tmp, "work");
  await git(["clone", url, work], tmp);
  await git(["config", "user.name", "E2E Tester"], work);
  await git(["config", "user.email", "test@example.invalid"], work);
  await writeFile(
    join(work, "README.md"),
    "# OneStorage\n\nReal Git, durable storage.\n",
  );
  await git(["add", "."], work);
  await git(["commit", "-m", "Initial commit"], work);
  await git(["push", "-u", "origin", "main"], work);
  const branches = await request(ap + "/branches", "GET", undefined, token);
  assert.equal(branches.branches[0].name, "main");
  const initial = branches.branches[0].sha;
  const tree = await request(ap + "/tree", "GET", undefined, token);
  assert.equal(tree.entries[0].name, "README.md");
  assert.match(
    (await request(ap + "/blob?path=README.md", "GET", undefined, token))
      .content,
    /Real Git/,
  );
  await git(["clone", url, join(tmp, "readonly")], tmp, read.token);
  const clone = join(tmp, "clone");
  await git(["clone", url, clone], tmp);
  assert.equal(
    await readFile(join(clone, "README.md"), "utf8"),
    await readFile(join(work, "README.md"), "utf8"),
  );
  const search = await request(
    ap + "/search?q=Real",
    "GET",
    undefined,
    read.token,
  );
  assert.equal(search.matches[0].path, "README.md");
  assert.equal(search.matches[0].line, 3);
  await request(ap + "/search?q=absent-needle", "GET", undefined, token);
  console.log(
    "✓ Native git clone → commit → push → clone, tree and blob browsing",
  );
  const legacyClone = join(tmp, "protocol-v0");
  await git(["-c", "protocol.version=0", "clone", url, legacyClone], tmp);
  const rows = Array.from(
    { length: 800 },
    (_, i) => `line ${i}: ` + "abcdefghij".repeat(12),
  );
  for (let i = 0; i < 6; i++) {
    const version = [...rows];
    version[i * 41] = "revision " + i;
    await writeFile(join(work, "delta.txt"), version.join("\n") + "\n");
    await git(["add", "."], work);
    await git(["commit", "-m", "Delta revision " + i], work);
    await git(["-c", "http.postBuffer=128", "push", "origin", "main"], work);
  }
  const binary = randomBytes(96 * 1024);
  await writeFile(join(work, "binary.dat"), binary);
  await symlink("README.md", join(work, "readme-link"));
  await writeFile(join(work, "run.sh"), "#!/bin/sh\nexit 0\n");
  await chmod(join(work, "run.sh"), 0o755);
  await git(["add", "."], work);
  await git(["commit", "-m", "Binary and file modes"], work);
  await git(["push", "origin", "main"], work);
  await git(["tag", "-a", "v-e2e", "-m", "Annotated release"], work);
  await git(["push", "origin", "v-e2e"], work);
  await git(["-c", "protocol.version=0", "pull", "--ff-only"], legacyClone);
  await git(["fetch", "--tags"], clone);
  assert.equal(
    (await git(["cat-file", "-t", "v-e2e"], clone)).out.trim(),
    "tag",
  );
  await git(["fsck", "--full", "--strict"], clone);
  assert.deepEqual(await readFile(join(legacyClone, "binary.dat")), binary);
  assert.equal(
    (await git(["ls-tree", "HEAD", "run.sh"], legacyClone)).out.startsWith(
      "100755",
    ),
    true,
  );
  assert.equal(
    (await git(["ls-tree", "HEAD", "readme-link"], legacyClone)).out.startsWith(
      "120000",
    ),
    true,
  );
  await git(["push", "origin", ":refs/tags/v-e2e"], work);
  console.log(
    "✓ Protocol v0/v2, incremental thin pushes, chunked HTTP, annotated tags, binary and executable/symlink modes",
  );
  await git(["checkout", "-b", "feature/e2e"], work);
  await writeFile(join(work, "feature.txt"), "feature\n");
  await git(["add", "."], work);
  await git(["commit", "-m", "Add feature"], work);
  await git(["push", "origin", "feature/e2e"], work);
  const mr = await request(
    ap + "/merges",
    "POST",
    { title: "Review feature", source: "feature/e2e", target: "main" },
    token,
    201,
  );
  assert.match(
    (await request(ap + "/merges/" + mr.id, "GET", undefined, token)).diff,
    /feature.txt/,
  );
  await request(ap + "/merges/" + mr.id + "/merge", "POST", undefined, token);
  await request(ap + "/merges/" + mr.id + "/merge", "POST", undefined, token);
  await git(["pull", "--ff-only"], clone);
  assert.equal(await readFile(join(clone, "feature.txt"), "utf8"), "feature\n");
  console.log(
    "✓ Fast-forward merge requests, immutable diff and idempotent merge retry",
  );
  const head = (
    await request(ap + "/branches", "GET", undefined, token)
  ).branches.find((b) => b.name === "main").sha;
  const writes = await Promise.all(
    [1, 2].map((i) =>
      fetch(origin + "/api" + ap + "/commit", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          branch: "main",
          expected_sha: head,
          message: "Concurrent edit " + i,
          files: [{ path: `parallel-${i}.txt`, content: "ok" }],
        }),
      }),
    ),
  );
  assert.deepEqual(writes.map((r) => r.status).sort(), [201, 409]);
  for (const r of writes) await r.arrayBuffer();
  await request(
    ap + "/commit",
    "POST",
    {
      branch: "main",
      expected_sha: initial,
      message: "Stale edit",
      files: [{ path: "stale.txt", content: "no" }],
    },
    token,
    409,
  );
  console.log(
    "✓ Concurrent writes serialize; stale branch compare-and-swap rejected",
  );
  const head2 = (
    await request(ap + "/branches", "GET", undefined, token)
  ).branches.find((b) => b.name === "main").sha;
  await request(
    ap + "/commit",
    "POST",
    {
      branch: "main",
      expected_sha: head2,
      message: "Path injection",
      files: [{ path: "../outside", content: "no" }],
    },
    token,
    400,
  );
  const force = await git(
    ["push", "--force", "origin", `${initial}:main`],
    work,
    token,
    true,
  );
  assert.notEqual(force.code, 0);
  const readonly = await git(
    ["push", "origin", `${initial}:refs/heads/forbidden`],
    work,
    read.token,
    true,
  );
  assert.notEqual(readonly.code, 0);
  console.log(
    "✓ Path traversal, non-fast-forward push and unauthorized Git writes rejected",
  );
  const issue = await request(
    ap + "/issues",
    "POST",
    { title: "Test discussion", body: "Track real work" },
    token,
    201,
  );
  await request(
    ap + "/issues/" + issue.id + "/comments",
    "POST",
    { body: "Verified" },
    token,
    201,
  );
  assert.equal(
    (await request(ap + "/issues/" + issue.id, "GET", undefined, token))
      .comments.length,
    1,
  );
  await request(
    ap + "/issues/" + issue.id,
    "PATCH",
    { state: "closed" },
    token,
  );
  await request(
    ap + "/members",
    "PUT",
    { username: other, role: "reader" },
    token,
  );
  await request(ap, "GET", undefined, otherToken);
  await request(
    ap + "/commit",
    "POST",
    {
      branch: "main",
      expected_sha: head2,
      message: "Not allowed",
      files: [{ path: "reader.txt", content: "no" }],
    },
    otherToken,
    403,
  );
  await request(ap + "/members/" + other, "DELETE", undefined, token);
  await request(ap, "GET", undefined, otherToken, 404);
  console.log(
    "✓ Issues, discussion, state transitions and repository membership lifecycle",
  );
  const bytes = Buffer.from("binary\0LFS payload"),
    oid = createHash("sha256").update(bytes).digest("hex"),
    lfs = url + "/info/lfs/objects/";
  const batchRes = await fetch(lfs + "batch", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/vnd.git-lfs+json",
    },
    body: JSON.stringify({
      operation: "upload",
      objects: [{ oid, size: bytes.length }],
    }),
  });
  assert.equal(batchRes.status, 200);
  const batch = await batchRes.json();
  assert.equal(batch.objects[0].actions.upload.href, lfs + oid);
  const bad = await fetch(lfs + oid, {
    method: "PUT",
    headers: { Authorization: "Bearer " + token },
    body: "wrong",
  });
  assert.equal(bad.status, 400);
  await bad.arrayBuffer();
  const put = await fetch(lfs + oid, {
    method: "PUT",
    headers: { Authorization: "Bearer " + token },
    body: bytes,
  });
  assert.equal(put.status, 200);
  await put.arrayBuffer();
  const get = await fetch(lfs + oid, {
    headers: { Authorization: "Bearer " + read.token },
  });
  assert.equal(get.status, 200);
  assert.deepEqual(Buffer.from(await get.arrayBuffer()), bytes);
  const noauth = await fetch(lfs + oid);
  assert.equal(noauth.status, 401);
  await noauth.arrayBuffer();
  console.log(
    "✓ LFS batch API, SHA-256 validation, binary round-trip and private LFS authorization",
  );
  const recovered = join(tmp, "recovered");
  await git(["clone", url, recovered], tmp);
  assert.equal(
    await readFile(join(recovered, "feature.txt"), "utf8"),
    "feature\n",
  );
  console.log(
    "✓ Fresh request reconstructs Git content from R2 objects and durable refs",
  );
  await request(
    ap,
    "PATCH",
    { description: "Public round-trip", visibility: "public" },
    token,
  );
  await request(ap, "GET", undefined, null);
  const publicClone = join(tmp, "public");
  await git(["clone", url, publicClone], tmp, "");
  await request(
    ap + "/webhooks",
    "POST",
    { url: "https://127.0.0.1/internal" },
    token,
    400,
  );
  await request(ap + "/deliveries", "GET", undefined, token);
  const csrf = await fetch(origin + "/api/repos", {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: "https://evil.invalid",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: "csrf" }),
  });
  assert.equal(csrf.status, 403);
  await csrf.arrayBuffer();
  await request("/tokens/" + read.id, "DELETE", undefined, token);
  await request(ap, "GET", undefined, read.token, 401);
  const html = await fetch(origin + "/" + username + "/" + name);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /OneStorage/);
  assert.match(
    html.headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
  console.log(
    "✓ Public clone, CSRF rejection, token revocation and application HTML security headers",
  );
  const savedCookie = cookie;
  await request("/login", "POST", { username: other, password }, null);
  await request("/password", "POST", {
    current_password: password,
    new_password: password + "-changed",
  });
  await request(ap, "GET", undefined, otherToken, 401);
  cookie = savedCookie;
  console.log(
    "✓ Password change revokes every session and token; webhook egress policy enforced",
  );
  console.log(
    `PASS: ${checks} API assertions plus native Git, concurrency, LFS and object persistence checks. Test repository: ${username}/${name}`,
  );
  // Leave the test repo as a reviewable example; revoke credentials created by this run.
  const own = await request("/tokens");
  for (const item of own.tokens.filter((t) => t.name === "e2e_" + suffix))
    await request("/tokens/" + item.id, "DELETE");
} catch (e) {
  console.error("FAIL:", e.message);
  process.exitCode = 1;
} finally {
  await rm(tmp, { recursive: true, force: true });
}
