import type { Env, Repo, User } from "./types";
import { repositoryRole, roleRank } from "./access";
import { fail } from "./security";
import { ObjectStore, type Refs } from "./git/objects";
import { codeownerGate } from "./codeowners";
export interface Protection {
  branch: string;
  require_mr: number;
  approvals: number;
  require_ci: number;
  require_resolved?: number;
  require_codeowners?: number;
  require_queue?: number;
}
export async function reviewGate(
  env: Env,
  repo: Repo,
  mr: any,
  store?: ObjectStore,
  options: { skipCI?: boolean; queueRun?: { id: string; sha: string } } = {},
) {
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
  const seen = new Set<string>(),
    approved = new Set<string>();
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
    if (r.verdict === "approve") {
      approvals++;
      approved.add(r.user_id);
    } else changes++;
  }
  const ci = options.queueRun
    ? await env.DB.prepare(
        "SELECT id,status FROM ci_runs WHERE id=? AND repo_id=? AND sha=? AND parent_id IS NULL AND trigger='merge_request'",
      )
        .bind(options.queueRun.id, repo.id, options.queueRun.sha)
        .first<any>()
    : await env.DB.prepare(
        "SELECT id,status FROM ci_runs WHERE repo_id=? AND sha=? AND parent_id IS NULL ORDER BY rowid DESC LIMIT 1",
      )
        .bind(repo.id, mr.source_sha)
        .first<any>();
  const unresolved =
    (
      await env.DB.prepare(
        "SELECT count(*) AS n FROM merge_discussions d JOIN users u ON u.id=d.author_id WHERE d.mr_id=? AND d.resolved=0 AND u.disabled=0 AND ((? IS NULL AND u.id=?) OR EXISTS(SELECT 1 FROM members m WHERE m.repo_id=? AND m.user_id=u.id AND m.role IN('developer','maintainer','owner')) OR EXISTS(SELECT 1 FROM workspace_members w WHERE w.workspace_id=? AND w.user_id=u.id AND w.role IN('developer','maintainer','owner')))",
      )
        .bind(
          mr.id,
          repo.workspace_id || null,
          repo.owner_id,
          repo.id,
          repo.workspace_id || null,
        )
        .first<{ n: number }>()
    )?.n || 0;
  const reasons: string[] = [];
  if (rule?.require_resolved && unresolved)
    reasons.push("Unresolved discussions: " + unresolved);
  if (changes) reasons.push("Reviewer requested changes");
  if (approvals < (rule?.approvals || 0))
    reasons.push("Required approvals: " + rule!.approvals);
  if (
    !options.skipCI &&
    (rule?.require_ci || options.queueRun) &&
    ci?.status !== "succeeded"
  )
    reasons.push(
      options.queueRun
        ? "Queue candidate pipeline must succeed"
        : "Latest pipeline for this source commit must succeed",
    );
  const codeowners = rule?.require_codeowners
    ? await codeownerGate(
        env,
        repo,
        mr,
        approved,
        store || new ObjectStore(repo.id, env.OBJECTS),
      )
    : null;
  if (codeowners && !codeowners.allowed) {
    reasons.push(...codeowners.errors.map((e) => "CODEOWNERS: " + e));
    for (const r of codeowners.requirements)
      if (!r.allowed)
        reasons.push(
          `CODEOWNERS ${r.section} (${r.pattern}): ${r.approved.length}/${r.required} approvals${r.eligible.length ? "" : "; no eligible independent owners"}`,
        );
  }
  return {
    codeowners,
    rule,
    unresolved,
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
    if (
      rule.require_mr ||
      rule.approvals ||
      rule.require_ci ||
      rule.require_resolved ||
      rule.require_codeowners ||
      rule.require_queue
    ) {
      if (!merge || merge.target !== rule.branch)
        fail(
          403,
          "Protected branch requires a reviewed merge request: " + rule.branch,
        );
      if (rule.require_queue && !merge.queue_entry)
        fail(403, "Protected branch requires the merge queue: " + rule.branch);
      if (merge.queue_entry && merge.queue_entry.candidate_sha !== next)
        fail(409, "Queue must publish the tested candidate");
      const gate = await reviewGate(
        env,
        repo,
        merge,
        store,
        merge.queue_entry
          ? { queueRun: { id: merge.queue_entry.run_id, sha: next } }
          : {},
      );
      if (!gate.allowed) fail(409, gate.reasons.join("; "));
    }
  }
}
