import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
  const data = await r.json();
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
  workspace = "owners_v08_" + suffix,
  users = [],
  repos = [];
let created = false;
try {
  for (const prefix of ["author", "reviewer"]) {
    const username = prefix + "_" + suffix,
      password = randomBytes(18).toString("hex"),
      u = await api("/users", "POST", { username, password }, admin, 201);
    users.push({
      ...u,
      username,
      auth: (await request("/login", "POST", { username, password }, {})).auth,
    });
  }
  const [author, reviewer] = users;
  await api(
    "/workspaces",
    "POST",
    { slug: workspace, name: "CODEOWNERS acceptance" },
    admin,
    201,
  );
  created = true;
  const repo = await api(
    "/repos",
    "POST",
    { namespace: workspace, name: "repo", visibility: "private" },
    admin,
    201,
  );
  repos.push(repo);
  const other = await api(
    "/repos",
    "POST",
    { namespace: workspace, name: "other", visibility: "private" },
    admin,
    201,
  );
  repos.push(other);
  const ap = "/repos/" + workspace + "/repo",
    op = "/repos/" + workspace + "/other";
  for (const user of users)
    await api(ap + "/members", "PUT", {
      username: user.username,
      role: "developer",
    });
  async function commit(branch, files, message = "Acceptance", auth = admin) {
    return api(
      ap + "/commit-files",
      "POST",
      {
        target_branch: branch,
        commit_message: message,
        files: Object.entries(files).map(([path, content]) => ({
          path,
          content,
        })),
      },
      auth,
      201,
    );
  }
  const codeowners = `* @${owner.username}\n[Code]\n/code.txt @${reviewer.username}\n^[Advice]\n* @missing-owner\n`;
  const base = await commit("main", {
    CODEOWNERS: codeowners,
    "code.txt": "one\n",
  });
  const issue1 = await api(
      ap + "/issues",
      "POST",
      { title: "Description close" },
      admin,
      201,
    ),
    issue2 = await api(
      ap + "/issues",
      "POST",
      { title: "Commit close" },
      admin,
      201,
    ),
    unrelated = await api(
      op + "/issues",
      "POST",
      { title: "Unrelated" },
      admin,
      201,
    );
  await api(
    ap + "/branches/create",
    "POST",
    { target_branch: "feature", base_branch: "main" },
    author.auth,
    201,
  );
  const source = await commit(
    "feature",
    { "code.txt": "two\n", CODEOWNERS: "* @" + author.username },
    `Fixes #${issue2.id} and #${unrelated.id}`,
    author.auth,
  );
  await api(ap + "/protections", "PUT", {
    branch: "main",
    approvals: 0,
    require_mr: false,
    require_codeowners: true,
  });
  const mr = await api(
      ap + "/merges",
      "POST",
      {
        title: "Owner gates",
        body: `Closes #${issue1.id}`,
        source: "feature",
        target: "main",
      },
      author.auth,
      201,
    ),
    mp = ap + "/merges/" + mr.id;
  let detail = await api(mp);
  assert.equal(detail.gate.allowed, false);
  assert.equal(detail.gate.codeowners.target_sha, base.sha);
  assert.deepEqual(detail.closing_issues, [issue1.id, issue2.id]);
  assert.deepEqual(
    detail.gate.codeowners.requirements.find((r) => r.pattern === "/code.txt")
      .eligible,
    [reviewer.username],
  );
  await api(mp + "/merge", "POST", {}, admin, 409);
  await commit("main", { bad: "must not publish" }, "Forbidden", admin).then(
    () => {
      throw Error("Direct write bypassed CODEOWNERS");
    },
    (e) => {
      assert.match(e.message, /403/);
    },
  );
  async function approve(auth) {
    return api(
      mp + "/reviews",
      "POST",
      { verdict: "approve", source_sha: source.sha, target_sha: base.sha },
      auth,
      201,
    );
  }
  await api(
    mp + "/reviews",
    "POST",
    { verdict: "approve", source_sha: source.sha, target_sha: base.sha },
    author.auth,
    403,
  );
  await approve(admin);
  assert.equal((await api(mp)).gate.allowed, false);
  await approve(reviewer.auth);
  assert.equal((await api(mp)).gate.allowed, true);
  await api(ap + "/members/" + reviewer.username, "DELETE");
  assert.equal((await api(mp)).gate.allowed, false);
  await api(mp + "/merge", "POST", {}, admin, 409);
  await api(ap + "/members", "PUT", {
    username: reviewer.username,
    role: "developer",
  });
  // The final merge intent must refer to the description/revision the maintainer saw.
  await api(
    mp,
    "PATCH",
    {
      body: `Closes #${issue1.id}\n\nFinal description`,
      revision: mr.revision,
    },
    author.auth,
  );
  await api(mp + "/merge", "POST", { revision: mr.revision }, admin, 409);
  const merged = await api(mp + "/merge", "POST", {
    revision: (await api(mp)).revision,
  });
  assert.equal(merged.sha, source.sha);
  const closed = await api(ap + "/issues/" + issue1.id);
  assert.equal(closed.state, "closed");
  assert.equal(
    closed.comments.filter((c) => c.body.includes("Closed by merge request"))
      .length,
    1,
  );
  assert.equal((await api(ap + "/issues/" + issue2.id)).state, "closed");
  assert.equal((await api(op + "/issues/" + unrelated.id)).state, "open");
  await api(ap + "/issues/" + issue1.id, "PATCH", { state: "open" });
  assert.equal((await api(mp + "/merge", "POST", {})).sha, merged.sha);
  assert.equal((await api(ap + "/issues/" + issue1.id)).state, "open");
  assert.equal(
    (await api(ap + "/issues/" + issue1.id)).comments.length,
    closed.comments.length,
  );
  // No-op merges still record a durable result and default-branch closure plan.
  const noopIssue = await api(
    ap + "/issues",
    "POST",
    { title: "No-op close" },
    admin,
    201,
  );
  await api(
    ap + "/branches/create",
    "POST",
    { target_branch: "noop", base_branch: "main" },
    author.auth,
    201,
  );
  const noop = await api(
    ap + "/merges",
    "POST",
    {
      title: "No-op",
      body: `Resolves #${noopIssue.id}`,
      source: "noop",
      target: "main",
    },
    author.auth,
    201,
  );
  const noopResult = await api(
    ap + "/merges/" + noop.id + "/merge",
    "POST",
    {},
  );
  assert.equal(noopResult.result, "no_op");
  assert.equal((await api(ap + "/issues/" + noopIssue.id)).state, "closed");
  await api(ap + "/issues/" + noopIssue.id, "PATCH", { state: "open" });
  await api(ap + "/merges/" + noop.id + "/merge", "POST", {});
  assert.equal((await api(ap + "/issues/" + noopIssue.id)).state, "open");
  await api(
    ap + "/branches/create",
    "POST",
    { target_branch: "release", base_branch: "main" },
    author.auth,
    201,
  );
  const release = await api(
    ap + "/merges",
    "POST",
    {
      title: "Release target",
      body: `Closes #${noopIssue.id}`,
      source: "noop",
      target: "release",
    },
    author.auth,
    201,
  );
  assert.deepEqual(
    (await api(ap + "/merges/" + release.id)).closing_issues,
    [],
  );
  await api(ap + "/merges/" + release.id + "/merge", "POST", {});
  assert.equal((await api(ap + "/issues/" + noopIssue.id)).state, "open");
  console.log(
    JSON.stringify({
      checks,
      workspace,
      codeowners: "passed",
      issueClosures: "passed",
      replayAndNoop: "passed",
    }),
  );
} finally {
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
