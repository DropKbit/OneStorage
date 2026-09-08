// Run under a dedicated account on a host trusted to execute this repository's code.
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  realpath,
  stat,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, sep } from "node:path";
import { spawn } from "node:child_process";
import { extract } from "tar";
const origin = process.env.ONESTORAGE_ORIGIN?.replace(/\/$/, ""),
  tokenFile = process.env.ONESTORAGE_RUNNER_TOKEN_FILE;
if (!origin || !tokenFile)
  throw Error("Set ONESTORAGE_ORIGIN and ONESTORAGE_RUNNER_TOKEN_FILE");
const url = new URL(origin);
if (
  url.protocol !== "https:" &&
  !["localhost", "127.0.0.1"].includes(url.hostname)
)
  throw Error("Runner origin must use HTTPS");
const token = (await readFile(tokenFile, "utf8")).trim();
const allowedEnv = (process.env.ONESTORAGE_JOB_ENV || "")
  .split(",")
  .filter(Boolean);
const secretValues = [
  token,
  ...allowedEnv.map((k) => process.env[k]).filter((v) => v && v.length >= 4),
].sort((a, b) => b.length - a.length);
const redact = (s) =>
  secretValues.reduce((t, v) => t.split(v).join("[REDACTED]"), s);
async function request(path, body, lease, options = {}) {
  const response = await fetch(origin + "/api/runner" + path, {
    method: body === undefined ? "GET" : "POST",
    ...options,
    redirect: "error",
    headers: {
      Authorization: "Bearer " + token,
      ...(lease ? { "X-Run-Lease": lease } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
    body: body === undefined ? options.body : JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok)
    throw Error(
      "Runner API " +
        response.status +
        ": " +
        (await response.text()).slice(0, 200),
    );
  return response;
}
let stop = false;
process.on("SIGINT", () => {
  stop = true;
});
process.on("SIGTERM", () => {
  stop = true;
});
async function execute(run, lease) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "onestorage-ci-"))),
    work = join(dir, "work"),
    home = join(dir, "home");
  await mkdir(work);
  await mkdir(home);
  const base = "/runs/" + run.id,
    deadline = Date.now() + run.config.timeout_seconds * 1000;
  let seq = 0,
    child = null,
    stopped = false,
    heartbeatBusy = false,
    pending = Promise.resolve(),
    logTail = "";
  const sendLog = (text) => {
    if (seq >= 255) return;
    const n = seq++;
    pending = pending.then(() =>
      request(
        base + "/logs",
        { seq: n, content: redact(text).slice(0, 4096) },
        lease,
      ),
    );
    pending.catch(() => {});
  };
  // Keep the longest secret across chunk boundaries before redaction.
  const retain = Math.max(512, ...secretValues.map((s) => s.length));
  function output(chunk, flush = false) {
    logTail += chunk;
    let safe = flush ? logTail.length : Math.max(0, logTail.length - retain);
    for (const v of secretValues) {
      let at = logTail.indexOf(v);
      while (at >= 0) {
        if (at < safe && at + v.length > safe) safe = at;
        at = logTail.indexOf(v, at + 1);
      }
    }
    if (safe) {
      const text = redact(logTail.slice(0, safe));
      for (let i = 0; i < text.length; i += 4000)
        sendLog(text.slice(i, i + 4000));
      logTail = logTail.slice(safe);
    }
  }
  const kill = () => {
    stopped = true;
    if (child) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  };
  const timer = setInterval(async () => {
    if (stop || Date.now() > deadline) {
      kill();
      return;
    }
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    try {
      await request(base + "/heartbeat", {}, lease);
    } catch {
      kill();
    } finally {
      heartbeatBusy = false;
    }
  }, 15000);
  const env = {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: home,
    CI: "true",
    ONESTORAGE_COMMIT_SHA: run.sha,
    ONESTORAGE_REF: run.ref,
  };
  for (const key of allowedEnv)
    if (process.env[key] !== undefined && !key.startsWith("ONESTORAGE_"))
      env[key] = process.env[key];
  try {
    sendLog("Checking out " + run.sha + "\n");
    const source = await request(base + "/source", undefined, lease);
    if (source.headers.get("x-git-commit") !== run.sha)
      throw Error("Source commit mismatch");
    const reader = source.body.getReader(),
      chunks = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 128 * 1024 * 1024) {
        await reader.cancel();
        throw Error("Source archive exceeds 128 MiB");
      }
      chunks.push(value);
    }
    const archive = join(dir, "source.tar.gz");
    await writeFile(archive, Buffer.concat(chunks));
    let extracted = 0;
    await extract({
      file: archive,
      cwd: work,
      strict: true,
      preservePaths: false,
      filter: (path, entry) => {
        if (
          ![
            "File",
            "Directory",
            "ExtendedHeader",
            "GlobalExtendedHeader",
          ].includes(entry.type)
        )
          throw Error("Runner source archives must not contain links/devices");
        if (
          path.startsWith("/") ||
          path.includes("\\") ||
          path.split("/").includes("..")
        )
          throw Error("Unsafe source path");
        extracted += entry.size;
        if (extracted > 256 * 1024 * 1024)
          throw Error("Expanded source exceeds 256 MiB");
        return true;
      },
    });
    for (const step of run.config.steps) {
      if (stopped || stop || Date.now() > deadline)
        throw Error("Run canceled or timed out");
      if (step.type === "run") {
        sendLog("\n> " + step.name + "\n");
        await new Promise((ok, bad) => {
          child = spawn("/bin/sh", ["-eu", "-c", step.command], {
            cwd: work,
            env,
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
          });
          child.stdout.on("data", (b) => output(b.toString()));
          child.stderr.on("data", (b) => output(b.toString()));
          child.on("error", bad);
          child.on("exit", (code) => {
            child = null;
            output("", true);
            code === 0
              ? ok()
              : bad(
                  Error("Step failed: " + step.name + " (exit " + code + ")"),
                );
          });
        });
      } else if (step.type === "file") {
        const target = await realpath(resolve(work, step.path));
        if (!target.startsWith(work + sep))
          throw Error("Path escapes checkout");
        const data = await readFile(target, "utf8");
        if (step.format === "json") JSON.parse(data);
        sendLog("PASS " + step.path + "\n");
      } else if (step.type === "http") {
        const r = await fetch(step.url, {
          redirect: "error",
          signal: AbortSignal.timeout(10000),
        });
        await r.body?.cancel();
        if (r.status !== step.status) throw Error("HTTP check failed");
        sendLog("PASS HTTP " + new URL(step.url).hostname + "\n");
      }
    }
    for (const path of run.config.artifacts) {
      const target = await realpath(resolve(work, path));
      if (!target.startsWith(work + sep))
        throw Error("Artifact escapes checkout");
      const info = await stat(target);
      if (!info.isFile() || info.size > 16 * 1024 * 1024)
        throw Error("Artifact must be a file up to 16 MiB");
      await request(
        base + "/artifacts/" + encodeURIComponent(path),
        undefined,
        lease,
        {
          method: "PUT",
          headers: { "content-type": "application/octet-stream" },
          body: await readFile(target),
        },
      );
      sendLog("Artifact: " + path + "\n");
    }
    if (stopped || stop) throw Error("Run canceled");
    await pending;
    await request(base + "/complete", { status: "succeeded" }, lease);
    console.log(run.id + " succeeded");
  } catch (e) {
    kill();
    output("", true);
    sendLog("FAIL " + e.message + "\n");
    try {
      await pending;
      await request(
        base + "/complete",
        { status: "failed", error: redact(e.message).slice(0, 1000) },
        lease,
      );
    } catch {}
    console.error(run.id + " failed: " + redact(e.message));
  } finally {
    clearInterval(timer);
    kill();
    await rm(dir, { recursive: true, force: true });
  }
}
while (!stop) {
  try {
    const { run, lease } = await (await request("/claim", {})).json();
    if (run) await execute(run, lease);
    else if (process.env.ONESTORAGE_RUNNER_ONCE === "1") break;
  } catch (e) {
    console.error(redact(e.message));
    if (process.env.ONESTORAGE_RUNNER_ONCE === "1") process.exitCode = 1;
  }
  if (process.env.ONESTORAGE_RUNNER_ONCE === "1") break;
  await new Promise((r) => setTimeout(r, 5000));
}
