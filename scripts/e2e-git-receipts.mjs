import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
const origin = process.env.TEST_ORIGIN || "http://localhost:8787";
const remote = !["localhost", "127.0.0.1"].includes(new URL(origin).hostname);
if (remote && process.env.ALLOW_REMOTE_ACCEPTANCE !== "1")
  throw Error("Remote acceptance requires opt-in");
let token = process.env.ONESTORAGE_TOKEN_FILE
    ? (await readFile(process.env.ONESTORAGE_TOKEN_FILE, "utf8")).trim()
    : "",
  cookie = "",
  temporaryToken,
  repo,
  created = false,
  checks = 0;
const space = "receipts_v29_" + randomBytes(4).toString("hex"),
  directory = await mkdtemp(join(tmpdir(), "onestorage-receipts-"));
const ap = "/repos/" + space + "/project",
  url = origin + "/" + space + "/project.git";
const records = [],
  timings = [];
async function api(path, method = "GET", body, status = 200) {
  const response = await fetch(origin + "/api" + path, {
    method,
    headers: {
      Origin: origin,
      ...(token ? { Authorization: "Bearer " + token } : { Cookie: cookie }),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const data = await response.json();
  assert.equal(
    response.status,
    status,
    method + " " + path + " " + (data.error || ""),
  );
  checks++;
  if (path === "/login")
    cookie = response.headers.get("set-cookie")?.split(";")[0] || "";
  return data;
}
let gitEnv;
async function git(args, allowFailure = false) {
  return await new Promise((resolve, reject) => {
    const process = spawn(
      "git",
      [
        "-c",
        "credential.helper=",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "http.extraHeader=X-OneStorage-Probe: v29-acceptance",
        ...args,
      ],
      { cwd: directory, env: gitEnv },
    );
    let output = "",
      timeout = false;
    const timer = setTimeout(() => {
      timeout = true;
      process.kill("SIGTERM");
    }, 240000);
    process.stdout.on("data", (b) => (output += b));
    process.stderr.on("data", (b) => (output += b));
    process.on("error", reject);
    process.on("close", (code) => {
      clearTimeout(timer);
      const result = {
        code,
        timeout,
        output: output.replaceAll(token, "[redacted]").trim(),
      };
      if (timeout || (code !== 0 && !allowFailure))
        reject(Error(result.output || "Git timeout"));
      else resolve(result);
    });
  });
}
async function waitReceipt(refsUpdated) {
  const previous = new Set(records.map((r) => r.event_id));
  for (let i = 0; i < 120; i++) {
    const rows = (await api(ap + "/audit")).events.filter(
      (r) => r.action === "git.receive_pack",
    );
    if (rows.length > previous.size) {
      assert.equal(
        rows.length,
        previous.size + 1,
        "exactly one audit per accepted multi-ref batch",
      );
      const next = rows.filter((r) => !previous.has(r.event_id));
      assert.equal(next.length, 1);
      const row = next[0];
      assert.match(row.event_id, /^[a-f0-9-]{36}$/);
      assert.equal(JSON.parse(row.detail).refs_updated, refsUpdated);
      assert.equal(row.actor_id, ownerId);
      records.push({
        id: row.id,
        event_id: row.event_id,
        refs_updated: refsUpdated,
        created_at: row.created_at,
      });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw Error("Durable audit delivery did not complete");
}
let ownerId;
try {
  if (!token) {
    await api("/login", "POST", {
      username: "owner",
      password: "local-test-password-123",
    });
    temporaryToken = await api(
      "/tokens",
      "POST",
      { name: "Git receipt acceptance", scope: "write", days: 1 },
      201,
    );
    token = temporaryToken.token;
  }
  ownerId = (await api("/me")).user.id;
  await api(
    "/workspaces",
    "POST",
    { slug: space, name: "Git audit acceptance" },
    201,
  );
  created = true;
  repo = await api(
    "/repos",
    "POST",
    { namespace: space, name: "project", visibility: "private" },
    201,
  );
  await writeFile(
    ".data/v29-" + (remote ? "production" : "local") + "-receipts-fixture.json",
    JSON.stringify({ space, repo: repo.id }) + "\n",
  );
  const askpass = join(directory, "askpass.cjs");
  await writeFile(
    askpass,
    '#!/usr/bin/env node\nprocess.stdout.write(process.argv[2].includes("Username") ? "acceptance\\n" : process.env.ONESTORAGE_ACCEPTANCE_TOKEN + "\\n");\n',
    { mode: 0o700 },
  );
  gitEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: askpass,
    ONESTORAGE_ACCEPTANCE_TOKEN: token,
  };
  for (const key of ["GIT_CURL_VERBOSE", "GIT_TRACE_CURL", "GIT_TRACE"])
    delete gitEnv[key];
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Git receipt acceptance"]);
  await git(["config", "user.email", "receipt@example.invalid"]);
  await writeFile(join(directory, ".gitignore"), "askpass.cjs\n");
  let accepted;
  for (let wave = 0; wave < 3; wave++) {
    for (let i = 0; i < (wave ? 8 : 32); i++)
      await writeFile(
        join(directory, "file-" + i + ".txt"),
        randomBytes(2048).toString("base64") + "\n",
      );
    await git(["add", "."]);
    await git(["commit", "-m", "Native receipt " + wave]);
    accepted = (await git(["rev-parse", "HEAD"])).output;
    const start = Date.now();
    await git(["push", url, "main"]);
    timings.push(Date.now() - start);
    assert.equal(
      (await git(["ls-remote", url, "refs/heads/main"])).output.split(/\s/)[0],
      accepted,
    );
    await waitReceipt(1);
    console.log(
      JSON.stringify({ wave, accepted, audit: records.at(-1).event_id }),
    );
  }
  await git(["branch", "feature"]);
  await git(["tag", "receipt-test"]);
  await git(["push", "--atomic", url, "feature", "refs/tags/receipt-test"]);
  await waitReceipt(2);
  await git([
    "push",
    "--atomic",
    url,
    ":refs/heads/feature",
    ":refs/tags/receipt-test",
  ]);
  await waitReceipt(2);
  const bulkBranches = Array.from({ length: 129 }, (_, i) => "bulk-" + i);
  for (const branch of bulkBranches) await git(["branch", branch]);
  await git(["push", "--atomic", url, ...bulkBranches]);
  await waitReceipt(129);
  await git([
    "push",
    "--atomic",
    url,
    ...bulkBranches.map((branch) => ":refs/heads/" + branch),
  ]);
  await waitReceipt(129);
  await git(["push", url, "main"]);
  assert.equal(
    (await api(ap + "/audit")).events.filter(
      (r) => r.action === "git.receive_pack",
    ).length,
    records.length,
    "no-op push does not create audit",
  );
  await api(ap + "/protections", "PUT", {
    branch: "main",
    require_mr: true,
    approvals: 0,
    require_ci: false,
  });
  await writeFile(join(directory, "rejected.txt"), "must not publish");
  await git(["add", "."]);
  await git(["commit", "-m", "Rejected protected write"]);
  const denied = await git(["push", url, "main"], true);
  assert.notEqual(denied.code, 0);
  assert.match(denied.output, /rejected|protected|merge request/i);
  assert.equal(
    (await git(["ls-remote", url, "refs/heads/main"])).output.split(/\s/)[0],
    accepted,
  );
  assert.equal(
    (await api(ap + "/audit")).events.filter(
      (r) => r.action === "git.receive_pack",
    ).length,
    records.length,
    "rejected pack does not claim successful publication",
  );
  await git(["clone", "--mirror", url, join(directory, "mirror.git")]);
  await git(["--git-dir=" + join(directory, "mirror.git"), "fsck", "--strict"]);
  assert.equal(
    (
      await git([
        "--git-dir=" + join(directory, "mirror.git"),
        "rev-parse",
        "main",
      ])
    ).output,
    accepted,
  );
  const evidence = {
    origin,
    space,
    repo: repo.id,
    checks,
    accepted,
    receipts: records,
    pushMS: timings,
    multiRef:
      "atomic create/delete produce one receipt per batch, for both 2 and 129 refs",
    rejectedAndNoop: "no success receipt",
    mirror: "strict fsck passed",
  };
  await writeFile(
    ".data/v29-" + (remote ? "production" : "local") + "-receipts.json",
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(JSON.stringify(evidence));
} finally {
  if (repo) await api("/admin/repositories/" + repo.id, "DELETE");
  if (created) {
    let removed = false;
    for (let i = 0; i < 120; i++) {
      const r = await fetch(origin + "/api/workspaces/" + space, {
        method: "DELETE",
        headers: { Origin: origin, Authorization: "Bearer " + token },
        signal: AbortSignal.timeout(120000),
      });
      if (r.status === 200) {
        removed = true;
        break;
      }
      if (r.status !== 409) throw Error("Workspace cleanup failed " + r.status);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert.ok(removed, "Workspace cleanup completed");
  }
  if (temporaryToken) {
    await api("/tokens/" + temporaryToken.id, "DELETE");
    token = "";
    await api("/logout", "POST");
  }
  await rm(directory, { recursive: true, force: true });
  console.log(JSON.stringify({ cleanup: true, space }));
}
