import type { Env, Repo } from "./types";
import { fail } from "./security";
/** Serialized by the repository DO. Project-scoped writes also carry the lifecycle snapshot. */
export async function transferProject(
  env: Env,
  repo: Repo,
  actor: string,
  namespace: string,
  name: string,
  revision: number,
) {
  const targetUser = await env.DB.prepare(
    "SELECT id,username FROM users WHERE username=? AND id=? AND disabled=0",
  )
    .bind(namespace, actor)
    .first<{ id: string; username: string }>();
  const targetSpace = targetUser
    ? null
    : await env.DB.prepare(
        "SELECT w.id,w.slug FROM workspaces w JOIN workspace_members m ON m.workspace_id=w.id JOIN users u ON u.id=m.user_id WHERE w.slug=? AND m.user_id=? AND m.role='owner' AND u.disabled=0",
      )
        .bind(namespace, actor)
        .first<{ id: string; slug: string }>();
  if (!targetUser && !targetSpace)
    fail(
      403,
      "Destination must be your personal namespace or a workspace you own",
    );
  const destination = targetUser?.username || targetSpace!.slug;
  if (
    repo.namespace.toLowerCase() === destination.toLowerCase() &&
    repo.name.toLowerCase() === name.toLowerCase()
  )
    fail(400, "Project already has this address");
  const crossing = repo.namespace.toLowerCase() !== destination.toLowerCase();
  const guard = crypto.randomUUID(),
    detail = JSON.stringify({
      from: repo.namespace + "/" + repo.name,
      to: destination + "/" + name,
    });
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO mutation_guards(id,accepted) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM repositories r JOIN users u ON u.id=? WHERE r.id=? AND r.deleted_at IS NULL AND r.lifecycle_revision=? AND ((r.workspace_id IS NULL AND r.owner_id=u.id) OR EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=r.workspace_id AND m.user_id=u.id AND m.role='owner')) AND ((? IS NULL AND u.username=?) OR EXISTS(SELECT 1 FROM workspaces w JOIN workspace_members m ON m.workspace_id=w.id WHERE w.id=? AND w.slug=? AND m.user_id=u.id AND m.role='owner')) AND u.disabled=0) THEN 1 ELSE 0 END`,
      ).bind(
        guard,
        actor,
        repo.id,
        revision,
        targetSpace?.id || null,
        destination,
        targetSpace?.id || null,
        destination,
      ),
      env.DB.prepare(
        "DELETE FROM repository_aliases WHERE namespace=? AND name=? AND repo_id=?",
      ).bind(destination, name, repo.id),
      // Temporary unfreezing is visible only within this transaction, permitting credential revocation on an archived project.
      env.DB.prepare(
        "UPDATE repositories SET archived_at=NULL WHERE id=?",
      ).bind(repo.id),
      ...(crossing
        ? [
            env.DB.prepare(
              "UPDATE ci_runs SET status='canceled',error='Project transferred',finished_at=datetime('now'),lease_hash=NULL,lease_until=NULL WHERE repo_id=? AND status IN('queued','running')",
            ).bind(repo.id),
            env.DB.prepare(
              "UPDATE sync_jobs SET status='cancelled',error='Project transferred',lease_until=0 WHERE repo_id=? AND status='pending'",
            ).bind(repo.id),
            env.DB.prepare("DELETE FROM ci_runners WHERE repo_id=?").bind(
              repo.id,
            ),
            env.DB.prepare("DELETE FROM git_credentials WHERE repo_id=?").bind(
              repo.id,
            ),
            env.DB.prepare("DELETE FROM webhooks WHERE repo_id=?").bind(
              repo.id,
            ),
            env.DB.prepare(
              "UPDATE ci_pipelines SET enabled=0 WHERE repo_id=?",
            ).bind(repo.id),
            env.DB.prepare(
              "UPDATE environments SET public=0,updated_at=datetime('now') WHERE repo_id=?",
            ).bind(repo.id),
          ]
        : [
            env.DB.prepare(
              "UPDATE sync_jobs SET lifecycle_revision=? WHERE repo_id=? AND status='pending'",
            ).bind(revision + 1, repo.id),
          ]),
      env.DB.prepare(
        "INSERT INTO repository_aliases(namespace,name,repo_id) SELECT namespace,name,id FROM repositories WHERE id=?",
      ).bind(repo.id),
      env.DB.prepare(
        "UPDATE repositories SET namespace=?,name=?,workspace_id=?,owner_id=?,base_repo=?,sync_status=?,sync_error=?,synced_at=?,archived_at=?,lifecycle_revision=lifecycle_revision+1 WHERE id=?",
      ).bind(
        destination,
        name,
        targetSpace?.id || null,
        crossing ? actor : repo.owner_id,
        crossing ? null : repo.base_repo || null,
        crossing ? "idle" : repo.sync_status || "idle",
        crossing ? null : repo.sync_error || null,
        crossing ? null : repo.synced_at || null,
        repo.archived_at || null,
        repo.id,
      ),
      env.DB.prepare(
        "INSERT INTO audit(repo_id,actor_id,action,detail) VALUES(?,?,?,?)",
      ).bind(
        repo.id,
        actor,
        crossing ? "repo.transfer" : "repo.rename",
        detail,
      ),
      env.DB.prepare("DELETE FROM mutation_guards WHERE id=?").bind(guard),
    ]);
  } catch (error) {
    if (error instanceof Error && /CHECK constraint failed/.test(error.message))
      fail(
        409,
        "Project or namespace ownership changed; reload before transferring",
      );
    if (
      error instanceof Error &&
      /UNIQUE constraint failed|Repository address reserved/.test(error.message)
    )
      fail(409, "Destination address is already in use or reserved");
    throw error;
  }
  return env.DB.prepare("SELECT * FROM repositories WHERE id=?")
    .bind(repo.id)
    .first<Repo>();
}
export async function repositoryAt(env: Env, namespace: string, name: string) {
  const direct = await env.DB.prepare(
    "SELECT * FROM repositories WHERE namespace=? AND name=? AND deleted_at IS NULL",
  )
    .bind(namespace, name)
    .first<Repo>();
  if (direct) return { repo: direct, moved: false };
  const moved = await env.DB.prepare(
    "SELECT r.* FROM repositories r JOIN repository_aliases a ON a.repo_id=r.id WHERE a.namespace=? AND a.name=? AND r.deleted_at IS NULL",
  )
    .bind(namespace, name)
    .first<Repo>();
  return moved ? { repo: moved, moved: true } : null;
}
