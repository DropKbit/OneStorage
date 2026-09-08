import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Env, Repo, User } from "./types";
import { fail, digest } from "./security";
import { reviewActor } from "./review-mutations";
import { reviewGate } from "./review";
import { activeRepo } from "./fork-reviews";
import { repositoryRole, roleRank } from "./access";
import { ForgeRepository } from "./git/forge";
import { pipelineSchema, filePath } from "./ci-config";
import { validateDestinations, type SavedPipeline } from "./ci-source";
import { enqueueRun } from "./ci";

export const queueActive = "('queued','checking','blocked')";
export interface QueueEntry {
  id: number;
  repo_id: string;
  mr_id: number;
  actor_id: string;
  actor_epoch: number;
  last_actor_id: string;
  lifecycle_revision: number;
  target: string;
  source_sha: string;
  target_sha: string;
  mr_revision: number;
  strategy: "ff_prefer" | "ff_only" | "merge";
  squash: number;
  state: string;
  reason: string;
  generation: number;
  candidate_sha: string | null;
  run_id: string | null;
  config_fingerprint: string | null;
  created_at: number;
  expires_at: number;
  checked_at: number;
  merged_sha: string | null;
}
const options = z.object({
  id: z.number().int().positive(),
  actor_id: z.string(),
  credential: z.string(),
  revision: z.number().int().min(0),
  strategy: z.enum(["ff_prefer", "ff_only", "merge"]).default("ff_prefer"),
  squash: z.boolean().default(false),
});
export async function queueSource(
  env: Env,
  metadata: Repo,
  mr: any,
  actor: string,
  local: ForgeRepository,
) {
  if (!mr.source_repo_id) return local.refs["refs/heads/" + mr.source] || null;
  const source = await activeRepo(env, mr.source_repo_id);
  const { user } = await reviewActor(env, metadata, actor);
  if (
    !source ||
    (source.visibility !== "public" &&
      roleRank[await repositoryRole(env, source, user)] < 1)
  )
    fail(409, "Source fork is unavailable to the queue owner");
  const r = await env.REPOSITORIES.get(
    env.REPOSITORIES.idFromName(source.id),
  ).fetch(
    new Request(
      "http://repository/internal/queue-source?ref=" +
        encodeURIComponent("refs/heads/" + mr.source),
      {
        headers: {
          "x-repo-id": source.id,
          "x-lifecycle-revision": String(source.lifecycle_revision),
        },
      },
    ),
  );
  if (!r.ok) {
    await r.body?.cancel();
    fail(409, "Source fork state is unavailable");
  }
  return ((await r.json()) as { sha: string | null }).sha;
}
export async function queueMutation(
  env: Env,
  storage: DurableObjectStorage,
  metadata: Repo,
  repo: ForgeRepository,
  action: string,
  raw: unknown,
) {
  const base = z
    .object({
      id: z.number().int().positive(),
      actor_id: z.string(),
      credential: z.string(),
    })
    .parse(raw);
  const { rank } = await reviewActor(env, metadata, base.actor_id);
  if (rank < 3) fail(403, "Maintainer required");
  const actor = await env.DB.prepare(
    `SELECT u.auth_epoch FROM users u JOIN credentials c ON c.user_id=u.id
    WHERE u.id=? AND u.disabled=0 AND c.hash=? AND c.expires_at>? AND (c.kind='session' OR (c.kind='pat' AND c.scope='write'))`,
  )
    .bind(base.actor_id, base.credential, Date.now())
    .first<{ auth_epoch: number }>();
  if (!actor) fail(403, "Current write credential required");
  if (action === "cancel") {
    const result = await env.DB.prepare(
      `UPDATE merge_queue SET state='canceled',reason='Canceled by maintainer',last_actor_id=?,finished_at=?
      WHERE id=? AND repo_id=? AND state IN ${queueActive}`,
    )
      .bind(base.actor_id, Date.now(), base.id, metadata.id)
      .run();
    if (!result.meta.changes)
      fail(409, "Queue entry already finished or unavailable");
    return { ok: true };
  }
  const b = options.parse(raw);
  if (b.squash && b.strategy === "ff_only")
    fail(400, "Squash is incompatible with ff_only");
  const mr = await env.DB.prepare(
    "SELECT * FROM merge_requests WHERE id=? AND repo_id=?",
  )
    .bind(b.id, metadata.id)
    .first<any>();
  if (!mr || mr.state !== "open" || mr.revision !== b.revision)
    fail(409, "Merge request changed; reload before queueing");
  if (
    (await queueSource(env, metadata, mr, b.actor_id, repo)) !== mr.source_sha
  )
    fail(409, "Source branch moved; refresh and review the merge request");
  if (
    !(await env.DB.prepare("SELECT repo_id FROM ci_pipelines WHERE repo_id=?")
      .bind(metadata.id)
      .first())
  )
    fail(409, "Save a target repository pipeline before queueing");
  const existing = await env.DB.prepare(
    `SELECT * FROM merge_queue WHERE mr_id=? AND state IN ${queueActive}`,
  )
    .bind(mr.id)
    .first<QueueEntry>();
  if (existing) {
    if (
      existing.actor_id === b.actor_id &&
      existing.mr_revision === mr.revision &&
      existing.strategy === b.strategy &&
      !!existing.squash === b.squash
    )
      return existing;
    fail(409, "Merge request is already queued");
  }
  // Wakeup is durable before the D1 intent; a failure/uncertain D1 commit cannot lose work.
  await storage.put("merge-queue", metadata.id);
  await storage.setAlarm(Date.now() + 1000);
  const now = Date.now();
  const row = await env.DB.prepare(
    `INSERT INTO merge_queue(repo_id,mr_id,actor_id,actor_epoch,last_actor_id,lifecycle_revision,target,source_sha,target_sha,mr_revision,strategy,squash,created_at,expires_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT count(*) FROM merge_queue WHERE repo_id=? AND state IN ${queueActive})<100
    AND EXISTS(SELECT 1 FROM users u JOIN credentials c ON c.user_id=u.id JOIN repositories r ON r.id=?
      WHERE u.id=? AND u.disabled=0 AND u.auth_epoch=? AND c.hash=? AND c.expires_at>?
      AND (c.kind='session' OR (c.kind='pat' AND c.scope='write'))
      AND r.deleted_at IS NULL AND r.archived_at IS NULL AND r.lifecycle_revision=?
      AND ((r.workspace_id IS NULL AND r.owner_id=u.id)
        OR EXISTS(SELECT 1 FROM members x WHERE x.repo_id=r.id AND x.user_id=u.id AND x.role IN('maintainer','owner'))
        OR EXISTS(SELECT 1 FROM workspace_members x WHERE x.workspace_id=r.workspace_id AND x.user_id=u.id AND x.role IN('maintainer','owner')))) RETURNING *`,
  )
    .bind(
      metadata.id,
      mr.id,
      b.actor_id,
      actor.auth_epoch,
      b.actor_id,
      metadata.lifecycle_revision,
      mr.target,
      mr.source_sha,
      mr.target_sha,
      mr.revision,
      b.strategy,
      +b.squash,
      now,
      now + 86400000,
      metadata.id,
      metadata.id,
      b.actor_id,
      actor.auth_epoch,
      b.credential,
      now,
      metadata.lifecycle_revision,
    )
    .first();
  if (!row) fail(409, "Queue capacity or account security changed");
  return row;
}
async function fingerprint(env: Env, metadata: Repo, target: string) {
  const saved = await env.DB.prepare(
    "SELECT config,source_path FROM ci_pipelines WHERE repo_id=?",
  )
    .bind(metadata.id)
    .first<SavedPipeline>();
  if (!saved) fail(409, "Target repository pipeline is unavailable");
  return {
    saved,
    hash: await digest(
      JSON.stringify([saved.config, saved.source_path || null, target]),
    ),
  };
}
async function stop(env: Env, e: QueueEntry, state: string, reason: string) {
  await env.DB.prepare(
    `UPDATE merge_queue SET state=?,reason=?,finished_at=? WHERE id=? AND state IN ${queueActive}`,
  )
    .bind(state, reason.slice(0, 1000), Date.now(), e.id)
    .run();
}
export async function validateQueuePublication(
  env: Env,
  metadata: Repo,
  repo: ForgeRepository,
  e: QueueEntry,
  mr: any,
) {
  const current = await env.DB.prepare(
    `SELECT q.* FROM merge_queue q JOIN users u ON u.id=q.actor_id JOIN repositories r ON r.id=q.repo_id
    WHERE q.id=? AND q.id IN(SELECT id FROM merge_queue_authority) AND q.state='checking' AND q.candidate_sha=? AND q.run_id=? AND q.generation=? AND q.expires_at>?
    AND u.disabled=0 AND u.auth_epoch=q.actor_epoch AND r.deleted_at IS NULL AND r.archived_at IS NULL AND r.lifecycle_revision=q.lifecycle_revision
    AND NOT EXISTS(SELECT 1 FROM merge_queue p WHERE p.repo_id=q.repo_id AND p.target=q.target AND p.id<q.id AND p.state IN ${queueActive})`,
  )
    .bind(e.id, e.candidate_sha, e.run_id, e.generation, Date.now())
    .first<QueueEntry>();
  if (!current || (await reviewActor(env, metadata, e.actor_id)).rank < 3)
    fail(409, "Queue authorization or position changed");
  const latest = await env.DB.prepare(
    "SELECT * FROM merge_requests WHERE id=? AND repo_id=?",
  )
    .bind(e.mr_id, metadata.id)
    .first<any>();
  if (
    !latest ||
    latest.state !== "open" ||
    latest.revision !== e.mr_revision ||
    latest.source_sha !== e.source_sha ||
    latest.target_sha !== e.target_sha ||
    repo.refs["refs/heads/" + e.target] !== e.target_sha ||
    (await queueSource(env, metadata, latest, e.actor_id, repo)) !==
      e.source_sha
  )
    fail(409, "Queued merge snapshot changed");
  if (
    (await fingerprint(env, metadata, e.target_sha)).hash !==
    e.config_fingerprint
  )
    fail(409, "Queue pipeline configuration changed");
  const gate = await reviewGate(env, metadata, latest, repo.store, {
    queueRun: { id: e.run_id!, sha: e.candidate_sha! },
  });
  if (!gate.allowed || gate.ci?.status !== "succeeded")
    fail(409, gate.reasons.join("; ") || "Candidate pipeline must succeed");
  return latest;
}
/** Invoked inside the target DO writer gate. One FIFO head per alarm, round-robin across target branches. */
export async function advanceQueue(
  env: Env,
  storage: DurableObjectStorage,
  metadata: Repo,
  repo: ForgeRepository,
  publish: (entry: QueueEntry, mr: any) => Promise<void>,
) {
  const e = await env.DB.prepare(
    `SELECT q.* FROM merge_queue q WHERE q.repo_id=? AND q.state IN ${queueActive}
    AND NOT EXISTS(SELECT 1 FROM merge_queue p WHERE p.repo_id=q.repo_id AND p.target=q.target AND p.id<q.id AND p.state IN ${queueActive})
    ORDER BY q.checked_at,q.id LIMIT 1`,
  )
    .bind(metadata.id)
    .first<QueueEntry>();
  if (!e) {
    await storage.delete("merge-queue");
    return;
  }
  await storage.setAlarm(Date.now() + 15000);
  await env.DB.prepare("UPDATE merge_queue SET checked_at=? WHERE id=?")
    .bind(Date.now(), e.id)
    .run();
  try {
    const user = await env.DB.prepare(
      "SELECT id,username,admin,auth_epoch,disabled FROM users WHERE id=?",
    )
      .bind(e.actor_id)
      .first<User & { auth_epoch: number; disabled: number }>();
    if (
      !user ||
      user.disabled ||
      user.auth_epoch !== e.actor_epoch ||
      roleRank[await repositoryRole(env, metadata, user)] < 3 ||
      e.lifecycle_revision !== metadata.lifecycle_revision ||
      e.expires_at <= Date.now()
    ) {
      await stop(env, e, "canceled", "Queue authorization expired or changed");
      return;
    }
    let mr = await env.DB.prepare(
      "SELECT * FROM merge_requests WHERE id=? AND repo_id=?",
    )
      .bind(e.mr_id, metadata.id)
      .first<any>();
    if (
      !mr ||
      mr.state !== "open" ||
      mr.revision !== e.mr_revision ||
      mr.source_sha !== e.source_sha
    ) {
      await stop(env, e, "canceled", "Merge request was changed or closed");
      return;
    }
    if (
      (await queueSource(env, metadata, mr, e.actor_id, repo)) !== e.source_sha
    ) {
      await stop(
        env,
        e,
        "canceled",
        "Source branch moved; refresh, review and enqueue again",
      );
      return;
    }
    const target = repo.refs["refs/heads/" + e.target];
    if (!target) {
      await stop(env, e, "canceled", "Target branch removed");
      return;
    }
    const config = await fingerprint(env, metadata, target);
    if (
      target !== e.target_sha ||
      (e.config_fingerprint && e.config_fingerprint !== config.hash)
    ) {
      const changed = target !== e.target_sha;
      const result = await env.DB.batch([
        env.DB.prepare(
          `UPDATE merge_queue SET target_sha=?,mr_revision=mr_revision+?,generation=generation+1,candidate_sha=NULL,run_id=NULL,config_fingerprint=NULL,state='queued',reason='Candidate must be rebuilt for current base/configuration'
          WHERE id=? AND generation=? AND state IN ${queueActive}`,
        ).bind(target, +changed, e.id, e.generation),
        env.DB.prepare(
          `UPDATE merge_requests SET target_sha=?,revision=revision+1 WHERE id=? AND revision=? AND state='open' AND ?=1
          AND EXISTS(SELECT 1 FROM merge_queue WHERE id=? AND generation=?)`,
        ).bind(target, mr.id, mr.revision, +changed, e.id, e.generation + 1),
      ]);
      if (!result[0].meta.changes || (changed && !result[1].meta.changes))
        fail(409, "Merge request changed during queue refresh");
      return;
    }
    const approval = await reviewGate(env, metadata, mr, repo.store, {
      skipCI: true,
    });
    if (!approval.allowed) {
      await env.DB.prepare(
        `UPDATE merge_queue SET state='blocked',reason=? WHERE id=? AND state IN ${queueActive}`,
      )
        .bind(approval.reasons.join("; ").slice(0, 1000), e.id)
        .run();
      return;
    }
    if (!e.candidate_sha) {
      // Detached preparation flushes Git objects but cannot publish any user-visible ref.
      const detached = new ForgeRepository(
        repo.store,
        { get: async () => undefined, put: async () => {} },
        { ...repo.refs },
        repo.defaultBranch,
        { rules: [] },
      );
      const candidate = await detached.mergeBranches({
        source_ref: e.source_sha,
        target_branch: e.target,
        expected_target_sha: e.target_sha,
        strategy: e.strategy,
        squash: !!e.squash,
        commit_message: "Merge !" + mr.id + ": " + mr.title,
        author: {
          name: "OneStorage merge queue",
          email: "merge@onestorage.invalid",
          timestamp: Math.floor(e.created_at / 1000),
        },
      });
      await env.DB.prepare(
        `UPDATE merge_queue SET candidate_sha=?,config_fingerprint=?,state='queued',reason='Preparing candidate pipeline' WHERE id=? AND state IN ${queueActive}`,
      )
        .bind(candidate.sha, config.hash, e.id)
        .run();
      return;
    }
    if (!e.run_id) {
      let raw = config.saved.config;
      if (config.saved.source_path) {
        filePath.parse(config.saved.source_path);
        const file = await repo.entry(e.target_sha, config.saved.source_path);
        const obj = await repo.store.get(file.entry.sha);
        if (obj.type !== "blob" || obj.data.length > 128 * 1024)
          fail(409, "Pipeline file unavailable or too large");
        try {
          raw = new TextDecoder("utf-8", { fatal: true }).decode(obj.data);
        } catch {
          fail(409, "Target pipeline file must contain UTF-8 JSON");
        }
      }
      let pipeline;
      try {
        pipeline = pipelineSchema.parse(JSON.parse(raw));
      } catch {
        fail(
          409,
          "Target pipeline configuration is invalid; correct it before retrying",
        );
      }
      validateDestinations(pipeline, env);
      const event = "merge-queue:" + e.id + ":" + e.generation;
      let run = await env.DB.prepare("SELECT id FROM ci_runs WHERE event_id=?")
        .bind(event)
        .first<{ id: string }>();
      if (!run) {
        const created = await enqueueRun(
          env,
          metadata,
          "merge/" + mr.id,
          e.candidate_sha,
          pipeline,
          "merge_request",
          e.actor_id,
          event,
          {
            source_trigger: "merge_request",
            config_path: config.saved.source_path || null,
            config_sha: config.saved.source_path ? e.target_sha : null,
          },
        );
        run =
          created ||
          (await env.DB.prepare("SELECT id FROM ci_runs WHERE event_id=?")
            .bind(event)
            .first<{ id: string }>());
      }
      if (!run) fail(409, "Candidate pipeline was not created");
      await env.DB.prepare(
        `UPDATE merge_queue SET run_id=?,state='checking',reason='Waiting for candidate CI' WHERE id=? AND state IN ${queueActive}`,
      )
        .bind(run.id, e.id)
        .run();
      return;
    }
    const ci = await env.DB.prepare(
      "SELECT id,status FROM ci_runs WHERE id=? AND repo_id=? AND sha=? AND parent_id IS NULL",
    )
      .bind(e.run_id, metadata.id, e.candidate_sha)
      .first<{ id: string; status: string }>();
    if (!ci || ["failed", "canceled"].includes(ci.status)) {
      fail(
        409,
        "Candidate pipeline failed or was canceled; cancel this entry and enqueue again after correcting it",
      );
      return;
    }
    if (ci.status !== "succeeded") {
      await env.DB.prepare(
        `UPDATE merge_queue SET state='checking',reason='Waiting for candidate CI' WHERE id=? AND state IN ${queueActive}`,
      )
        .bind(e.id)
        .run();
      return;
    }
    // A previously blocked head can resume after fresh reviews, without rebuilding an unchanged candidate.
    await env.DB.prepare(
      `UPDATE merge_queue SET state='checking',reason='Publishing verified candidate' WHERE id=? AND state IN ${queueActive}`,
    )
      .bind(e.id)
      .run();
    mr = await validateQueuePublication(env, metadata, repo, e, mr);
    await publish(e, mr);
  } catch (error) {
    if (
      error instanceof HTTPException &&
      [400, 403, 404, 409, 413, 429].includes(error.status)
    ) {
      await env.DB.prepare(
        `UPDATE merge_queue SET state='blocked',reason=? WHERE id=? AND state IN ${queueActive}`,
      )
        .bind(error.message.slice(0, 1000), e.id)
        .run();
    } else {
      console.error(
        "Merge queue retry",
        error instanceof Error ? error.name : "unknown",
      );
      // Preserve the intent, candidate and run identifiers on uncertain storage/queue results.
      throw error;
    }
  }
}
