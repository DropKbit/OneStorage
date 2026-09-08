import type { Env, Repo, User } from "./types";
export const roleRank: Record<string, number> = {
  guest: 0,
  reader: 1,
  developer: 2,
  maintainer: 3,
  owner: 4,
};
export async function repositoryRole(
  env: Env,
  repo: Repo,
  user: User | null,
): Promise<string> {
  if (!user) return "guest";
  if (!repo.workspace_id && user.id === repo.owner_id) return "owner";
  const direct = await env.DB.prepare(
    "SELECT role FROM members WHERE repo_id=? AND user_id=?",
  )
    .bind(repo.id, user.id)
    .first<{ role: string }>();
  if (!repo.workspace_id) return direct?.role || "guest";
  const inherited = await env.DB.prepare(
    "SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=?",
  )
    .bind(repo.workspace_id, user.id)
    .first<{ role: string }>();
  return roleRank[inherited?.role || "guest"] >
    roleRank[direct?.role || "guest"]
    ? inherited!.role
    : direct?.role || "guest";
}
