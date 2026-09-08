import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support/review-fixture";
import {
  nextSchedule,
  scheduleSchema,
  publishSchedules,
  consumeSchedule,
  registerScheduleRoutes,
} from "../src/ci-schedules";
import { consumeCI, claimRun } from "../src/ci";
import { saveCloudOutput } from "../src/cloud-ci";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
const config = {
  runner: "worker",
  steps: [{ type: "file", path: "package.json", format: "json" }],
};
const now = Date.parse("2026-09-08T00:00:00Z");
function setup() {
  const f = fixture(),
    messages: string[] = [],
    reads: string[] = [];
  f.db
    .prepare("INSERT INTO ci_pipelines(repo_id,config,enabled) VALUES('r',?,0)")
    .run(JSON.stringify(config));
  f.db
    .prepare(
      "INSERT INTO ci_schedules(id,repo_id,owner_id,name,ref,cron,timezone,next_run_at) VALUES('schedule','r','o','Nightly','main','*/5 * * * *','UTC',?)",
    )
    .run(now);
  f.env.EVENTS = {
    send: async (m: any) => {
      messages.push(m.id);
    },
  } as any;
  let sha = "a".repeat(40),
    body = JSON.stringify(config),
    onRead = async () => {};
  f.env.REPOSITORIES = {
    idFromName: (id: string) => id,
    get: () => ({
      fetch: async (req: Request) => {
        reads.push(req.url);
        await onRead();
        if (new URL(req.url).pathname === "/branch")
          return Response.json({ sha });
        if (new URL(req.url).pathname === "/file") return new Response(body);
        return Response.json({ binary: false, content: '{"ok":true}' });
      },
    }),
  } as any;
  f.env.OBJECTS.delete = (async (key: string) => {
    f.objects.delete(key);
  }) as any;
  const ticks = () =>
    f.db.prepare("SELECT * FROM ci_schedule_ticks ORDER BY rowid").all();
  const runs = () => f.db.prepare("SELECT * FROM ci_runs ORDER BY rowid").all();
  const schedule = () =>
    f.db.prepare("SELECT * FROM ci_schedules WHERE id='schedule'").get()!;
  return {
    ...f,
    messages,
    reads,
    ticks,
    runs,
    schedule,
    setSha: (x: string) => {
      sha = x;
    },
    setBody: (x: string) => {
      body = x;
    },
    setRead: (x: () => Promise<void>) => {
      onRead = x;
    },
  };
}
test("cron validates five fields and IANA zones, weekday conventions, leap day and DST", () => {
  assert.equal(
    nextSchedule("0 9 * * 1-5", "Asia/Singapore", now),
    now + 3600000,
  );
  assert.equal(
    new Date(nextSchedule("0 0 29 2 *", "UTC", now)).toISOString(),
    "2028-02-29T00:00:00.000Z",
  );
  assert.equal(
    nextSchedule("0 0 * * 0", "UTC", now),
    nextSchedule("0 0 * * 7", "UTC", now),
  );
  const a = nextSchedule(
    "0 9 * * *",
    "America/New_York",
    Date.parse("2026-03-07T15:00:00Z"),
  );
  assert.equal(new Date(a).toISOString(), "2026-03-08T13:00:00.000Z");
  assert.equal(
    new Date(nextSchedule("0 9 * * THU", "UTC", now)).toISOString(),
    "2026-09-10T09:00:00.000Z",
  );
  for (const [cron, timezone] of [
    ["* * * * * *", "UTC"],
    ["* * * * *", "Mars/Olympus"],
    ["61 * * * *", "UTC"],
    ["H * * * *", "UTC"],
    ["h/5 * * * *", "UTC"],
    ["0 0 31 2 *", "UTC"],
  ])
    assert.equal(
      scheduleSchema.safeParse({ name: "x", ref: "main", cron, timezone })
        .success,
      false,
    );
});
test("duplicate schedulers and queue consumers produce one run; missed slots coalesce and push toggle is independent", async () => {
  const f = setup();
  await publishSchedules(f.env, now + 3600000);
  await publishSchedules(f.env, now + 3600000);
  assert.equal(f.ticks().length, 1);
  assert.equal(f.schedule().next_run_at, now + 3900000);
  const id = f.ticks()[0].id as string;
  await Promise.all([consumeSchedule(f.env, id), consumeSchedule(f.env, id)]);
  assert.equal(f.runs().length, 1);
  assert.equal(f.runs()[0].sha, "a".repeat(40));
  assert.equal(f.runs()[0].trigger, "schedule");
  assert.equal(f.runs()[0].actor_id, "o");
  assert.equal(f.ticks()[0].state, "done");
  await consumeCI(f.env, f.runs()[0].id as string);
  assert.equal(f.runs()[0].status, "succeeded");
});
test("queue failure keeps durable occurrence; 20-run backpressure retries the frozen code/config instead of newer branch", async () => {
  const f = setup();
  f.db.exec(
    "UPDATE ci_pipelines SET config='null',source_path='.onestorage-ci.json'",
  );
  f.env.EVENTS = {
    send: async () => {
      throw Error("queue unavailable");
    },
  } as any;
  await publishSchedules(f.env, now);
  assert.equal(f.ticks().length, 1);
  for (let n = 0; n < 20; n++)
    f.db
      .prepare(
        "INSERT INTO ci_runs(id,repo_id,ref,sha,config,trigger,status) VALUES(?,'r','main','sha',?,'manual','queued')",
      )
      .run("busy" + n, JSON.stringify(config));
  const id = f.ticks()[0].id as string;
  await assert.rejects(consumeSchedule(f.env, id), /20 active/);
  assert.equal(f.ticks()[0].sha, "a".repeat(40));
  assert.equal(f.ticks()[0].config_sha, "a".repeat(40));
  f.setSha("b".repeat(40));
  f.setBody("{invalid");
  f.db.exec("UPDATE ci_runs SET status='canceled'");
  await consumeSchedule(f.env, id);
  const r = f.runs().at(-1)!;
  assert.equal(r.sha, "a".repeat(40));
  assert.equal(r.config_sha, "a".repeat(40));
  assert.equal(r.status, "queued");
});
test("invalid versioned config creates visible failed run; missing branch fails occurrence without poisoning later schedules", async () => {
  const f = setup();
  f.db.exec(
    "UPDATE ci_pipelines SET config='null',source_path='.onestorage-ci.json'",
  );
  f.setBody("{bad");
  await publishSchedules(f.env, now);
  await consumeSchedule(f.env, f.ticks()[0].id as string);
  assert.equal(f.runs()[0].status, "failed");
  assert.ok(f.runs()[0].config_error);
  assert.ok(f.schedule().last_error);
  f.env.REPOSITORIES = {
    idFromName: (x: string) => x,
    get: () => ({
      fetch: async () => new Response("missing", { status: 404 }),
    }),
  } as any;
  await publishSchedules(f.env, now + 300000);
  await consumeSchedule(f.env, f.ticks()[1].id as string);
  assert.equal(f.ticks()[1].state, "failed");
  assert.equal(f.runs().length, 1);
  assert.match(f.schedule().last_error as string, /branch/);
});
test("disable/edit/delete, owner disable, membership revocation, archive and transfer stop dispatched work and reject late output", async () => {
  for (const mode of [
    "pause",
    "edit",
    "delete",
    "disabled",
    "member",
    "workspace",
    "archive",
    "transfer",
  ]) {
    const f = setup();
    if (mode === "member") {
      f.db.exec(
        "UPDATE members SET role='maintainer' WHERE user_id='a';UPDATE ci_schedules SET owner_id='a'",
      );
    }
    if (mode === "workspace") {
      f.db.exec(
        "INSERT INTO workspaces(id,slug,name) VALUES('w','team','Team');INSERT INTO workspace_members VALUES('w','o','owner'),('w','a','maintainer');UPDATE repositories SET workspace_id='w',namespace='team' WHERE id='r';UPDATE ci_schedules SET owner_id='a',enabled=1",
      );
    }
    await publishSchedules(f.env, now);
    await consumeSchedule(f.env, f.ticks()[0].id as string);
    const id = f.runs()[0].id as string,
      claim = await claimRun(f.env, "r", "worker", "worker", id);
    assert.ok(claim);
    if (mode === "pause") f.db.exec("UPDATE ci_schedules SET enabled=0");
    if (mode === "edit")
      f.db.exec("UPDATE ci_schedules SET revision=revision+1");
    if (mode === "delete") f.db.exec("DELETE FROM ci_schedules");
    if (mode === "disabled")
      f.db.exec("UPDATE users SET disabled=1 WHERE id='o'");
    if (mode === "member")
      f.db.exec("UPDATE members SET role='reader' WHERE user_id='a'");
    if (mode === "workspace")
      f.db.exec("DELETE FROM workspace_members WHERE user_id='a'");
    if (mode === "archive")
      f.db.exec(
        "UPDATE repositories SET archived_at=datetime('now') WHERE id='r'",
      );
    if (mode === "transfer")
      f.db.exec("UPDATE repositories SET namespace='moved' WHERE id='r'");
    assert.equal(f.runs()[0].status, "canceled", mode);
    assert.equal(f.runs()[0].lease_hash, null, mode);
    await saveCloudOutput(f.env, f.repo, claim!.run, {
      "late.txt": { content: "must not publish" },
    });
    assert.equal(f.objects.size, 0, mode);
  }
});
test("inherited alternative maintenance rights keep schedule valid, while revoked owner cannot publish after config read", async () => {
  const f = setup();
  f.db.exec(
    "UPDATE members SET role='maintainer' WHERE user_id='a';UPDATE ci_schedules SET owner_id='a'",
  );
  await publishSchedules(f.env, now);
  f.setRead(async () => {
    f.db.exec("UPDATE members SET role='reader' WHERE user_id='a'");
  });
  await consumeSchedule(f.env, f.ticks()[0].id as string);
  assert.equal(f.runs().length, 0);
  assert.equal(f.ticks()[0].state, "canceled");
  const g = setup();
  g.db.exec(
    "INSERT INTO workspaces(id,slug,name) VALUES('w','team','Team');INSERT INTO workspace_members VALUES('w','o','owner'),('w','a','maintainer');UPDATE repositories SET workspace_id='w' WHERE id='r';UPDATE members SET role='maintainer' WHERE user_id='a';UPDATE ci_schedules SET owner_id='a',enabled=1;DELETE FROM workspace_members WHERE user_id='a'",
  );
  assert.equal(g.schedule().enabled, 1);
});
test("parent workflow cancellation caused by schedule revocation cancels all descendants", async () => {
  const f = setup();
  f.db.prepare("UPDATE ci_pipelines SET config=?").run(
    JSON.stringify({
      runner: "workflow",
      jobs: [
        { id: "build", pipeline: config },
        { id: "next", needs: ["build"], pipeline: config },
      ],
    }),
  );
  await publishSchedules(f.env, now);
  await consumeSchedule(f.env, f.ticks()[0].id as string);
  await consumeCI(f.env, f.runs()[0].id as string);
  assert.equal(f.runs().length, 2);
  f.db.exec("UPDATE ci_schedules SET enabled=0");
  assert.ok(f.runs().every((r) => r.status === "canceled"));
});
test("schedule routes enforce revisions, project identity, authority at mutation time and explicit ownership takeover", async () => {
  const f = setup(),
    app = new Hono<any>();
  let user = "o";
  app.use("*", async (c, next) => {
    c.set("user", { id: user, username: user, admin: 0 });
    await next();
  });
  app.onError((e, c) =>
    e instanceof HTTPException
      ? c.json({ error: e.message }, e.status)
      : c.json({ error: e.message }, 400),
  );
  registerScheduleRoutes(app, {
    access: async () => f.repo,
    audit: async () => {},
  });
  const base = "/api/repos/owner/repo/ci/schedules";
  const request = (path: string, method: string, data?: unknown) =>
    app.request(
      "http://test" + base + path,
      {
        method,
        headers: { "content-type": "application/json" },
        body: data === undefined ? undefined : JSON.stringify(data),
      },
      f.env,
    );
  const data = {
    name: "Daily",
    ref: "main",
    cron: "0 9 * * *",
    timezone: "Asia/Singapore",
    enabled: true,
  };
  let r = await request("", "POST", data);
  assert.equal(r.status, 201);
  const s = (await r.json()) as { id: string };
  assert.equal(
    (await request("/" + s.id, "PUT", { ...data, revision: 4 })).status,
    409,
  );
  assert.equal(
    (await request("/" + s.id, "PUT", { ...data, revision: 0 })).status,
    200,
  );
  user = "g";
  assert.equal((await request("", "POST", data)).status, 409);
  user = "a";
  f.db.exec("UPDATE members SET role='maintainer' WHERE user_id='a'");
  assert.equal(
    (await request("/" + s.id + "/take-ownership", "POST", { revision: 1 }))
      .status,
    200,
  );
  const row = f.db.prepare("SELECT * FROM ci_schedules WHERE id=?").get(s.id)!;
  assert.equal(row.owner_id, "a");
  assert.equal(row.enabled, 0);
  assert.equal(
    (await request("/" + s.id, "DELETE", { revision: 2 })).status,
    200,
  );
  f.db.exec(
    "INSERT INTO ci_schedules(id,repo_id,owner_id,name,ref,cron,next_run_at) VALUES('other-schedule','other','o','x','main','0 * * * *',0)",
  );
  assert.equal(
    (await request("/other-schedule", "DELETE", { revision: 0 })).status,
    409,
  );
});
