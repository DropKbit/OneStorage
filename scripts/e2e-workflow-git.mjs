import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
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
  createdSpace = false;
const space = "ci_git_" + crypto.randomUUID().slice(0, 8),
  ap = "/api/repos/" + space + "/project";
const directory = await mkdtemp(join(tmpdir(), "onestorage-ci-git-")),
  work = join(directory, "work");
await mkdir(work);
let checks = 0;
async function api(path, method = "GET", body, status = 200) {
  const r = await fetch(origin + path, {
    method,
    headers: {
      Origin: origin,
      ...(token ? { Authorization: "Bearer " + token } : { Cookie: cookie }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const data = await r.json();
  assert.equal(
    r.status,
    status,
    method + " " + path + " " + JSON.stringify(data),
  );
  checks++;
  if (path === "/api/login")
    cookie = r.headers.get("set-cookie")?.split(";")[0] || "";
  return data;
}
let gitEnv;
async function git(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(
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
      { cwd: work, env: gitEnv },
    );
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(Error("Git acceptance timeout"));
    }, 120000);
    child.stdout.on("data", (b) => (output += b));
    child.stderr.on("data", (b) => (output += b));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve(output.trim())
        : reject(Error(output.replaceAll(token, "[redacted]")));
    });
  });
}
try {
  if (!token) {
    await api("/api/login", "POST", {
      username: "owner",
      password: "local-test-password-123",
    });
    temporaryToken = await api(
      "/api/tokens",
      "POST",
      { name: "Native workflow acceptance", scope: "write", days: 1 },
      201,
    );
    token = temporaryToken.token;
  }
  const owner = (await api("/api/me")).user;
  await api(
    "/api/workspaces",
    "POST",
    { slug: space, name: "Native Git CI acceptance" },
    201,
  );
  createdSpace = true;
  repo = await api(
    "/api/repos",
    "POST",
    { namespace: space, name: "project", visibility: "private" },
    201,
  );
  await api(ap + "/ci/config", "PUT", {
    source_path: ".onestorage-ci.json",
    enabled: true,
  });
  const config = {
    name: "Native push workflow",
    runner: "workflow",
    branches: ["main"],
    jobs: [
      {
        id: "metadata",
        pipeline: {
          runner: "worker",
          steps: [{ type: "file", path: "package.json", format: "json" }],
        },
      },
      {
        id: "verify",
        needs: ["metadata"],
        pipeline: {
          runner: "worker",
          steps: [{ type: "file", path: "README.md" }],
        },
      },
    ],
  };
  await writeFile(join(work, ".onestorage-ci.json"), JSON.stringify(config));
  await writeFile(join(work, "package.json"), '{"name":"native-ci-fixture"}');
  await writeFile(join(work, "README.md"), "# Native workflow\n");
  const tokenFile = join(directory, "token"),
    askpass = join(directory, "askpass");
  await writeFile(tokenFile, token, { mode: 0o600 });
  await writeFile(
    askpass,
    '#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" "$ONESTORAGE_GIT_USER" ;; *) cat "$ONESTORAGE_GIT_TOKEN_FILE" ;; esac\n',
    { mode: 0o700 },
  );
  gitEnv = {
    ...process.env,
    GIT_ASKPASS: askpass,
    GIT_TERMINAL_PROMPT: "0",
    ONESTORAGE_GIT_USER: owner.username,
    ONESTORAGE_GIT_TOKEN_FILE: tokenFile,
  };
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Workflow acceptance"]);
  await git(["config", "user.email", "ci@example.invalid"]);
  await git(["add", "."]);
  await git(["commit", "-m", "Native workflow config"]);
  const sha = await git(["rev-parse", "HEAD"]);
  await git([
    "push",
    origin + "/" + space + "/project.git",
    "HEAD:refs/heads/main",
  ]);
  let run;
  for (let n = 0; n < 180; n++) {
    run = (await api(ap + "/ci/runs")).runs.find(
      (r) => r.sha === sha && r.trigger === "push",
    );
    if (run && ["succeeded", "failed", "canceled"].includes(run.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.equal(run?.status, "succeeded", JSON.stringify(run));
  assert.equal(run.config_sha, sha);
  assert.equal(run.config_path, ".onestorage-ci.json");
  checks += 3;
  const detail = await api(ap + "/ci/runs/" + run.id);
  assert.equal(detail.jobs.length, 2);
  assert.ok(
    detail.jobs.every((j) => j.sha === sha && j.status === "succeeded"),
  );
  checks += 2;
  await git([
    "clone",
    "--bare",
    origin + "/" + space + "/project.git",
    join(directory, "mirror.git"),
  ]);
  await git([
    "--git-dir=" + join(directory, "mirror.git"),
    "fsck",
    "--full",
    "--strict",
  ]);
  assert.equal(
    await git([
      "--git-dir=" + join(directory, "mirror.git"),
      "rev-parse",
      "refs/heads/main",
    ]),
    sha,
  );
  checks++;
  console.log(
    JSON.stringify({
      checks,
      workspace: space,
      sha,
      workflow: run.id,
      nativeGit: "push -> versioned DAG -> clone/fsck passed",
    }),
  );
} finally {
  if (repo) await api("/api/admin/repositories/" + repo.id, "DELETE");
  if (createdSpace) {
    let removed = false;
    for (let n = 0; n < 180; n++) {
      const r = await fetch(origin + "/api/workspaces/" + space, {
        method: "DELETE",
        headers: { Origin: origin, Authorization: "Bearer " + token },
        signal: AbortSignal.timeout(30000),
      });
      if (r.status === 200) {
        removed = true;
        break;
      }
      assert.equal(r.status, 409);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert.ok(removed, "Native Git CI fixture cleanup");
  }
  if (temporaryToken) await api("/api/tokens/" + temporaryToken.id, "DELETE");
  await rm(directory, { recursive: true, force: true });
  console.log(
    JSON.stringify({
      cleanup: "repository/workspace and temporary Git/credentials removed",
      workspace: space,
    }),
  );
}
