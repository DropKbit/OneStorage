import { CronExpressionParser } from "cron-parser/dist/CronExpressionParser";
import { z } from "zod";
import type { Hono, Context } from "hono";
import type { App, Env, Repo } from "./types";
import { branch, fail } from "./security";
import { identity, jsonInput } from "./workspaces";
import { enqueueRun } from "./ci";
import { resolvePipeline, type SavedPipeline } from "./ci-source";
import { executionSchema, pipelineSchema } from "./ci-config";

export function nextSchedule(cron: string, timezone: string, after: number) {
  if (cron.trim().split(/\s+/).length !== 5 || /\bH\b|\?/i.test(cron))
    throw Error(
      "Use a five-field cron expression without random or placeholder fields",
    );
  new Intl.DateTimeFormat("en", { timeZone: timezone });
  return CronExpressionParser.parse(cron, { tz: timezone, currentDate: after })
    .next()
    .getTime();
}
export const scheduleSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    ref: branch,
    cron: z.string().trim().min(1).max(100),
    timezone: z.string().trim().min(1).max(80).default("UTC"),
    enabled: z.boolean().default(true),
  })
  .strict()
  .superRefine((s, c) => {
    try {
      nextSchedule(s.cron, s.timezone, Date.now());
    } catch {
      c.addIssue({
        code: "custom",
        message: "Invalid cron expression or IANA timezone",
      });
    }
  });
interface Schedule {
  id: string;
  repo_id: string;
  owner_id: string;
  name: string;
  ref: string;
  cron: string;
  timezone: string;
  enabled: number;
  revision: number;
  next_run_at: number;
}
interface Tick {
  id: string;
  schedule_id: string;
  revision: number;
  scheduled_for: number;
  state: string;
  sha: string | null;
  config: string | null;
  config_path: string | null;
  config_sha: string | null;
  error: string | null;
}
export const activeTick = `SELECT t.id FROM ci_schedule_ticks t JOIN ci_authorized_schedules s ON s.id=t.schedule_id WHERE t.state='pending' AND s.enabled=1 AND s.revision=t.revision`;
async function send(env: Env, id: string) {
  try {
    await env.EVENTS?.send({ id: "ci-schedule:" + id });
  } catch {
    /* D1 outbox retries. */
  }
}
/** One durable occurrence per due schedule; outages coalesce, never replay every missed minute. */
export async function publishSchedules(env: Env, now = Date.now()) {
  const due = await env.DB.prepare(
    `SELECT * FROM ci_authorized_schedules s WHERE enabled=1 AND next_run_at<=? AND NOT EXISTS(SELECT 1 FROM ci_schedule_ticks t WHERE t.schedule_id=s.id AND t.state='pending') ORDER BY next_run_at,id LIMIT 50`,
  )
    .bind(now)
    .all<Schedule>();
  for (const s of due.results) {
    const id = crypto.randomUUID(),
      next = nextSchedule(s.cron, s.timezone, now);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO ci_schedule_ticks(id,schedule_id,revision,scheduled_for) SELECT ?,id,revision,next_run_at FROM ci_authorized_schedules WHERE id=? AND enabled=1 AND revision=? AND next_run_at=? AND NOT EXISTS(SELECT 1 FROM ci_schedule_ticks WHERE schedule_id=? AND state='pending')`,
      ).bind(id, s.id, s.revision, s.next_run_at, s.id),
      env.DB.prepare(
        `UPDATE ci_schedules SET next_run_at=? WHERE id=? AND revision=? AND next_run_at=? AND EXISTS(SELECT 1 FROM ci_schedule_ticks WHERE id=?)`,
      ).bind(next, s.id, s.revision, s.next_run_at, id),
    ]);
  }
  const pending = await env.DB.prepare(
    `SELECT id FROM ci_schedule_ticks WHERE state='pending' ORDER BY created_at,id LIMIT 100`,
  ).all<{ id: string }>();
  for (const row of pending.results) await send(env, row.id);
  // Run/config history is retained in ci_runs. Completed dispatch bookkeeping expires after 30 days.
  await env.DB.prepare(
    "DELETE FROM ci_schedule_ticks WHERE state!='pending' AND created_at<datetime('now','-30 days') AND NOT EXISTS(SELECT 1 FROM ci_runs r WHERE r.schedule_tick_id=ci_schedule_ticks.id )",
  ).run();
}
async function failTick(env: Env, tick: Tick, error: string) {
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE ci_schedule_ticks SET state='failed',error=? WHERE id=? AND state='pending'",
    ).bind(error, tick.id),
    env.DB.prepare(
      "UPDATE ci_schedules SET last_error=? WHERE id=? AND revision=?",
    ).bind(error, tick.schedule_id, tick.revision),
  ]);
}
export async function consumeSchedule(env: Env, id: string) {
  let tick = await env.DB.prepare(
    "SELECT * FROM ci_schedule_ticks WHERE id=? AND state='pending'",
  )
    .bind(id)
    .first<Tick>();
  if (!tick) return;
  const schedule = await env.DB.prepare(
    "SELECT * FROM ci_authorized_schedules WHERE id=? AND enabled=1 AND revision=?",
  )
    .bind(tick.schedule_id, tick.revision)
    .first<Schedule>();
  if (!schedule) {
    await env.DB.prepare(
      "UPDATE ci_schedule_ticks SET state='canceled',error='Schedule no longer authorized' WHERE id=? AND state='pending'",
    )
      .bind(id)
      .run();
    return;
  }
  const repo = await env.DB.prepare(
    "SELECT r.*,p.config,p.source_path FROM repositories r LEFT JOIN ci_pipelines p ON p.repo_id=r.id WHERE r.id=?",
  )
    .bind(schedule.repo_id)
    .first<Repo & SavedPipeline>();
  if (!repo?.config)
    return failTick(
      env,
      tick,
      "Save a pipeline configuration before scheduled execution",
    );
  if (!tick.sha) {
    const response = await env.REPOSITORIES.get(
      env.REPOSITORIES.idFromName(repo.id),
    ).fetch(
      new Request(
        "http://repository/branch?branch=" + encodeURIComponent(schedule.ref),
        {
          headers: {
            "x-repo-id": repo.id,
            "x-default-branch": repo.default_branch,
            "x-lifecycle-revision": String(repo.lifecycle_revision || 0),
          },
        },
      ),
    );
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404)
        return failTick(env, tick, "Scheduled branch not found");
      throw Error("Scheduled branch temporarily unavailable");
    }
    const { sha } = (await response.json()) as { sha: string };
    if (!/^[a-f0-9]{40}$/.test(sha))
      throw Error("Invalid scheduled branch response");
    let loaded;
    try {
      loaded = await resolvePipeline(env, repo, repo, sha);
    } catch {
      loaded = {
        config: executionSchema.parse({
          name: "Invalid scheduled pipeline",
          runner: "worker",
          steps: [
            { type: "file", path: repo.source_path || ".onestorage-ci.json" },
          ],
        }),
        config_path: repo.source_path || null,
        config_sha: repo.source_path ? sha : null,
        error:
          "Scheduled pipeline configuration could not be loaded or validated",
      };
    }
    // A concurrent consumer may resolve a newer branch. Only the first complete snapshot wins.
    await env.DB.prepare(
      `UPDATE ci_schedule_ticks SET sha=?,config=?,config_path=?,config_sha=?,error=? WHERE id=? AND sha IS NULL AND id IN (${activeTick})`,
    )
      .bind(
        sha,
        JSON.stringify(loaded.config),
        loaded.config_path,
        loaded.config_sha,
        (loaded as { error?: string }).error || null,
        id,
      )
      .run();
    tick = await env.DB.prepare(
      "SELECT * FROM ci_schedule_ticks WHERE id=? AND state='pending'",
    )
      .bind(id)
      .first<Tick>();
    if (!tick?.sha) return;
  }
  const run = await enqueueRun(
    env,
    repo,
    schedule.ref,
    tick.sha!,
    pipelineSchema.parse(JSON.parse(tick.config!)),
    "schedule",
    schedule.owner_id,
    "schedule:" + id,
    {
      config_path: tick.config_path,
      config_sha: tick.config_sha,
      error: tick.error || undefined,
      schedule_tick_id: id,
    },
  );
  const stored =
    run ||
    (await env.DB.prepare(
      "SELECT id,status FROM ci_runs WHERE schedule_tick_id=?",
    )
      .bind(id)
      .first<{ id: string; status: string }>());
  if (stored) {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE ci_schedule_ticks SET state='done' WHERE id=? AND state='pending'",
      ).bind(id),
      env.DB.prepare(
        "UPDATE ci_schedules SET last_error=? WHERE id=? AND revision=?",
      ).bind(tick.error, tick.schedule_id, tick.revision),
    ]);
  }
}

const authority = `(r.workspace_id IS NULL AND r.owner_id=u.id) OR EXISTS(SELECT 1 FROM members m WHERE m.repo_id=r.id AND m.user_id=u.id AND m.role IN ('maintainer','owner')) OR EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=r.workspace_id AND m.user_id=u.id AND m.role IN ('maintainer','owner'))`;
export function registerScheduleRoutes(
  app: Hono<App>,
  h: {
    access: (
      c: Context<App>,
      level?: "read" | "write" | "maintain",
    ) => Promise<Repo>;
    audit: (
      c: Context<App>,
      action: string,
      id: string,
      detail?: string,
    ) => Promise<void>;
  },
) {
  const base = "/api/repos/:namespace/:repo/ci/schedules";
  async function mutate(
    c: Context<App>,
    repo: Repo,
    statements: D1PreparedStatement[],
    condition = "1",
    args: unknown[] = [],
  ) {
    const guard = crypto.randomUUID(),
      user = identity(c);
    try {
      await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO mutation_guards(id,accepted) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM repositories r JOIN users u ON u.id=? WHERE r.id=? AND r.deleted_at IS NULL AND r.archived_at IS NULL AND u.disabled=0 AND (${authority})) AND (${condition}) THEN 1 ELSE 0 END`,
        ).bind(guard, user.id, repo.id, ...args),
        ...statements,
        c.env.DB.prepare("DELETE FROM mutation_guards WHERE id=?").bind(guard),
      ]);
    } catch (e) {
      if (e instanceof Error && /CHECK constraint failed/.test(e.message))
        fail(
          409,
          "Schedule version, permissions or project state changed; reload",
        );
      throw e;
    }
  }
  app.get(base, async (c) => {
    const repo = await h.access(c);
    return c.json({
      schedules: (
        await c.env.DB.prepare(
          `SELECT s.*,u.username AS owner,(SELECT r.id FROM ci_runs r JOIN ci_schedule_ticks t ON t.id=r.schedule_tick_id WHERE t.schedule_id=s.id ORDER BY r.rowid DESC LIMIT 1) AS last_run_id FROM ci_schedules s JOIN users u ON u.id=s.owner_id WHERE s.repo_id=? ORDER BY s.created_at,s.id`,
        )
          .bind(repo.id)
          .all()
      ).results,
    });
  });
  app.post(base, async (c) => {
    const repo = await h.access(c, "maintain"),
      user = identity(c),
      b = scheduleSchema.parse(await jsonInput(c)),
      id = crypto.randomUUID();
    await mutate(
      c,
      repo,
      [
        c.env.DB.prepare(
          "INSERT INTO ci_schedules(id,repo_id,owner_id,name,ref,cron,timezone,enabled,next_run_at) VALUES(?,?,?,?,?,?,?,?,?)",
        ).bind(
          id,
          repo.id,
          user.id,
          b.name,
          b.ref,
          b.cron,
          b.timezone,
          Number(b.enabled),
          nextSchedule(b.cron, b.timezone, Date.now()),
        ),
      ],
      "(SELECT COUNT(*) FROM ci_schedules WHERE repo_id=?)<20",
      [repo.id],
    );
    await h.audit(c, "ci.schedule.create", repo.id, id);
    return c.json(
      await c.env.DB.prepare("SELECT * FROM ci_schedules WHERE id=?")
        .bind(id)
        .first(),
      201,
    );
  });
  app.put(base + "/:schedule", async (c) => {
    const repo = await h.access(c, "maintain"),
      raw = await jsonInput(c),
      revision = z.number().int().nonnegative().parse(raw.revision),
      { revision: _, ...value } = raw,
      b = scheduleSchema.parse(value),
      id = c.req.param("schedule");
    await mutate(
      c,
      repo,
      [
        c.env.DB.prepare(
          "UPDATE ci_schedules SET name=?,ref=?,cron=?,timezone=?,enabled=?,next_run_at=?,revision=revision+1,last_error=NULL,updated_at=datetime('now') WHERE id=?",
        ).bind(
          b.name,
          b.ref,
          b.cron,
          b.timezone,
          Number(b.enabled),
          nextSchedule(b.cron, b.timezone, Date.now()),
          id,
        ),
      ],
      "EXISTS(SELECT 1 FROM ci_schedules WHERE id=? AND repo_id=? AND revision=?) AND (?=0 OR EXISTS(SELECT 1 FROM ci_authorized_schedules WHERE id=?))",
      [id, repo.id, revision, Number(b.enabled), id],
    );
    await h.audit(c, "ci.schedule.update", repo.id, id);
    return c.json(
      await c.env.DB.prepare("SELECT * FROM ci_schedules WHERE id=?")
        .bind(id)
        .first(),
    );
  });
  app.post(base + "/:schedule/take-ownership", async (c) => {
    const repo = await h.access(c, "maintain"),
      user = identity(c),
      id = c.req.param("schedule"),
      b = z
        .object({ revision: z.number().int().nonnegative() })
        .strict()
        .parse(await jsonInput(c));
    await mutate(
      c,
      repo,
      [
        c.env.DB.prepare(
          "UPDATE ci_schedules SET owner_id=?,enabled=0,revision=revision+1,last_error=NULL,updated_at=datetime('now') WHERE id=?",
        ).bind(user.id, id),
      ],
      "EXISTS(SELECT 1 FROM ci_schedules WHERE id=? AND repo_id=? AND revision=?)",
      [id, repo.id, b.revision],
    );
    await h.audit(c, "ci.schedule.take-ownership", repo.id, id);
    return c.json({ ok: true });
  });
  app.delete(base + "/:schedule", async (c) => {
    const repo = await h.access(c, "maintain"),
      id = c.req.param("schedule"),
      b = z
        .object({ revision: z.number().int().nonnegative() })
        .strict()
        .parse(await jsonInput(c));
    await mutate(
      c,
      repo,
      [c.env.DB.prepare("DELETE FROM ci_schedules WHERE id=?").bind(id)],
      "EXISTS(SELECT 1 FROM ci_schedules WHERE id=? AND repo_id=? AND revision=?)",
      [id, repo.id, b.revision],
    );
    await h.audit(c, "ci.schedule.delete", repo.id, id);
    return c.json({ ok: true });
  });
}
