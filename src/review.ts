import type { Env, Repo, User } from "./types";
import { repositoryRole, roleRank } from "./access";
import { fail } from "./security";
import type { ObjectStore, Refs } from "./git/objects";
export interface Protection {
  branch: string;
  require_mr: number;
  approvals: number;
  require_ci: number;
}
export async function reviewGate(env: Env, repo: Repo, mr: any) {
  const rule = await env.DB.prepare(
    "SELECT * FROM branch_protections WHERE repo_id=? AND branch=?",
  )
    .bind(repo.id, mr.target)
    .first<Protection>();
  const reviews = (
    await env.DB.prepare(
      "SELECT v.*,u.username,u.admin,u.disabled FROM merge_reviews v JOIN users u ON u.id=v.user_id WHERE mr_id=? ORDER BY v.id DESC LIMIT 200",
    )
      .bind(mr.id)
      .all<any>()
  ).results;
  const seen = new Set<string>();
  let approvals = 0,
    changes = 0;
  const decisions = (
    await env.DB.prepare(
      "SELECT v.*,u.username,u.admin,u.disabled FROM merge_reviews v JOIN users u ON u.id=v.user_id WHERE v.mr_id=? AND v.source_sha=? AND v.target_sha=? AND v.verdict!='comment' AND NOT EXISTS(SELECT 1 FROM merge_reviews newer WHERE newer.mr_id=v.mr_id AND newer.user_id=v.user_id AND newer.source_sha=v.source_sha AND newer.target_sha=v.target_sha AND newer.verdict!='comment' AND newer.id>v.id)",
    )
      .bind(mr.id, mr.source_sha, mr.target_sha)
      .all<any>()
  ).results;
  for (const r of decisions) {
    if (
      r.verdict === "comment" ||
      r.source_sha !== mr.source_sha ||
      r.target_sha !== mr.target_sha ||
      r.user_id === mr.author_id ||
      r.disabled ||
      seen.has(r.user_id)
    )
      continue;
    seen.add(r.user_id);
    if (
      roleRank[
        await repositoryRole(env, repo, {
          id: r.user_id,
          username: r.username,
          admin: r.admin,
        })
      ] < 2
    )
      continue;
    if (r.verdict === "approve") approvals++;
    else changes++;
  }
  const ci = await env.DB.prepare(
    "SELECT id,status FROM ci_runs WHERE repo_id=? AND sha=? ORDER BY rowid DESC LIMIT 1",
  )
    .bind(repo.id, mr.source_sha)
    .first<any>();
  const reasons: string[] = [];
  if (changes) reasons.push("Reviewer requested changes");
  if (approvals < (rule?.approvals || 0))
    reasons.push("Required approvals: " + rule!.approvals);
  if (rule?.require_ci && ci?.status !== "succeeded")
    reasons.push("Latest pipeline for this source commit must succeed");
  return {
    rule,
    approvals,
    changes,
    ci,
    reviews: reviews.map(({ admin, disabled, ...review }) => review),
    reasons,
    allowed: !reasons.length,
  };
}
export async function protectRefs(
  env: Env,
  repo: Repo,
  store: ObjectStore,
  before: Refs,
  after: Refs,
  merge?: any,
) {
  const rules = (
    await env.DB.prepare("SELECT * FROM branch_protections WHERE repo_id=?")
      .bind(repo.id)
      .all<Protection>()
  ).results;
  for (const rule of rules) {
    const ref = "refs/heads/" + rule.branch,
      old = before[ref],
      next = after[ref];
    if (old === next) continue;
    if (!next) fail(403, "Protected branch cannot be deleted: " + rule.branch);
    if (old && !(await store.ancestor(old, next)))
      fail(403, "Protected branch rejects force push: " + rule.branch);
    if (rule.require_mr || rule.approvals || rule.require_ci) {
      if (!merge || merge.target !== rule.branch)
        fail(
          403,
          "Protected branch requires a reviewed merge request: " + rule.branch,
        );
      const gate = await reviewGate(env, repo, merge);
      if (!gate.allowed) fail(409, gate.reasons.join("; "));
    }
  }
}
