import type { Env, Repo, User } from "./types";
import { repositoryRole, roleRank } from "./access";
import { fail } from "./security";
import { ObjectStore, text } from "./git/objects";
import type { ForgeRepository } from "./git/forge";
export const familySQL = `WITH RECURSIVE family(id) AS (SELECT ? UNION SELECT r.fork_source FROM repositories r JOIN family f ON r.id=f.id WHERE r.fork_source IS NOT NULL UNION SELECT r.id FROM repositories r JOIN family f ON r.fork_source=f.id)`;
export async function sameForkFamily(env: Env, target: string, source: string) {
  return !!(await env.DB.prepare(
    familySQL + " SELECT id FROM family WHERE id=?",
  )
    .bind(target, source)
    .first());
}
export async function activeRepo(env: Env, id: string) {
  return env.DB.prepare(
    "SELECT * FROM repositories WHERE id=? AND deleted_at IS NULL AND sync_status!='initializing'",
  )
    .bind(id)
    .first<Repo>();
}
export async function contributionSource(
  env: Env,
  target: Repo,
  source: Repo,
  user: User,
  refresh = false,
) {
  const sourceRole = roleRank[await repositoryRole(env, source, user)],
    targetRole = roleRank[await repositoryRole(env, target, user)];
  if (target.visibility !== "public" && targetRole < 1)
    fail(404, "Target repository not found");
  if (source.visibility !== "public" && sourceRole < 1)
    fail(404, "Source repository not found");
  if (
    sourceRole < 2 &&
    !(refresh && source.visibility === "public" && targetRole >= 3)
  )
    fail(403, "Write access to the source fork is required");
  if (!(await sameForkFamily(env, target.id, source.id)))
    fail(400, "Source and target must belong to the same fork family");
}
/** Copies an authorized, already committed snapshot while holding only the target DO queue.
 * No source DO call is made here, so reciprocal contributions cannot deadlock. */
export async function importContribution(
  env: Env,
  repo: ForgeRepository,
  target: Repo,
  b: {
    source_id: string;
    source_sha: string;
    actor_id: string;
    refresh?: boolean;
  },
) {
  const source = await activeRepo(env, b.source_id),
    user = await env.DB.prepare(
      "SELECT id,username,admin FROM users WHERE id=? AND disabled=0",
    )
      .bind(b.actor_id)
      .first<User>();
  if (!source || !user || source.id === target.id)
    fail(404, "Source fork unavailable");
  await contributionSource(env, target, source, user, !!b.refresh);
  const from = new ObjectStore(source.id, env.OBJECTS);
  const tip = await from.get(b.source_sha);
  if (tip.type !== "commit") fail(400, "Contribution must point to a commit");
  const graph = await from.walk([b.source_sha]);
  for (const oid of graph) repo.store.add(await from.get(oid));
  await repo.store.flush();
  for (const oid of graph) {
    const object = await from.get(oid);
    if (object.type !== "blob" || object.data.length > 1024) continue;
    const pointer = text(object.data).match(
      /^version https:\/\/git-lfs.github.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize (\d+)\n?$/,
    );
    if (!pointer) continue;
    const data = await env.OBJECTS.get(`lfs/${source.id}/${pointer[1]}`);
    if (data)
      await env.OBJECTS.put(`lfs/${target.id}/${pointer[1]}`, data.body, {
        onlyIf: { etagDoesNotMatch: "*" },
      });
  }
  return { sha: b.source_sha, objects: graph.size };
}
