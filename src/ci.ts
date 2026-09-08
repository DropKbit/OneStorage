import { registerVariableRoutes } from "./ci-variable-routes";
import { loadRunVariables, maskRunLog, maskLogRows } from "./ci-variables";
import { activeTick, registerScheduleRoutes } from "./ci-schedules";
import {
  executeJavaScript,
  saveCloudOutput,
  type CloudFiles,
} from "./cloud-ci";
import { z } from "zod";
import type { Hono, Context } from "hono";
import type { App, Env, Repo } from "./types";
import { fail, digest, randomToken, boundedBody, branch } from "./security";
import { jsonInput, identity } from "./workspaces";
import { roleRank } from "./access";
import { webhookURL } from "./webhooks";
import { coordinateWorkflow, wakeWorkflow, cancelRun } from "./ci-workflow";
import {
  resolvePipeline,
  validateDestinations,
  type ConfigOrigin,
  type SavedPipeline,
} from "./ci-source";
import { dependencyArtifacts } from "./ci-inputs";
import {
  pipelineSchema,
  executionSchema,
  filePath,
  type Pipeline,
} from "./ci-config";
export { pipelineSchema } from "./ci-config";
export interface CIRun {
  source_trigger?: string;
  trigger?: string;
  id: string;
  repo_id: string;
  ref: string;
  sha: string;
  config: string;
  status: string;
  lease_hash: string | null;
  lease_until: number | null;
  runner_id: string | null;
  created_at: string;
  started_at: string | null;
  parent_id?: string | null;
  job_key?: string | null;
  config_path?: string | null;
  config_sha?: string | null;
  config_error?: string | null;
}
async function safeRun(env: Env, row: any) {
  const value = publicRun(row);
  if (value?.error) value.error = await maskRunLog(env, value.id, value.error);
  return value;
}
function publicRun(row: any) {
  if (!row) return row;
  const { lease_hash, ...rest } = row;
  return { ...rest, config: JSON.parse(rest.config) };
}
export async function enqueueRun(
  env: Env,
  repo: Repo,
  ref: string,
  sha: string,
  config: Pipeline,
  trigger: string,
  actor: string | null,
  eventId: string | null = null,
  origin: ConfigOrigin = {},
) {
  const id = crypto.randomUUID();
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO ci_runs(id,repo_id,event_id,ref,sha,config,trigger,actor_id,status,config_path,config_sha,error,config_error,schedule_tick_id,source_trigger,finished_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CASE WHEN ? IS NOT NULL THEN datetime('now') END WHERE EXISTS(SELECT 1 FROM repositories WHERE id=? AND deleted_at IS NULL AND archived_at IS NULL) AND (SELECT COUNT(*) FROM ci_runs WHERE repo_id=? AND parent_id IS NULL AND status IN ('queued','running'))<20 AND (? IS NULL OR ? IN (${activeTick}))`,
  )
    .bind(
      id,
      repo.id,
      eventId,
      ref,
      sha,
      JSON.stringify(config),
      trigger,
      actor,
      origin.error ? "failed" : "queued",
      origin.config_path || null,
      origin.config_sha || null,
      origin.error || null,
      origin.error || null,
      origin.schedule_tick_id || null,
      origin.source_trigger || trigger,
      origin.error || null,
      repo.id,
      repo.id,
      origin.schedule_tick_id || null,
      origin.schedule_tick_id || null,
    )
    .run();
  if (!result.meta.changes) {
    if (
      origin.schedule_tick_id &&
      !(await env.DB.prepare(
        `SELECT id FROM ci_schedule_ticks WHERE id=? AND id IN (${activeTick})`,
      )
        .bind(origin.schedule_tick_id)
        .first())
    )
      return null;
    const current = await env.DB.prepare(
      "SELECT archived_at,deleted_at FROM repositories WHERE id=?",
    )
      .bind(repo.id)
      .first<{ archived_at: string | null; deleted_at: string | null }>();
    if (!current || current.archived_at || current.deleted_at) {
      if (eventId) return null;
      fail(409, "Repository archived or deleted");
    }
    if (
      eventId &&
      (await env.DB.prepare("SELECT id FROM ci_runs WHERE event_id=?")
        .bind(eventId)
        .first())
    )
      return null;
    fail(429, "Repository has 20 active pipeline runs");
  }
  // D1 is the durable outbox. Cron republishes if queue publication fails.
  if (!origin.error && config.runner !== "external" && env.EVENTS)
    try {
      await env.EVENTS.send({ id: "ci:" + id });
    } catch {}
  return { id, status: origin.error ? "failed" : "queued" };
}
export async function triggerPush(
  env: Env,
  event: {
    id: string;
    event: string;
    repository_id: string;
    [key: string]: unknown;
  },
) {
  if (
    event.event !== "push" ||
    typeof event.ref !== "string" ||
    !event.ref.startsWith("refs/heads/") ||
    typeof event.after !== "string" ||
    !/^[a-f0-9]{40}$/.test(event.after) ||
    /^0+$/.test(event.after)
  )
    return;
  const repo = await env.DB.prepare(
    "SELECT r.*,p.config,p.source_path FROM repositories r JOIN ci_pipelines p ON p.repo_id=r.id WHERE r.id=? AND r.deleted_at IS NULL AND r.archived_at IS NULL AND p.enabled=1",
  )
    .bind(event.repository_id)
    .first<Repo & SavedPipeline>();
  if (!repo) return;
  const ref = event.ref.slice(11);
  let loaded;
  try {
    loaded = await resolvePipeline(env, repo, repo, event.after);
  } catch (error) {
    if (!repo.source_path) throw error;
    await enqueueRun(
      env,
      repo,
      ref,
      event.after,
      executionSchema.parse({
        name: "Invalid repository pipeline",
        runner: "worker",
        steps: [{ type: "file", path: repo.source_path }],
      }),
      "push",
      null,
      event.id,
      {
        config_path: repo.source_path,
        config_sha: event.after,
        error:
          "Repository pipeline configuration could not be loaded or validated",
      },
    );
    return;
  }
  const { config } = loaded;
  if (config.branches.includes(ref))
    await enqueueRun(
      env,
      repo,
      ref,
      event.after,
      config,
      "push",
      null,
      event.id,
      loaded,
    );
}
/** Called from the repository alarm: never call back into its own serialized DO. */
export async function stagePush(
  env: Env,
  event: Parameters<typeof triggerPush>[1],
) {
  if (event.event !== "push") return;
  const inserted = await env.DB.prepare(
    "INSERT OR IGNORE INTO ci_events(id,repo_id,payload) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM repositories r JOIN ci_pipelines p ON p.repo_id=r.id WHERE r.id=? AND r.deleted_at IS NULL AND r.archived_at IS NULL AND p.enabled=1)",
  )
    .bind(
      event.id,
      event.repository_id,
      JSON.stringify(event),
      event.repository_id,
    )
    .run();
  if (!inserted.meta.changes) return;
  if (env.EVENTS)
    try {
      await env.EVENTS.send({ id: "ci-event:" + event.id });
    } catch {}
}
export async function consumeCIEvent(env: Env, id: string) {
  const event = await env.DB.prepare("SELECT payload FROM ci_events WHERE id=?")
    .bind(id)
    .first<{ payload: string }>();
  if (!event) return;
  await triggerPush(env, JSON.parse(event.payload));
  await env.DB.prepare("DELETE FROM ci_events WHERE id=?").bind(id).run();
}
async function repoEngine(env: Env, repo: Repo, path: string, body?: unknown) {
  const headers = {
    "x-repo-id": repo.id,
    "x-default-branch": repo.default_branch,
    "content-type": "application/json",
  };
  return env.REPOSITORIES.get(env.REPOSITORIES.idFromName(repo.id)).fetch(
    new Request("http://repository" + path, {
      headers,
      method: body === undefined ? "GET" : "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}
export async function claimRun(
  env: Env,
  repoId: string,
  runnerId: string,
  kind: "worker" | "external",
  id?: string,
) {
  const lease = randomToken();
  const row = await env.DB.prepare(
    "UPDATE ci_runs SET status='running',runner_id=?,lease_hash=?,lease_until=?,started_at=datetime('now') WHERE id=(SELECT c.id FROM ci_runs c JOIN repositories r ON r.id=c.repo_id WHERE c.repo_id=? AND r.deleted_at IS NULL AND r.archived_at IS NULL AND c.status='queued' AND json_extract(c.config,'$.runner')=? AND (? IS NULL OR c.id=?) ORDER BY c.created_at,c.id LIMIT 1) AND status='queued' RETURNING *",
  )
    .bind(
      runnerId,
      await digest(lease),
      Date.now() + 120000,
      repoId,
      kind,
      id || null,
      id || null,
    )
    .first<CIRun>();
  return row ? { run: row, lease } : null;
}
async function log(env: Env, run: CIRun, seq: number, content: string) {
  content = await maskRunLog(env, run.id, content);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO ci_logs(run_id,seq,content) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM ci_runs WHERE id=? AND status='running' AND lease_hash=? AND lease_until>?)",
  )
    .bind(
      run.id,
      seq,
      content.slice(0, 4096),
      run.id,
      run.lease_hash,
      Date.now(),
    )
    .run();
}
async function finish(
  env: Env,
  run: CIRun,
  status: "succeeded" | "failed",
  error: string | null = null,
) {
  if (error) error = (await maskRunLog(env, run.id, error)).slice(0, 1000);
  const result = await env.DB.prepare(
    "UPDATE ci_runs SET status=?,error=?,finished_at=datetime('now'),lease_hash=NULL,lease_until=NULL WHERE id=? AND status='running' AND lease_hash=? AND lease_until>?",
  )
    .bind(status, error, run.id, run.lease_hash, Date.now())
    .run();
  return result.meta.changes > 0;
}
export async function consumeCI(env: Env, id: string) {
  const workflow = await env.DB.prepare(
    "SELECT * FROM ci_runs WHERE id=? AND status IN ('queued','running') AND json_extract(config,'$.runner')='workflow'",
  )
    .bind(id)
    .first<CIRun>();
  if (workflow) return coordinateWorkflow(env, workflow);
  const pending = await env.DB.prepare(
    "SELECT r.* FROM repositories r JOIN ci_runs c ON c.repo_id=r.id WHERE c.id=? AND r.deleted_at IS NULL AND r.archived_at IS NULL AND c.status='queued'",
  )
    .bind(id)
    .first<Repo>();
  if (!pending) return;
  const claimed = await claimRun(
    env,
    pending.id,
    "cloudflare-worker",
    "worker",
    id,
  );
  if (!claimed) return;
  const run = claimed.run,
    config = executionSchema.parse(JSON.parse(run.config));
  let seq = 0;
  const artifacts: CloudFiles = Object.create(null);
  const deadline = Date.now() + Math.min(config.timeout_seconds * 1000, 110000);
  try {
    await loadRunVariables(env, run);
    const dependencies = await dependencyArtifacts(env, run);
    for (const step of config.steps) {
      if (Date.now() >= deadline) throw Error("Pipeline timeout");
      const active = await env.DB.prepare(
        "SELECT id FROM ci_runs WHERE id=? AND status='running' AND lease_hash=? AND lease_until>?",
      )
        .bind(id, run.lease_hash, Date.now())
        .first();
      if (!active) return;
      if (step.type === "javascript") {
        const output = await executeJavaScript(
          env,
          pending,
          run,
          step,
          artifacts,
          dependencies,
        );
        for (let offset = 0; offset < output.length; offset += 4096)
          await log(env, run, seq++, output.slice(offset, offset + 4096));
        await log(
          env,
          run,
          seq++,
          "PASS isolated JavaScript " + step.entry + "\n",
        );
      } else if (step.type === "file") {
        const response = await repoEngine(
          env,
          pending,
          "/blob?ref=" + run.sha + "&path=" + encodeURIComponent(step.path),
        );
        if (!response.ok) throw Error("File check failed: " + step.path);
        const blob = (await response.json()) as any;
        if (step.format === "json") {
          if (blob.binary || typeof blob.content !== "string")
            throw Error("JSON file must contain text");
          JSON.parse(blob.content);
        }
        await log(
          env,
          run,
          seq++,
          "PASS " + step.format + " " + step.path + "\n",
        );
      } else if (step.type === "http") {
        const url = webhookURL(step.url, env.CI_ALLOWED_HOSTS);
        const response = await fetch(url, {
          redirect: "manual",
          signal: AbortSignal.timeout(10000),
        });
        await response.body?.cancel();
        if (response.status !== step.status)
          throw Error("HTTP check returned " + response.status);
        await log(
          env,
          run,
          seq++,
          "PASS HTTP " + new URL(url).hostname + " " + response.status + "\n",
        );
      } else throw Error("Unsupported Worker step");
    }
    if (Date.now() >= deadline) throw Error("Pipeline timeout");
    if (Object.keys(artifacts).length || config.deploy)
      await saveCloudOutput(env, pending, run, artifacts, config.deploy);
    else await finish(env, run, "succeeded");
  } catch (e) {
    const error = await maskRunLog(
      env,
      run.id,
      e instanceof Error ? e.message : "Pipeline failed",
    );
    await log(env, run, seq++, "FAIL " + error.slice(0, 1000) + "\n");
    await finish(env, run, "failed", error.slice(0, 1000));
  } finally {
    await wakeWorkflow(env, run.parent_id);
  }
}
export async function publishCI(env: Env) {
  await env.DB.prepare(
    "UPDATE ci_runs SET status='failed',error='Runner lease expired; retry explicitly to avoid repeating a deployment',finished_at=datetime('now'),lease_hash=NULL WHERE status='running' AND lease_until<?",
  )
    .bind(Date.now())
    .run();
  await env.DB.prepare(
    "UPDATE ci_runs SET status='canceled',error='Repository deleted',finished_at=datetime('now'),lease_hash=NULL WHERE status IN ('queued','running') AND repo_id IN (SELECT id FROM repositories WHERE deleted_at IS NOT NULL)",
  ).run();
  if (env.EVENTS) {
    const events = await env.DB.prepare(
      "SELECT id FROM ci_events ORDER BY created_at LIMIT 50",
    ).all<{ id: string }>();
    for (const event of events.results)
      await env.EVENTS.send({ id: "ci-event:" + event.id });
    const rows = await env.DB.prepare(
      "SELECT id FROM ci_runs WHERE (status='queued' AND json_extract(config,'$.runner')='worker') OR (status IN ('queued','running') AND json_extract(config,'$.runner')='workflow') ORDER BY created_at LIMIT 100",
    ).all<{ id: string }>();
    for (const r of rows.results) await env.EVENTS.send({ id: "ci:" + r.id });
  }
}
interface Helpers {
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
}
export function registerCIRoutes(app: Hono<App>, h: Helpers) {
  const base = "/api/repos/:namespace/:repo/ci";
  const access = async (
    c: Context<App>,
    level: "read" | "write" | "maintain" = "read",
  ) => {
    identity(c);
    const repo = await h.access(c, level);
    if (!roleRank[c.get("repoRole")]) fail(404, "Pipeline not found");
    return repo;
  };
  registerScheduleRoutes(app, { ...h, access });
  registerVariableRoutes(app, { access });
  const getRun = async (
    c: Context<App>,
    level: "read" | "write" | "maintain" = "read",
  ) => {
    const repo = await access(c, level);
    const run = await c.env.DB.prepare(
      "SELECT * FROM ci_runs WHERE id=? AND repo_id=?",
    )
      .bind(c.req.param("id"), repo.id)
      .first<CIRun>();
    if (!run) fail(404, "Run not found");
    return { repo, run };
  };
  app.get(base + "/config", async (c) => {
    const repo = await access(c);
    const config = await c.env.DB.prepare(
      "SELECT config,source_path,enabled,updated_at FROM ci_pipelines WHERE repo_id=?",
    )
      .bind(repo.id)
      .first<any>();
    return c.json(
      config
        ? {
            ...config,
            config: config.source_path ? null : JSON.parse(config.config),
          }
        : { config: null, enabled: false },
    );
  });
  app.put(base + "/config", async (c) => {
    const repo = await access(c, "maintain"),
      raw = await jsonInput(c),
      source_path = raw.source_path ? filePath.parse(raw.source_path) : null,
      config = source_path ? null : pipelineSchema.parse(raw.config),
      enabled = z.boolean().parse(raw.enabled ?? true);
    if (config) validateDestinations(config, c.env);
    await c.env.DB.prepare(
      "INSERT INTO ci_pipelines(repo_id,config,enabled,source_path) VALUES(?,?,?,?) ON CONFLICT(repo_id) DO UPDATE SET config=excluded.config,enabled=excluded.enabled,source_path=excluded.source_path,updated_at=datetime('now')",
    )
      .bind(repo.id, JSON.stringify(config), Number(enabled), source_path)
      .run();
    await h.audit(c, "ci.config.update", repo.id);
    return c.json({ config, enabled, source_path });
  });
  app.get(base + "/runs", async (c) => {
    const repo = await access(c);
    return c.json({
      runs: await Promise.all(
        (
          await c.env.DB.prepare(
            "SELECT * FROM ci_runs WHERE repo_id=? AND parent_id IS NULL ORDER BY rowid DESC LIMIT 50",
          )
            .bind(repo.id)
            .all()
        ).results.map((row) => safeRun(c.env, row)),
      ),
    });
  });
  app.post(base + "/runs", async (c) => {
    const repo = await access(c, "maintain"),
      b = z.object({ ref: branch.optional() }).parse(await jsonInput(c));
    const saved = await c.env.DB.prepare(
      "SELECT config,source_path FROM ci_pipelines WHERE repo_id=?",
    )
      .bind(repo.id)
      .first<SavedPipeline>();
    if (!saved) fail(409, "Save a pipeline first");
    const ref = b.ref || repo.default_branch;
    const resolved = await repoEngine(
      c.env,
      repo,
      "/branch?branch=" + encodeURIComponent(ref),
    );
    if (!resolved.ok) fail(404, "Branch not found");
    const commit = (await resolved.json()) as { sha: string };
    const loaded = await resolvePipeline(c.env, repo, saved, commit.sha);
    const run = await enqueueRun(
      c.env,
      repo,
      ref,
      commit.sha,
      loaded.config,
      "manual",
      c.get("user")!.id,
      null,
      loaded,
    );
    await h.audit(c, "ci.run.create", repo.id, run!.id);
    return c.json(run, 201);
  });
  app.get(base + "/runs/:id", async (c) => {
    const { run } = await getRun(c);
    return c.json({
      ...(await safeRun(c.env, run)),
      jobs: await Promise.all(
        (
          await c.env.DB.prepare(
            "SELECT * FROM ci_runs WHERE parent_id=? ORDER BY rowid",
          )
            .bind(run.id)
            .all()
        ).results.map((row) => safeRun(c.env, row)),
      ),
      logs: await maskLogRows(
        c.env,
        run.id,
        (
          await c.env.DB.prepare(
            "SELECT seq,content FROM ci_logs WHERE run_id=? ORDER BY seq",
          )
            .bind(run.id)
            .all<{ seq: number; content: string }>()
        ).results,
      ),
      artifacts: (
        await c.env.DB.prepare(
          "SELECT id,name,size FROM ci_artifacts WHERE run_id=?",
        )
          .bind(run.id)
          .all()
      ).results,
    });
  });
  app.post(base + "/runs/:id/cancel", async (c) => {
    const { repo, run } = await getRun(c, "maintain");
    await cancelRun(c.env, run.id);
    await wakeWorkflow(c.env, run.parent_id);
    await h.audit(c, "ci.run.cancel", repo.id, run.id);
    return c.json({ ok: true });
  });
  app.post(base + "/runs/:id/retry", async (c) => {
    const { repo, run } = await getRun(c, "maintain");
    if (run.parent_id)
      fail(409, "Retry the parent workflow to preserve dependencies");
    if (run.config_error)
      fail(409, "Fix the repository configuration and start a new run");
    if (["running", "queued"].includes(run.status))
      fail(409, "Wait for the run to finish or cancel it");
    const result = await enqueueRun(
      c.env,
      repo,
      run.ref,
      run.sha,
      pipelineSchema.parse(JSON.parse(run.config)),
      "retry",
      c.get("user")!.id,
      null,
      {
        config_path: run.config_path,
        config_sha: run.config_sha,
        source_trigger: run.source_trigger || run.trigger,
      },
    );
    await h.audit(c, "ci.run.retry", repo.id, run.id);
    return c.json(result, 201);
  });
  app.get(base + "/runs/:id/artifacts/:artifact", async (c) => {
    const { run } = await getRun(c);
    const row = await c.env.DB.prepare(
      "SELECT object_key,name FROM ci_artifacts WHERE id=? AND run_id=?",
    )
      .bind(c.req.param("artifact"), run.id)
      .first<any>();
    if (!row) fail(404, "Artifact not found");
    const object = await c.env.OBJECTS.get(row.object_key);
    if (!object) fail(404, "Artifact unavailable");
    return new Response(object.body, {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition":
          "attachment; filename*=UTF-8''" + encodeURIComponent(row.name),
        "cache-control": "no-store",
      },
    });
  });
  app.get(base + "/runners", async (c) => {
    const repo = await access(c, "maintain");
    return c.json({
      runners: (
        await c.env.DB.prepare(
          "SELECT id,name,last_seen,created_at FROM ci_runners WHERE repo_id=? ORDER BY created_at",
        )
          .bind(repo.id)
          .all()
      ).results,
    });
  });
  app.post(base + "/runners", async (c) => {
    const repo = await access(c, "maintain"),
      b = z
        .object({ name: z.string().trim().min(1).max(80) })
        .parse(await jsonInput(c));
    const id = crypto.randomUUID(),
      token = "osr_" + randomToken();
    const inserted = await c.env.DB.prepare(
      "INSERT INTO ci_runners(id,repo_id,name,token_hash) SELECT ?,?,?,? WHERE (SELECT COUNT(*) FROM ci_runners WHERE repo_id=?)<10",
    )
      .bind(id, repo.id, b.name, await digest(token), repo.id)
      .run();
    if (!inserted.meta.changes) fail(409, "Maximum 10 runners per repository");
    await h.audit(c, "ci.runner.create", repo.id, b.name);
    return c.json({ id, token }, 201);
  });
  app.delete(base + "/runners/:runner", async (c) => {
    const repo = await access(c, "maintain");
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM ci_runners WHERE id=? AND repo_id=?").bind(
        c.req.param("runner"),
        repo.id,
      ),
      c.env.DB.prepare(
        "UPDATE ci_runs SET status='canceled',lease_hash=NULL,finished_at=datetime('now') WHERE repo_id=? AND runner_id=? AND status='running'",
      ).bind(repo.id, c.req.param("runner")),
    ]);
    await h.audit(c, "ci.runner.revoke", repo.id, c.req.param("runner"));
    return c.json({ ok: true });
  });
  // Runner credentials are independent of PAT/session authentication and scoped to one repository.
  async function runner(c: Context<App>) {
    const token = c.req.header("authorization")?.replace(/^Bearer /, "") || "";
    if (!token.startsWith("osr_")) fail(401, "Runner token required");
    const row = await c.env.DB.prepare(
      "SELECT cr.*,r.default_branch FROM ci_runners cr JOIN repositories r ON r.id=cr.repo_id WHERE cr.token_hash=? AND r.deleted_at IS NULL AND r.archived_at IS NULL",
    )
      .bind(await digest(token))
      .first<any>();
    if (!row) fail(401, "Runner token revoked");
    return row;
  }
  async function lease(c: Context<App>) {
    const r = await runner(c),
      token = c.req.header("x-run-lease") || "";
    const run = await c.env.DB.prepare(
      "SELECT * FROM ci_runs WHERE id=? AND repo_id=? AND runner_id=? AND status='running' AND lease_hash=? AND lease_until>?",
    )
      .bind(c.req.param("id"), r.repo_id, r.id, await digest(token), Date.now())
      .first<CIRun>();
    if (!run) fail(409, "Run is canceled, finished or lease expired");
    const config = pipelineSchema.parse(JSON.parse(run.config));
    if (
      Date.now() - Date.parse(run.started_at!.replace(" ", "T") + "Z") >
      config.timeout_seconds * 1000
    ) {
      await finish(c.env, run, "failed", "Pipeline timeout");
      fail(409, "Pipeline timeout");
    }
    return { runner: r, run };
  }
  app.post("/api/runner/claim", async (c) => {
    const r = await runner(c);
    await c.env.DB.prepare("UPDATE ci_runners SET last_seen=? WHERE id=?")
      .bind(Date.now(), r.id)
      .run();
    const claimed = await claimRun(c.env, r.repo_id, r.id, "external");
    return c.json(
      claimed
        ? { run: publicRun(claimed.run), lease: claimed.lease }
        : { run: null },
    );
  });
  app.post("/api/runner/runs/:id/heartbeat", async (c) => {
    const { run, runner: r } = await lease(c);
    const config = pipelineSchema.parse(JSON.parse(run.config));
    if (
      Date.now() - Date.parse(run.started_at!.replace(" ", "T") + "Z") >
      config.timeout_seconds * 1000
    ) {
      await finish(c.env, run, "failed", "Pipeline timeout");
      fail(409, "Pipeline timeout");
    }
    await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE ci_runs SET lease_until=? WHERE id=? AND status='running' AND lease_hash=?",
      ).bind(Date.now() + 120000, run.id, run.lease_hash),
      c.env.DB.prepare("UPDATE ci_runners SET last_seen=? WHERE id=?").bind(
        Date.now(),
        r.id,
      ),
    ]);
    return c.json({ ok: true });
  });
  app.get("/api/runner/runs/:id/source", async (c) => {
    const { run, runner: r } = await lease(c);
    return repoEngine(
      c.env,
      { id: r.repo_id, default_branch: r.default_branch } as Repo,
      "/archive",
      { ref: run.sha, format: "tar" },
    );
  });
  app.get("/api/runner/runs/:id/variables", async (c) => {
    const { run } = await lease(c);
    const values = await loadRunVariables(c.env, run);
    await lease(c);
    c.header("Cache-Control", "no-store");
    return c.json(values);
  });
  app.get("/api/runner/runs/:id/inputs", async (c) => {
    const { run } = await lease(c);
    const dependencies = await dependencyArtifacts(
      c.env,
      run,
      16 * 1024 * 1024,
    );
    // Recheck after R2 reads: transfer/cancel/revocation may have invalidated access while inputs were loading.
    await lease(c);
    return c.json({ dependencies });
  });
  app.post("/api/runner/runs/:id/logs", async (c) => {
    const { run } = await lease(c),
      b = z
        .object({
          seq: z.number().int().min(0).max(255),
          content: z.string().max(4096),
        })
        .parse(await jsonInput(c));
    await log(c.env, run, b.seq, b.content);
    return c.json({ ok: true });
  });
  app.put("/api/runner/runs/:id/artifacts/:name", async (c) => {
    const { run } = await lease(c),
      name = filePath.parse(c.req.param("name"));
    const count = await c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM ci_artifacts WHERE run_id=?",
    )
      .bind(run.id)
      .first<{ n: number }>();
    if (count!.n >= 10) fail(409, "Maximum 10 artifacts");
    const data = await boundedBody(c.req.raw, 16 * 1024 * 1024),
      id = crypto.randomUUID(),
      key = "ci/" + run.repo_id + "/" + run.id + "/" + id;
    await c.env.OBJECTS.put(key, data);
    try {
      const result = await c.env.DB.prepare(
        "INSERT INTO ci_artifacts(id,run_id,name,size,object_key) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM ci_runs c JOIN repositories r ON r.id=c.repo_id WHERE c.id=? AND c.status='running' AND c.lease_hash=? AND c.lease_until>? AND r.deleted_at IS NULL AND r.archived_at IS NULL) AND (SELECT COUNT(*) FROM ci_artifacts WHERE run_id=?)<10",
      )
        .bind(
          id,
          run.id,
          name,
          data.length,
          key,
          run.id,
          run.lease_hash,
          Date.now(),
          run.id,
        )
        .run();
      if (!result.meta.changes) {
        await c.env.OBJECTS.delete(key);
        fail(409, "Run canceled");
      }
    } catch (e) {
      await c.env.OBJECTS.delete(key);
      throw e;
    }
    return c.json({ id, name, size: data.length }, 201);
  });
  app.post("/api/runner/runs/:id/complete", async (c) => {
    const { run } = await lease(c),
      b = z
        .object({
          status: z.enum(["succeeded", "failed"]),
          error: z.string().max(1000).optional(),
        })
        .parse(await jsonInput(c));
    if (!(await finish(c.env, run, b.status, b.error || null)))
      fail(409, "Run canceled");
    await wakeWorkflow(c.env, run.parent_id);
    return c.json({ ok: true });
  });
}
