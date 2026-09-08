import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
const origin = process.env.TEST_ORIGIN || "http://localhost:8787",
  remote = !["localhost", "127.0.0.1"].includes(new URL(origin).hostname);
if (remote && process.env.ALLOW_REMOTE_ACCEPTANCE !== "1")
  throw Error("Remote acceptance requires opt-in");
let token = process.env.ONESTORAGE_TOKEN_FILE
    ? (await readFile(process.env.ONESTORAGE_TOKEN_FILE, "utf8")).trim()
    : "",
  admin = token ? { Authorization: "Bearer " + token } : {},
  checks = 0,
  retained = false;
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
const suffix = randomBytes(4).toString("hex"),
  workspace = "review_v07_" + suffix,
  users = [],
  repos = [];
let dir,
  temporaryTokenId,
  workspaceCreated = false;
try {
  for (const prefix of ["author", "observer"]) {
    const username = prefix + "_" + suffix,
      password = randomBytes(18).toString("hex");
    const u = await api("/users", "POST", { username, password }, admin, 201);
    users.push({
      ...u,
      password,
      auth: (await request("/login", "POST", { username, password }, {})).auth,
    });
  }
  const [author, observer] = users;
  await api(
    "/workspaces",
    "POST",
    { slug: workspace, name: "Fork review acceptance" },
    admin,
    201,
  );
  workspaceCreated = true;
  const target = await api(
    "/repos",
    "POST",
    { namespace: workspace, name: "upstream", visibility: "public" },
    admin,
    201,
  );
  repos.push(target);
  const ap = "/repos/" + workspace + "/upstream";
  async function commit(path, branch, files, auth = admin) {
    return api(
      path + "/commit-files",
      "POST",
      {
        target_branch: branch,
        commit_message: "Review fixture",
        files: Object.entries(files).map(([path, content]) => ({
          path,
          content,
        })),
      },
      auth,
      201,
    );
  }
  const initial = await commit(ap, "main", {
    "README.md": "# Upstream\n",
    "code.js": "export const version = 1;\n",
    "package.json": '{"name":"review-fixture"}',
  });
  const source = await api(
    "/repos",
    "POST",
    { name: "fork", visibility: "private", base_repo: { id: target.id } },
    author.auth,
    201,
  );
  repos.push(source);
  const sp = "/repos/" + author.username + "/fork";
  await api(
    sp + "/branches/create",
    "POST",
    { target_branch: "private-work", base_branch: "main" },
    author.auth,
    201,
  );
  const privateCommit = await commit(
    sp,
    "private-work",
    { "unpublished.txt": "private branch must not be copied" },
    author.auth,
  );
  const first = await commit(
    sp,
    "main",
    { "code.js": "export const version = 2;\n" },
    author.auth,
  );
  const unrelated = await api(
    "/repos",
    "POST",
    { name: "unrelated", visibility: "private" },
    author.auth,
    201,
  );
  repos.push(unrelated);
  await commit(
    "/repos/" + author.username + "/unrelated",
    "main",
    { README: "unrelated" },
    author.auth,
  );
  await api(
    ap + "/merges",
    "POST",
    {
      title: "Unrelated",
      source: "main",
      target: "main",
      source_repo: unrelated.id,
    },
    author.auth,
    400,
  );
  await api(
    ap + "/merges",
    "POST",
    {
      title: "Unauthorized",
      source: "main",
      target: "main",
      source_repo: source.id,
    },
    observer.auth,
    404,
  );
  await api(
    ap + "/commit",
    "POST",
    {
      branch: "main",
      expected_sha: initial.sha,
      message: "Denied",
      files: [{ path: "bad", content: "bad" }],
    },
    author.auth,
    403,
  );
  const sources = await api(
    ap + "/merge-sources",
    "GET",
    undefined,
    author.auth,
  );
  assert.equal(sources.repositories.length, 1);
  assert.equal(sources.repositories[0].id, source.id);
  await api(ap + "/protections", "PUT", {
    branch: "main",
    require_mr: true,
    approvals: 1,
    require_ci: true,
    require_resolved: true,
  });
  await api(ap + "/ci/config", "PUT", {
    config: {
      name: "Trusted target checks",
      runner: "worker",
      branches: ["no-auto"],
      steps: [{ type: "file", path: "package.json", format: "json" }],
    },
    enabled: true,
  });
  const mr = await api(
    ap + "/merges",
    "POST",
    {
      title: "Cross-fork contribution",
      body: "**Review** the isolated snapshot",
      source: "main",
      target: "main",
      source_repo: source.id,
    },
    author.auth,
    201,
  );
  const mp = ap + "/merges/" + mr.id;
  assert.equal(mr.source_repo_id, source.id);
  assert.equal(mr.source_sha, first.sha);
  await api(
    ap + "/blob?ref=" + privateCommit.sha + "&path=unpublished.txt",
    "GET",
    undefined,
    admin,
    409,
  );
  let detail = await api(mp, "GET", undefined, {});
  assert.match(detail.diff, /version = 2/);
  assert.equal(detail.stale, false);
  assert.equal(
    (await api(ap + "/branches")).branches.find((b) => b.name === "main").sha,
    initial.sha,
  );
  await api(mp + "/merge", "POST", {}, author.auth, 403);
  const review = {
    source_sha: mr.source_sha,
    target_sha: mr.target_sha,
    verdict: "approve",
    body: "Independent approval",
  };
  await api(mp + "/reviews", "POST", review, author.auth, 403);
  await api(mp + "/reviews", "POST", review, observer.auth, 403);
  await api(mp + "/reviews", "POST", review, admin, 201);
  await api(
    mp + "/discussions",
    "POST",
    { ...review, body: "Outside file", path: "code.js", side: "new", line: 2 },
    admin,
    400,
  );
  await api(
    mp + "/discussions",
    "POST",
    {
      ...review,
      body: "Invalid path",
      path: "../private",
      side: "new",
      line: 1,
    },
    admin,
    400,
  );
  const thread = await api(
    mp + "/discussions",
    "POST",
    {
      ...review,
      body: "Please explain this change",
      path: "code.js",
      side: "new",
      line: 1,
    },
    admin,
    201,
  );
  await api(
    mp + "/discussions/" + thread.id + "/comments",
    "POST",
    { body: "Explanation from fork author" },
    author.auth,
    201,
  );
  const comments = await api(mp + "/discussions/" + thread.id);
  assert.equal(comments.comments.length, 2);
  assert.equal(comments.thread.line, 1);
  await api(
    mp + "/discussions/" + thread.id,
    "PATCH",
    { resolved: true },
    observer.auth,
    403,
  );
  const informational = await api(
    mp + "/discussions",
    "POST",
    { ...review, body: "Public feedback" },
    observer.auth,
    201,
  );
  detail = await api(mp);
  assert.equal(detail.gate.unresolved, 1);
  assert.equal(detail.gate.allowed, false);
  await api(mp + "/merge", "POST", {}, admin, 409);
  const second = await commit(
    sp,
    "main",
    { "code.js": "export const version = 3;\n" },
    author.auth,
  );
  assert.equal((await api(mp)).stale, true);
  await api(mp + "/merge", "POST", {}, admin, 409);
  await api(mp, "PATCH", { refresh: true }, author.auth);
  detail = await api(mp);
  assert.equal(detail.source_sha, second.sha);
  assert.equal(detail.gate.approvals, 0);
  await api(
    mp,
    "PATCH",
    { title: "Stale title", revision: 0 },
    author.auth,
    409,
  );
  assert.equal(detail.gate.unresolved, 1);
  await api(mp + "/reviews", "POST", review, admin, 409);
  await api(
    mp + "/discussions",
    "POST",
    { ...review, body: "Old review position" },
    admin,
    409,
  );
  await api(
    mp + "/reviews",
    "POST",
    { ...review, source_sha: detail.source_sha, target_sha: detail.target_sha },
    admin,
    201,
  );
  await api(
    mp + "/discussions/" + thread.id,
    "PATCH",
    { resolved: true },
    author.auth,
  );
  await api(mp + "/pipeline", "POST", {}, author.auth, 403);
  assert.equal((await api(ap + "/ci/runs")).runs.length, 0);
  const run = await api(mp + "/pipeline", "POST", {}, admin, 201);
  for (let i = 0; i < 80; i++) {
    const state = await api(ap + "/ci/runs/" + run.id);
    if (state.status === "succeeded") break;
    if (state.status === "failed" || state.status === "cancelled")
      throw Error("Snapshot CI failed");
    if (i === 79) throw Error("Snapshot CI timed out");
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.equal((await api(mp)).gate.allowed, true);
  if (!remote && process.env.KEEP_REVIEW_FIXTURE === "1") {
    retained = true;
    await writeFile(
      ".data/v07-browser-fixture.json",
      JSON.stringify({
        workspace,
        ap,
        mp,
        source,
        author,
        observer,
        mr: detail,
        thread,
      }),
      { mode: 0o600 },
    );
    console.log(JSON.stringify({ checks, retained: true, workspace }));
  } else {
    const raced = await Promise.all([
      fetch(origin + "/api" + mp + "/merge", {
        method: "POST",
        headers: {
          Origin: origin,
          ...admin,
          "content-type": "application/json",
        },
        body: JSON.stringify({ strategy: "merge" }),
      }),
      fetch(origin + "/api" + mp + "/discussions/" + thread.id, {
        method: "PATCH",
        headers: {
          Origin: origin,
          ...admin,
          "content-type": "application/json",
        },
        body: JSON.stringify({ resolved: false }),
      }),
    ]);
    assert.ok(
      (raced[0].status === 200 && raced[1].status === 409) ||
        (raced[0].status === 409 && raced[1].status === 200),
      "Merge and reopening a blocking discussion must not both succeed",
    );
    checks += 2;
    if (raced[0].status === 409)
      await api(mp + "/discussions/" + thread.id, "PATCH", { resolved: true });
    const merged = await api(mp + "/merge", "POST", { strategy: "merge" });
    assert.ok(merged.sha);
    assert.equal((await api(mp + "/merge", "POST", {})).sha, merged.sha);
    await api(mp, "PATCH", { state: "closed" }, author.auth, 409);
    await api(
      mp + "/discussions/" + thread.id,
      "PATCH",
      { resolved: false },
      admin,
      409,
    );
    assert.equal((await api(mp)).state, "merged");
    assert.match(
      (await api(ap + "/blob?ref=main&path=code.js")).content,
      /version = 3/,
    );
    if (!token) {
      const temporary = await api(
        "/tokens",
        "POST",
        { name: "Fork native Git check", days: 1 },
        admin,
        201,
      );
      token = temporary.token;
      temporaryTokenId = temporary.id;
    }
    dir = await mkdtemp(join(tmpdir(), "onestorage-review-"));
    const askpass = join(dir, "askpass");
    await writeFile(
      askpass,
      '#!/bin/sh\ncase "$1" in *Username*) echo git;; *) printf "%s" "$REVIEW_GIT_TOKEN";; esac\n',
      { mode: 0o700 },
    );
    async function git(args, expected = 0) {
      return new Promise((resolve, reject) => {
        let output = "";
        const p = spawn("git", args, {
          cwd: dir,
          env: {
            ...process.env,
            GIT_ASKPASS: askpass,
            GIT_TERMINAL_PROMPT: "0",
            REVIEW_GIT_TOKEN: token,
          },
        });
        p.stdout.on("data", (x) => (output += x));
        p.stderr.on("data", (x) => (output += x));
        p.on("error", reject);
        p.on("close", (code) =>
          code === expected
            ? resolve(output)
            : reject(Error("Git verification failed: " + output)),
        );
      });
    }
    await git([
      "-c",
      "credential.helper=",
      "clone",
      "--bare",
      origin + "/" + workspace + "/upstream.git",
      "mirror.git",
    ]);
    await git(["--git-dir=mirror.git", "fsck", "--full", "--strict"]);
    await git(["--git-dir=mirror.git", "cat-file", "-e", second.sha]);
    const unpublished = await git(
      ["--git-dir=mirror.git", "cat-file", "-e", privateCommit.sha],
      1,
    );
    assert.equal(unpublished, "");
    console.log(
      JSON.stringify({
        checks,
        workspace,
        merged: merged.sha,
        nativeGit: "passed",
        unpublishedBranchExcluded: true,
      }),
    );
  }
} finally {
  if (dir) await rm(dir, { recursive: true, force: true });
  if (temporaryTokenId) await api("/tokens/" + temporaryTokenId, "DELETE");
  if (!retained) {
    for (const r of repos.reverse())
      await api("/admin/repositories/" + r.id, "DELETE");
    for (const u of users)
      await api("/admin/users/" + u.id, "PATCH", {
        disabled: true,
        revoke_sessions: true,
      });
    if (workspaceCreated) {
      for (let i = 0; i < 100; i++) {
        const response = await fetch(origin + "/api/workspaces/" + workspace, {
          method: "DELETE",
          headers: { Origin: origin, ...admin },
        });
        if (response.status === 200) {
          console.log(
            JSON.stringify({
              cleanup:
                "workspace removed; accounts disabled; repositories collected",
              workspace,
            }),
          );
          break;
        }
        assert.equal(response.status, 409, "Workspace cleanup failed");
        if (i === 99)
          throw Error("Repository cleanup did not complete in time");
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }
}
