import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const origin = process.env.TEST_ORIGIN || "http://localhost:8787";
const remote = !["localhost", "127.0.0.1"].includes(new URL(origin).hostname);
if (remote && process.env.ALLOW_REMOTE_ACCEPTANCE !== "1")
  throw Error("Remote acceptance requires opt-in");
const token = process.env.ONESTORAGE_TOKEN_FILE
  ? (await readFile(process.env.ONESTORAGE_TOKEN_FILE, "utf8")).trim()
  : "";
let cookie = "",
  requests = 0,
  checks = 0,
  repo,
  created = false;
const name = "schedule_" + crypto.randomUUID().slice(0, 8),
  ap = "/api/repos/" + name + "/project";
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
  const raw = await r.text();
  assert.equal(
    r.status,
    status,
    method + " " + path + ": " + raw.slice(0, 500),
  );
  requests++;
  if (path === "/api/login")
    cookie = r.headers.get("set-cookie")?.split(";")[0] || "";
  return raw ? JSON.parse(raw) : null;
}
const check = (v, m) => {
  assert.ok(v, m);
  checks++;
};
const edit = (s) => ({
  name: s.name,
  ref: s.ref,
  cron: s.cron,
  timezone: s.timezone,
  enabled: !!s.enabled,
  revision: s.revision,
});
try {
  if (!token)
    await api("/api/login", "POST", {
      username: "owner",
      password: process.env.TEST_ADMIN_PASSWORD || "local-test-password-123",
    });
  await api(
    "/api/workspaces",
    "POST",
    { slug: name, name: "Scheduled CI acceptance" },
    201,
  );
  created = true;
  repo = await api(
    "/api/repos",
    "POST",
    { namespace: name, name: "project", visibility: "private" },
    201,
  );
  const config = {
    name: "Scheduled cloud workflow",
    runner: "workflow",
    jobs: [
      {
        id: "build",
        pipeline: {
          runner: "worker",
          steps: [{ type: "javascript", entry: "ci.js", files: ["ci.js"] }],
        },
      },
      {
        id: "verify",
        needs: ["build"],
        pipeline: {
          runner: "worker",
          steps: [
            { type: "javascript", entry: "verify.js", files: ["verify.js"] },
          ],
        },
      },
    ],
  };
  const committed = await api(
    ap + "/commit-files",
    "POST",
    {
      target_branch: "main",
      commit_message: "Scheduled CI fixture",
      files: Object.entries({
        ".onestorage-ci.json": JSON.stringify(config),
        "README.md": "Scheduled CI\n",
        "ci.js":
          'export default async ({sha}) => ({artifacts:{"result.txt":sha}});',
        "verify.js":
          'export default async ({sha,dependencies}) => {if(dependencies.build["result.txt"].content!==sha)throw Error("wrong dependency SHA");return {artifacts:{"verified.txt":sha}};};',
      }).map(([path, content]) => ({ path, content })),
    },
    201,
  );
  await api(ap + "/ci/config", "PUT", {
    source_path: ".onestorage-ci.json",
    enabled: false,
  });
  await api(
    ap + "/ci/schedules",
    "POST",
    {
      name: "Invalid zone",
      ref: "main",
      cron: "* * * * *",
      timezone: "Invalid/Zone",
    },
    400,
  );
  const base = {
    name: "Scheduled build",
    ref: "main",
    cron: "* * * * *",
    timezone: "Asia/Singapore",
    enabled: true,
  };
  let schedule = await api(ap + "/ci/schedules", "POST", base, 201);
  check(schedule.next_run_at > Date.now() - 1000, "next run computed");
  const bad = await api(
    ap + "/ci/schedules",
    "POST",
    { ...base, name: "Missing branch", ref: "missing" },
    201,
  );
  const named = await api(
    ap + "/ci/schedules",
    "POST",
    { ...base, name: "Named weekday", cron: "0 9 * * THU", enabled: false },
    201,
  );
  check(
    named.cron === "0 9 * * THU" && !named.enabled,
    "deterministic named weekday accepted",
  );
  const paused = await api(
    ap + "/ci/schedules",
    "POST",
    { ...base, name: "Paused", enabled: false },
    201,
  );
  await api(
    ap + "/ci/schedules/" + schedule.id,
    "PUT",
    { ...base, revision: 99 },
    409,
  );
  console.log(
    JSON.stringify({
      stage: "waiting-for-cloudflare-cron",
      repoId: repo.id,
      name,
      schedule: schedule.id,
      next: schedule.next_run_at,
      remote,
    }),
  );
  if (!remote) {
    const r = await fetch(
      origin +
        "/cdn-cgi/local/scheduled?time=" +
        (schedule.next_run_at + 300000),
      { signal: AbortSignal.timeout(120000) },
    );
    // The application intentionally uses wall time, so first let the due minute arrive.
    assert.ok(r.ok);
  }
  let run, list;
  for (let n = 0; n < 540; n++) {
    if (!remote && n % 10 === 0) {
      const r = await fetch(origin + "/cdn-cgi/local/scheduled", {
        signal: AbortSignal.timeout(120000),
      });
      assert.ok(r.ok);
    }
    list = (await api(ap + "/ci/schedules")).schedules;
    const current = list.find((s) => s.id === schedule.id);
    if (current.last_run_id) {
      run = await api(ap + "/ci/runs/" + current.last_run_id);
      if (["failed", "canceled"].includes(run.status))
        throw Error(
          "Scheduled cloud workflow: " + run.status + " " + run.error,
        );
      if (
        run.status === "succeeded" &&
        list.find((s) => s.id === bad.id).last_error
      )
        break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  check(
    run?.status === "succeeded",
    "real Cron -> D1 -> Queue -> cloud workflow succeeds",
  );
  check(run.trigger === "schedule", "scheduled trigger recorded");
  check(run.sha === committed.sha, "fixed code SHA");
  check(run.config_sha === committed.sha, "fixed configuration SHA");
  check(run.config_path === ".onestorage-ci.json", "versioned source path");
  check(
    run.jobs.length === 2 && run.jobs.every((j) => j.status === "succeeded"),
    "both dependent tasks succeed",
  );
  check(
    !list.find((s) => s.id === paused.id).last_run_id,
    "paused schedule did not run",
  );
  check(
    /branch/.test(list.find((s) => s.id === bad.id).last_error),
    "missing branch visible",
  );
  schedule = await api(ap + "/ci/schedules/" + schedule.id, "PUT", {
    ...edit(list.find((s) => s.id === schedule.id)),
    enabled: false,
  });
  const before = (await api(ap + "/ci/runs")).runs.filter(
    (r) => r.trigger === "schedule",
  ).length;
  const anonymous = await fetch(origin + ap + "/ci/schedules");
  check(
    [401, 404].includes(anonymous.status),
    "private schedule requires auth",
  );
  await anonymous.body?.cancel();
  await api(ap + "/ci/schedules/" + schedule.id + "/take-ownership", "POST", {
    revision: schedule.revision,
  });
  const taken = (await api(ap + "/ci/schedules")).schedules.find(
    (s) => s.id === schedule.id,
  );
  check(
    !taken.enabled && taken.revision === schedule.revision + 1,
    "takeover paused and versioned",
  );
  await api(ap + "/ci/schedules/" + taken.id, "DELETE", {
    revision: taken.revision,
  });
  const history = await api(ap + "/ci/runs/" + run.id);
  check(history.status === "succeeded", "deleting schedule keeps run history");
  check(
    (await api(ap + "/ci/runs")).runs.filter((r) => r.trigger === "schedule")
      .length === before,
    "management did not create extra runs",
  );
  console.log(
    JSON.stringify({
      checks,
      requests,
      repoId: repo.id,
      name,
      run: run.id,
      sha: run.sha,
      config_sha: run.config_sha,
      realCron: remote
        ? "Cloudflare scheduled event"
        : "Miniflare scheduled event",
      result: "scheduled isolated JS DAG and dependency artifacts passed",
    }),
  );
} finally {
  if (repo) await api("/api/admin/repositories/" + repo.id, "DELETE");
  if (created) {
    let removed = false;
    for (let n = 0; n < 240; n++) {
      const r = await fetch(origin + "/api/workspaces/" + name, {
        method: "DELETE",
        headers: {
          Origin: origin,
          ...(token
            ? { Authorization: "Bearer " + token }
            : { Cookie: cookie }),
        },
        signal: AbortSignal.timeout(30000),
      });
      await r.body?.cancel();
      if (r.status === 200) {
        removed = true;
        break;
      }
      assert.equal(r.status, 409);
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert.ok(removed, "fixture GC finished");
  }
  console.log(
    JSON.stringify({
      cleanup: "repository, schedules, and workspace removed",
      name,
    }),
  );
}
