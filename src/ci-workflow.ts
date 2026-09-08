import type { Env } from "./types";
import type { CIRun } from "./ci";
import { workflowSchema } from "./ci-config";

export async function wakeWorkflow(env: Env, parent?: string | null) {
  if (parent && env.EVENTS) {
    try {
      await env.EVENTS.send({ id: "ci:" + parent });
    } catch {}
  }
}

export async function cancelRun(env: Env, id: string) {
  await env.DB.prepare(
    "UPDATE ci_runs SET status='canceled',finished_at=datetime('now'),lease_hash=NULL,lease_until=NULL WHERE (id=? OR parent_id=?) AND status IN ('queued','running')",
  )
    .bind(id, id)
    .run();
}

/** Replayable D1 coordinator. Child uniqueness and guarded SQL tolerate duplicate queue messages. */
export async function coordinateWorkflow(env: Env, run: CIRun) {
  const config = workflowSchema.parse(JSON.parse(run.config));
  await env.DB.prepare(
    "UPDATE ci_runs SET status='canceled',error='Private package authority changed',finished_at=datetime('now'),lease_hash=NULL,lease_until=NULL WHERE (id=? OR parent_id=?) AND status IN('queued','running') AND EXISTS(SELECT 1 FROM ci_invalid_package_runs b WHERE b.id=ci_runs.id)",
  )
    .bind(run.id, run.id)
    .run();
  await env.DB.prepare(
    "UPDATE ci_runs SET status='running',started_at=datetime('now') WHERE id=? AND status='queued' AND EXISTS(SELECT 1 FROM repositories WHERE id=ci_runs.repo_id AND deleted_at IS NULL AND archived_at IS NULL)",
  )
    .bind(run.id)
    .run();
  // A failure or timeout terminates the parent before children are revoked. Publication checks the parent too.
  await env.DB.prepare(
    "UPDATE ci_runs SET status='failed',error='Workflow job failed, canceled, or workflow timed out',finished_at=datetime('now') WHERE id=? AND status='running' AND (EXISTS(SELECT 1 FROM ci_runs child WHERE child.parent_id=ci_runs.id AND child.status IN ('failed','canceled')) OR (julianday('now')-julianday(started_at))*86400>?)",
  )
    .bind(run.id, config.timeout_seconds)
    .run();
  await env.DB.prepare(
    "UPDATE ci_runs SET status='canceled',error='Parent workflow stopped',finished_at=datetime('now'),lease_hash=NULL,lease_until=NULL WHERE parent_id=? AND status IN ('queued','running') AND NOT EXISTS(SELECT 1 FROM ci_runs parent WHERE parent.id=? AND parent.status='running')",
  )
    .bind(run.id, run.id)
    .run();
  const ready: string[] = [];
  for (const job of config.jobs) {
    const id = crypto.randomUUID();
    const inserted = await env.DB.prepare(
      `INSERT OR IGNORE INTO ci_runs(id,repo_id,ref,sha,config,trigger,actor_id,status,parent_id,job_key,config_path,config_sha,source_trigger)
      SELECT ?,repo_id,ref,sha,?,'workflow',actor_id,'queued',id,?,config_path,config_sha,source_trigger FROM ci_runs parent WHERE id=? AND status='running'
      AND EXISTS(SELECT 1 FROM repositories r WHERE r.id=parent.repo_id AND r.deleted_at IS NULL AND r.archived_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM ci_runs child WHERE child.parent_id=parent.id AND child.status IN ('failed','canceled'))
      AND NOT EXISTS(SELECT 1 FROM json_each(?) dependency WHERE NOT EXISTS(SELECT 1 FROM ci_runs child WHERE child.parent_id=parent.id AND child.job_key=dependency.value AND child.status='succeeded'))
      AND (SELECT COUNT(*) FROM ci_runs active WHERE active.repo_id=parent.repo_id AND active.status IN ('queued','running'))<100`,
    )
      .bind(
        id,
        JSON.stringify(job.pipeline),
        job.id,
        run.id,
        JSON.stringify(job.needs),
      )
      .run();
    if (inserted.meta.changes && job.pipeline.runner === "worker")
      ready.push(id);
  }
  if (ready.length && env.EVENTS) {
    try {
      await env.EVENTS.sendBatch(
        ready.map((id) => ({ body: { id: "ci:" + id } })),
      );
    } catch {}
  }
  await env.DB.prepare(
    "UPDATE ci_runs SET status='succeeded',finished_at=datetime('now') WHERE id=? AND status='running' AND (SELECT COUNT(*) FROM ci_runs child WHERE child.parent_id=ci_runs.id AND child.status='succeeded')=?",
  )
    .bind(run.id, config.jobs.length)
    .run();
}
