import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  mkdir,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
const origin = process.env.TEST_ORIGIN || "http://localhost:8787",
  remote = !["localhost", "127.0.0.1"].includes(new URL(origin).hostname);
const readConcurrency = process.env.ONESTORAGE_READ_CONCURRENCY === "1",
  cacheAcceptance =
    readConcurrency || process.env.ONESTORAGE_PACK_CACHE === "1",
  singleImport =
    cacheAcceptance || process.env.ONESTORAGE_SINGLE_IMPORT === "1",
  payloadBytes = (cacheAcceptance ? 10 : singleImport ? 35 : 42) * 1024 * 1024;
if (remote && process.env.ALLOW_REMOTE_ACCEPTANCE !== "1")
  throw Error("Remote acceptance requires opt-in");
const existing = process.env.ONESTORAGE_TOKEN_FILE
  ? (await readFile(process.env.ONESTORAGE_TOKEN_FILE, "utf8")).trim()
  : "";
let auth = existing ? { Authorization: "Bearer " + existing } : {},
  checks = 0;
async function api(
  path,
  method = "GET",
  body,
  status = 200,
  timeoutMs = 120000,
) {
  const r = await fetch(origin + "/api" + path, {
    method,
    headers: {
      Origin: origin,
      ...auth,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
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
async function git(args, input = "") {
  const start = performance.now();
  const result = await new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const key of ["GIT_CURL_VERBOSE", "GIT_TRACE_CURL", "GIT_TRACE"])
      delete env[key];
    const child = spawn("git", ["-c", "credential.helper=", ...args], {
      cwd: directory,
      env: {
        ...env,
        GIT_ASKPASS: join(directory, "askpass"),
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    child.stdin.end(input);
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
  let seedHead;
  if (readConcurrency) {
    await writeFile(join(directory, "source", "README.md"), "Published seed\n");
    await git(["-C", "source", "add", "."]);
    await git(["-C", "source", "commit", "-m", "Published seed"]);
    await git(["-C", "source", "push", "origin", "main"]);
    seedHead = await git(["-C", "source", "rev-parse", "HEAD"]);
  }
  for (let batch = 0; batch < (singleImport ? 1 : 6); batch++) {
    const folder = join(directory, "source", "batch" + batch);
    await mkdir(folder);
    await Promise.all(
      Array.from(
        { length: cacheAcceptance ? 1100 : singleImport ? 2100 : 900 },
        (_, i) =>
          writeFile(join(folder, "file" + i), `batch ${batch} file ${i}\n`),
      ),
    );
    for (let i = 0; i < (cacheAcceptance ? 2 : singleImport ? 5 : 1); i++)
      await writeFile(
        join(folder, `large${i}.bin`),
        randomBytes((cacheAcceptance ? 5 : 7) * 1024 * 1024),
      );
    await git(["-C", "source", "add", "."]);
    await git(["-C", "source", "commit", "-m", "Batch " + batch]);
    if (singleImport) {
      const hash = await git([
        "-C",
        "source",
        "pack-objects",
        "--all",
        "--revs",
        "--window=10",
        "--depth=50",
        join(directory, "initial"),
      ]);
      const packBytes = (await stat(join(directory, `initial-${hash}.pack`)))
        .size;
      assert.ok(
        packBytes > (cacheAcceptance ? 8 : 16) * 1024 * 1024,
        cacheAcceptance
          ? "cache fixture spans at least three R2 chunks"
          : "initial pack exceeds old 16 MiB wire limit",
      );
      console.log(
        JSON.stringify({
          stage: "initial-pack",
          repoId: repo.id,
          packBytes,
          payloadBytes,
        }),
      );
    }
    if (readConcurrency) {
      const before = (await api(`/repos/${name}/project`)).data;
      let pushed = false,
        archived = false,
        archiving;
      const pushing = git(["-C", "source", "push", "origin", "main"]).then(
        () => {
          pushed = true;
        },
      );
      pushing.catch(() => {});
      let archivedState;
      try {
        await new Promise((r) => setTimeout(r, 250));
        await snapshotPage(seedHead, "native-upload", 30000);
        assert.equal(
          pushed,
          false,
          "page returns while the native push remains active",
        );
        checks++;
        const anonymous = await fetch(
          origin + `/api/repos/${name}/project/browse`,
          { signal: AbortSignal.timeout(12000) },
        );
        assert.ok(
          [401, 404].includes(anonymous.status),
          "snapshot still requires authorization",
        );
        await anonymous.body?.cancel();
        checks++;
        const start = performance.now();
        archiving = api(
          `/repos/${name}/project/lifecycle`,
          "PUT",
          { archived: true, revision: before.lifecycle_revision },
          200,
          1200000,
        ).then((value) => {
          archived = true;
          console.log(
            JSON.stringify({
              stage: "archive-after-upload",
              ms: Math.round(performance.now() - start),
            }),
          );
          return value;
        });
        archiving.catch(() => {});
        await new Promise((r) => setTimeout(r, 100));
        assert.equal(
          archived,
          false,
          "archive remains pending while native upload processes objects",
        );
        checks++;
      } finally {
        await pushing;
        if (archiving) archivedState = (await archiving).data;
      }
      await api(`/repos/${name}/project/lifecycle`, "PUT", {
        archived: false,
        revision: archivedState.lifecycle_revision,
      });
    } else await git(["-C", "source", "push", "origin", "main"]);
  }
  const count = Number(
    await git(["-C", "source", "rev-list", "--objects", "--all", "--count"]),
  );
  assert.ok(
    count > (cacheAcceptance ? 1100 : singleImport ? 2000 : 5000),
    "fixture must exceed the previous object ceiling",
  );
  const stats = await git(["-C", "source", "count-objects", "-v"]);
  console.log(
    JSON.stringify({
      stage: "fixture",
      repoId: repo.id,
      objects: count,
      uncompressedPayload: payloadBytes,
      singleInitialPush: singleImport && !readConcurrency,
      seededImport: readConcurrency,
      cacheAcceptance,
      readConcurrency,
      stats,
    }),
  );
  const initialHead = await git(["-C", "source", "rev-parse", "HEAD"]);
  const packet = (value) =>
    Buffer.from(
      (Buffer.byteLength(value) + 4).toString(16).padStart(4, "0") + value,
    );
  async function snapshotPage(expected, operation, maxWait = 12000) {
    const start = performance.now();
    let found = false;
    for (let n = 0; n < 30 && performance.now() - start < maxWait; n++) {
      const response = await fetch(
        origin + `/api/repos/${name}/project/browse`,
        {
          headers: auth,
          signal: AbortSignal.timeout(12000),
        },
      );
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(
        data.data.ref,
        expected,
        "browse is a coherent published ref snapshot",
      );
      if (data.readme)
        assert.equal(
          data.readme.ref,
          expected,
          "README shares the captured reference",
        );
      if (response.headers.get("x-onestorage-read-mode") === "snapshot") {
        found = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(
      found,
      "browse must finish through the snapshot lane during " + operation,
    );
    const elapsed = Math.round(performance.now() - start);
    assert.ok(
      elapsed < maxWait,
      "snapshot page must not wait for held Git transfer",
    );
    checks++;
    console.log(
      JSON.stringify({
        stage: "concurrent-browse",
        operation,
        ms: elapsed,
        ref: expected,
      }),
    );
  }
  if (readConcurrency) {
    const download = await fetch(url + "/git-upload-pack", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + credential.token,
        "content-type": "application/x-git-upload-pack-request",
        "git-protocol": "version=2",
      },
      body: Buffer.concat([
        packet("command=fetch\n"),
        Buffer.from("0001"),
        packet(`want ${initialHead}\n`),
        packet("done\n"),
        Buffer.from("0000"),
      ]),
      signal: AbortSignal.timeout(90000),
    });
    assert.equal(download.status, 200);
    try {
      await snapshotPage(initialHead, "download");
    } finally {
      await download.body.cancel();
    }
    await git(["ls-remote", url]);
  }
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
  if (cacheAcceptance) {
    await git([
      "-c",
      "protocol.version=2",
      "clone",
      "--bare",
      url,
      "clone-warm.git",
    ]);
    await git(["--git-dir=clone-warm.git", "fsck", "--full", "--strict"]);
    assert.equal(
      await git(["--git-dir=clone-warm.git", "rev-parse", "main"]),
      head,
    );
  }
  await writeFile(
    join(directory, "source", "incremental"),
    `One new file after ${payloadBytes} bytes of history\n`,
  );
  await git(["-C", "source", "add", "."]);
  await git(["-C", "source", "commit", "-m", "Incremental"]);
  if (readConcurrency && !remote) {
    const next = await git(["-C", "source", "rev-parse", "HEAD"]);
    const hash = await git(
      [
        "-C",
        "source",
        "pack-objects",
        "--revs",
        join(directory, "incremental-pack"),
      ],
      next + "\n^" + head + "\n",
    );
    const pack = await readFile(
      join(directory, `incremental-pack-${hash}.pack`),
    );
    const beforeLifecycle = (await api(`/repos/${name}/project`)).data;
    let release;
    const held = new Promise((r) => {
      release = r;
    });
    const body = new ReadableStream({
      async start(controller) {
        controller.enqueue(
          Buffer.concat([
            packet(`${head} ${next} refs/heads/main\0report-status\n`),
            Buffer.from("0000"),
            pack.subarray(0, 12),
          ]),
        );
        await held;
        controller.enqueue(pack.subarray(12));
        controller.close();
      },
    });
    const sending = fetch(url + "/git-receive-pack", {
      method: "POST",
      duplex: "half",
      body,
      headers: {
        Authorization: "Bearer " + credential.token,
        "content-type": "application/x-git-receive-pack-request",
      },
      signal: AbortSignal.timeout(120000),
    }).then(async (response) => ({
      status: response.status,
      text: await response.text(),
    }));
    sending.catch(() => {});
    let archiving,
      result,
      archived = false;
    try {
      await new Promise((r) => setTimeout(r, 500));
      await snapshotPage(head, "upload");
      const anonymous = await fetch(
        origin + `/api/repos/${name}/project/browse`,
        { signal: AbortSignal.timeout(12000) },
      );
      assert.ok(
        [401, 404].includes(anonymous.status),
        "snapshot lane does not bypass outer authorization",
      );
      checks++;
      archiving = api(`/repos/${name}/project/lifecycle`, "PUT", {
        archived: true,
        revision: beforeLifecycle.lifecycle_revision,
      }).then((value) => {
        archived = true;
        return value;
      });
      archiving.catch(() => {});
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(
        archived,
        false,
        "archive waits for Git publication and active snapshots",
      );
      checks++;
    } finally {
      release();
      result = await sending;
    }
    assert.equal(result.status, 200);
    assert.match(result.text, /unpack ok/);
    assert.match(result.text, /ok refs\/heads\/main/);
    checks++;
    const archivedState = archiving ? (await archiving).data : null;
    const current = (await api(`/repos/${name}/project/browse`)).data;
    assert.equal(current.data.ref, next);
    await api(`/repos/${name}/project/lifecycle`, "PUT", {
      archived: false,
      revision: archivedState.lifecycle_revision,
    });
  } else await git(["-C", "source", "push", "origin", "main"]);
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
  if (cacheAcceptance) {
    const next = await git(["-C", "source", "rev-parse", "HEAD"]);
    for (const name of ["changed-cold.git", "changed-warm.git"]) {
      await git(["-c", "protocol.version=2", "clone", "--bare", url, name]);
      await git(["--git-dir=" + name, "fsck", "--full", "--strict"]);
      assert.equal(await git(["--git-dir=" + name, "rev-parse", "main"]), next);
    }
  }
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
      uncompressedPayload: payloadBytes,
      singleInitialPush: singleImport && !readConcurrency,
      seededImport: readConcurrency,
      cacheAcceptance,
      readConcurrency,
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
