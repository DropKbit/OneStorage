import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
const origin = process.env.TEST_ORIGIN || "http://localhost:8787",
  remote = !["localhost", "127.0.0.1"].includes(new URL(origin).hostname);
if (remote && process.env.ALLOW_REMOTE_ACCEPTANCE !== "1")
  throw Error("Remote acceptance requires opt-in");
const existing = process.env.ONESTORAGE_TOKEN_FILE
  ? (await readFile(process.env.ONESTORAGE_TOKEN_FILE, "utf8")).trim()
  : "";
let auth = existing ? { Authorization: "Bearer " + existing } : {},
  checks = 0;
async function api(path, method = "GET", body, status = 200) {
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
    method + " " + path + " " + JSON.stringify(data),
  );
  checks++;
  return { data, cookie: r.headers.get("set-cookie")?.split(";")[0] };
}
if (!existing)
  auth = {
    Cookie: (
      await api("/login", "POST", {
        username: "owner",
        password: "local-test-password-123",
      })
    ).cookie,
  };
const owner = (await api("/me")).data.user,
  name = "scale_" + randomBytes(4).toString("hex"),
  directory = await mkdtemp(join(tmpdir(), "onestorage-scale-"));
let repo,
  credential,
  spaceCreated = false;
const timings = [];
async function git(args) {
  const start = performance.now();
  const result = await new Promise((resolve, reject) => {
    const child = spawn("git", ["-c", "credential.helper=", ...args], {
      cwd: directory,
      env: {
        ...process.env,
        GIT_ASKPASS: join(directory, "askpass"),
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    let out = "",
      err = "";
    child.stdout.on("data", (b) => {
      out += b;
      if (out.length > 1024 * 1024) child.kill();
    });
    child.stderr.on("data", (b) => {
      err = (err + b).slice(-4000);
    });
    const timeout = setTimeout(() => child.kill("SIGTERM"), 1200000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, out, err });
    });
  });
  assert.equal(result.code, 0, "git " + args.join(" ") + " " + result.err);
  checks++;
  const ms = Math.round(performance.now() - start);
  if (args.some((a) => ["clone", "fetch", "push"].includes(a))) {
    timings.push({ command: args.join(" "), ms });
    console.log(
      JSON.stringify({
        stage: args.find((a) => ["clone", "fetch", "push"].includes(a)),
        ms,
      }),
    );
  }
  return result.out.trim();
}
try {
  await api(
    "/workspaces",
    "POST",
    { slug: name, name: "Git scale acceptance" },
    201,
  );
  spaceCreated = true;
  repo = (
    await api(
      "/repos",
      "POST",
      { namespace: name, name: "project", visibility: "private" },
      201,
    )
  ).data;
  credential = existing
    ? { token: existing }
    : (await api("/tokens", "POST", { name, scope: "write" }, 201)).data;
  await writeFile(join(directory, "token"), credential.token, { mode: 0o600 });
  await writeFile(
    join(directory, "askpass"),
    '#!/usr/bin/env node\nconst fs=require("node:fs"),p=require("node:path");process.stdout.write(process.argv[2].includes("Username")?"git":fs.readFileSync(p.join(__dirname,"token"),"utf8"));\n',
    { mode: 0o700 },
  );
  const url = origin + "/" + name + "/project.git";
  await git(["init", "-b", "main", "source"]);
  await git(["-C", "source", "config", "user.name", "Scale acceptance"]);
  await git(["-C", "source", "config", "user.email", "scale@example.invalid"]);
  await git(["-C", "source", "config", "gc.auto", "0"]);
  await git(["-C", "source", "remote", "add", "origin", url]);
  for (let batch = 0; batch < 6; batch++) {
    const folder = join(directory, "source", "batch" + batch);
    await mkdir(folder);
    await Promise.all(
      Array.from({ length: 900 }, (_, i) =>
        writeFile(join(folder, "file" + i), `batch ${batch} file ${i}\n`),
      ),
    );
    await writeFile(join(folder, "large.bin"), randomBytes(7 * 1024 * 1024));
    await git(["-C", "source", "add", "."]);
    await git(["-C", "source", "commit", "-m", "Batch " + batch]);
    await git(["-C", "source", "push", "origin", "main"]);
  }
  const count = Number(
    await git(["-C", "source", "rev-list", "--objects", "--all", "--count"]),
  );
  assert.ok(count > 5000, "fixture must exceed the previous graph ceiling");
  const stats = await git(["-C", "source", "count-objects", "-v"]);
  console.log(
    JSON.stringify({
      stage: "fixture",
      repoId: repo.id,
      objects: count,
      uncompressedPayload: 42 * 1024 * 1024,
      stats,
    }),
  );
  await git([
    "-c",
    "protocol.version=2",
    "clone",
    "--bare",
    url,
    "clone-v2.git",
  ]);
  await git(["--git-dir=clone-v2.git", "fsck", "--full", "--strict"]);
  const head = await git(["-C", "source", "rev-parse", "HEAD"]);
  assert.equal(
    await git(["--git-dir=clone-v2.git", "rev-parse", "main"]),
    head,
  );
  await git([
    "-c",
    "protocol.version=0",
    "clone",
    "--bare",
    url,
    "clone-v0.git",
  ]);
  await git(["--git-dir=clone-v0.git", "fsck", "--full", "--strict"]);
  assert.equal(
    await git(["--git-dir=clone-v0.git", "rev-parse", "main"]),
    head,
  );
  await writeFile(
    join(directory, "source", "incremental"),
    "One new file after 42 MiB of history\n",
  );
  await git(["-C", "source", "add", "."]);
  await git(["-C", "source", "commit", "-m", "Incremental"]);
  await git(["-C", "source", "push", "origin", "main"]);
  await git([
    "--git-dir=clone-v2.git",
    "fetch",
    "origin",
    "+refs/heads/main:refs/heads/main",
  ]);
  await git(["--git-dir=clone-v2.git", "fsck", "--full", "--strict"]);
  assert.equal(
    await git(["--git-dir=clone-v2.git", "rev-parse", "main"]),
    await git(["-C", "source", "rev-parse", "HEAD"]),
  );
  await git([
    "-c",
    "protocol.version=0",
    "--git-dir=clone-v0.git",
    "fetch",
    "origin",
    "+refs/heads/main:refs/heads/main",
  ]);
  await git(["--git-dir=clone-v0.git", "fsck", "--full", "--strict"]);
  const packet = (value) =>
    Buffer.from(
      (Buffer.byteLength(value) + 4).toString(16).padStart(4, "0") + value,
    );
  const abort = new AbortController();
  const interrupted = await fetch(url + "/git-upload-pack", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + credential.token,
      "content-type": "application/x-git-upload-pack-request",
      "git-protocol": "version=2",
    },
    body: Buffer.concat([
      packet("command=fetch\n"),
      Buffer.from("0001"),
      packet(`want ${head}\n`),
      packet("done\n"),
      Buffer.from("0000"),
    ]),
    signal: abort.signal,
  });
  assert.equal(interrupted.status, 200);
  const reader = interrupted.body.getReader();
  let received = 0;
  while (received < 128 * 1024) {
    const item = await reader.read();
    assert.equal(item.done, false);
    received += item.value.byteLength;
  }
  await reader.cancel();
  abort.abort();
  checks++;
  const afterAbort = performance.now();
  await git(["ls-remote", url]);
  assert.ok(
    performance.now() - afterAbort < 30000,
    "canceled download releases repository queue",
  );
  const anonymous = await fetch(url + "/info/refs?service=git-upload-pack");
  assert.equal(anonymous.status, 401);
  checks++;
  console.log(
    JSON.stringify({
      checks,
      repoId: repo.id,
      name,
      objects: count,
      uncompressedPayload: 42 * 1024 * 1024,
      nativeGit: "v0/v2 clone, incremental push/fetch and fsck passed",
      timings,
    }),
  );
} finally {
  if (repo) await api("/admin/repositories/" + repo.id, "DELETE");
  if (credential?.id) await api("/tokens/" + credential.id, "DELETE");
  await rm(directory, { recursive: true, force: true });
  if (spaceCreated) {
    let removed = false;
    for (let n = 0; n < 240; n++) {
      const response = await fetch(origin + "/api/workspaces/" + name, {
        method: "DELETE",
        headers: { Origin: origin, ...auth },
        signal: AbortSignal.timeout(30000),
      });
      if (response.status === 200) {
        removed = true;
        break;
      }
      assert.equal(response.status, 409, "workspace GC cleanup");
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert.ok(removed, "large repository GC completed");
  }
  console.log(
    JSON.stringify({
      cleanup:
        "test repository and workspace removed; temporary acceptance token revoked if created; local Git fixtures removed",
      name,
    }),
  );
}
