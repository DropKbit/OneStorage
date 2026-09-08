import { protectRefs } from "./review";
import type { Env, Repo } from "./types";
import { GitClient } from "./git/client";
import { ObjectStore, Refs, checkRefs } from "./git/objects";
import { upstreamURL, upstreamSchema, genericHeaders } from "./sync-config";
import { githubHeaders } from "./github";
import { fail } from "./security";
import { EPHEMERAL } from "./git/namespaces";
import { forgeEvent, dispatchEvent } from "./events";
export async function upstreamClient(
  env: Env,
  repo: Repo,
  send: typeof fetch = fetch,
) {
  if (!repo.base_repo) fail(400, "Repository has no upstream configured");
  const base = upstreamSchema.parse(JSON.parse(repo.base_repo));
  const url = upstreamURL(base, env.SYNC_ALLOWED_HOSTS);
  const headers =
    base.provider === "github"
      ? base.mode === "public"
        ? {}
        : await githubHeaders(env, repo, base, send)
      : await genericHeaders(env, repo);
  return new GitClient(url, headers, (url, init) => send(url, init));
}
export function mirroredRefs(all: Refs, remote: Refs) {
  const result: Refs = Object.fromEntries(
    Object.entries(all).filter(
      ([r]) => r.startsWith(EPHEMERAL) || r.startsWith("refs/notes/"),
    ),
  );
  for (const [r, sha] of Object.entries(remote)) result[r] = sha;
  checkRefs(result);
  return result;
}
export async function scheduleSync(env: Env, repo: Repo) {
  if (!repo.base_repo) fail(400, "Repository has no upstream configured");
  const id = crypto.randomUUID();
  const inserted = await env.DB.prepare(
    "INSERT INTO sync_jobs(id,repo_id,direction,lease_until) SELECT ?,?,'pull',0 WHERE EXISTS(SELECT 1 FROM repositories WHERE id=? AND deleted_at IS NULL AND archived_at IS NULL)",
  )
    .bind(id, repo.id, repo.id)
    .run();
  if (!inserted.meta.changes) fail(409, "Repository archived or deleted");
  if (env.EVENTS) await env.EVENTS.send({ id: "sync:" + id });
  return { job_id: id, status: "pending" };
}
export async function publishSyncJobs(env: Env) {
  if (!env.EVENTS) return;
  const jobs = await env.DB.prepare(
    "SELECT id FROM sync_jobs WHERE status='pending' AND lease_until<=? ORDER BY created_at LIMIT 20",
  )
    .bind(Date.now())
    .all<{ id: string }>();
  for (const job of jobs.results)
    await env.EVENTS.send({ id: "sync:" + job.id });
}
export async function consumeSync(env: Env, id: string) {
  const job = await env.DB.prepare(
    "SELECT j.*,r.namespace,r.name,r.owner_id,r.default_branch FROM sync_jobs j JOIN repositories r ON r.id=j.repo_id WHERE j.id=? AND r.deleted_at IS NULL AND r.archived_at IS NULL",
  )
    .bind(id)
    .first<any>();
  if (!job || job.status !== "pending") return true;
  if (job.lease_until > Date.now()) return false;
  const leased = await env.DB.prepare(
    "UPDATE sync_jobs SET attempts=attempts+1,lease_until=? WHERE id=? AND status='pending' AND lease_until<=? RETURNING attempts",
  )
    .bind(Date.now() + 300000, id, Date.now())
    .first<{ attempts: number }>();
  if (!leased) return false;
  const response = await env.REPOSITORIES.get(
    env.REPOSITORIES.idFromName(job.repo_id),
  ).fetch("http://repository/internal/sync", {
    method: "POST",
    headers: {
      "x-repo-id": job.repo_id,
      "x-repo-owner-id": job.owner_id,
      "x-default-branch": job.default_branch,
    },
    body: JSON.stringify({ job_id: id }),
  });
  const ok = response.ok;
  await response.body?.cancel();
  await env.DB.prepare(
    "UPDATE sync_jobs SET status=?,error=?,lease_until=? WHERE id=? AND status='pending'",
  )
    .bind(
      ok ? "succeeded" : leased.attempts >= 5 ? "failed" : "pending",
      ok ? null : "Upstream sync failed; inspect repository sync status",
      ok ? 0 : Date.now() + 60000,
      id,
    )
    .run();
  return ok || leased.attempts >= 5;
}
/** Serialized by the DO; refs and immutable objects remain available after failed refreshes. */
export async function pullRepository(
  env: Env,
  storage: DurableObjectStorage,
  metadata: Repo,
  store: ObjectStore,
  connect = () => upstreamClient(env, metadata),
) {
  const id = metadata.id;
  const event = forgeEvent(id, "repo.sync.started", {
    is_first_sync: !metadata.synced_at,
  });
  await storage.put("event:" + event.id, event);
  await storage.setAlarm(Date.now() + 1000);
  await env.DB.prepare(
    "UPDATE repositories SET sync_status='syncing',sync_error=NULL WHERE id=?",
  )
    .bind(id)
    .run();
  try {
    const client = await connect(),
      remote = await client.pull(store);
    await store.flush();
    const before = (await storage.get<Refs>("refs.v2")) || {},
      after = mirroredRefs(before, remote.refs);
    await protectRefs(env, metadata, store, before, after);
    const success = forgeEvent(id, "repo.sync.succeeded", {
      is_first_sync: !metadata.synced_at,
      refs: remote.refs,
    });
    await storage.put({ "refs.v2": after, ["event:" + success.id]: success });
    if (
      remote.defaultBranch &&
      remote.refs["refs/heads/" + remote.defaultBranch]
    ) {
      await storage.put("default-branch", remote.defaultBranch);
      await env.DB.prepare(
        "UPDATE repositories SET default_branch=? WHERE id=?",
      )
        .bind(remote.defaultBranch, id)
        .run();
    }
    await env.DB.prepare(
      "UPDATE repositories SET sync_status='idle',sync_error=NULL,synced_at=datetime('now') WHERE id=?",
    )
      .bind(id)
      .run();
    await storage.delete("sync-reconcile");
    return { refs: remote.refs, status: "idle" };
  } catch (e) {
    const error = (e as any).status
      ? (e as Error).message
      : "Upstream sync failed";
    const failed = forgeEvent(id, "repo.sync.failed", { error });
    await storage.put("event:" + failed.id, failed);
    await env.DB.prepare(
      "UPDATE repositories SET sync_status='failed',sync_error=? WHERE id=?",
    )
      .bind(error, id)
      .run();
    throw e;
  }
}
