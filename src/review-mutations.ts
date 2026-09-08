import type { Env, Repo, User } from "./types";
import type { ForgeRepository } from "./git/forge";
import { repositoryRole, roleRank } from "./access";
import { fail, sha } from "./security";
import { z } from "zod";
import { text } from "./git/objects";
const id = z.coerce.number().int().positive();
const actor = z.string().min(1).max(100);
const version = { source_sha: sha, target_sha: sha };
export async function reviewActor(env: Env, repo: Repo, actorId: string) {
  const user = await env.DB.prepare(
    "SELECT id,username,admin FROM users WHERE id=? AND disabled=0",
  )
    .bind(actorId)
    .first<User>();
  if (!user) fail(401, "Sign in required");
  const rank = roleRank[await repositoryRole(env, repo, user)];
  if (repo.visibility !== "public" && rank < 1)
    fail(404, "Repository not found");
  return { user, rank };
}
/** Called inside the target repository DO queue, shared with ref publication. */
export async function reviewMutation(
  env: Env,
  repo: ForgeRepository,
  metadata: Repo,
  path: string,
  raw: unknown,
) {
  const header = z.object({ id, actor_id: actor }).parse(raw),
    { user, rank } = await reviewActor(env, metadata, header.actor_id),
    mr = await env.DB.prepare(
      "SELECT * FROM merge_requests WHERE repo_id=? AND id=?",
    )
      .bind(metadata.id, header.id)
      .first<any>();
  if (!mr) fail(404, "Merge request not found");
  if (path === "/review-update") {
    const b = z
      .object({
        revision: z.number().int().min(0),
        state: z.enum(["open", "closed"]).optional(),
        title: z.string().trim().min(1).max(240).optional(),
        body: z.string().max(20000).optional(),
        source_sha: sha.optional(),
        target_sha: sha.optional(),
      })
      .parse(raw);
    if (user.id !== mr.author_id && rank < 3)
      fail(403, "Author or maintainer required");
    if (mr.state === "merged" || mr.revision !== b.revision)
      fail(409, "Merge request changed; refresh");
    await env.DB.prepare(
      "UPDATE merge_requests SET state=?,title=?,body=?,source_sha=?,target_sha=?,revision=revision+1 WHERE id=? AND revision=? AND state!='merged'",
    )
      .bind(
        b.state || mr.state,
        b.title ?? mr.title,
        b.body ?? mr.body,
        b.source_sha || mr.source_sha,
        b.target_sha || mr.target_sha,
        mr.id,
        b.revision,
      )
      .run();
    return { ok: true };
  }
  if (mr.state !== "open") fail(409, "Merge request is closed");
  if (path === "/review-submit") {
    const b = z
      .object({
        ...version,
        verdict: z.enum(["approve", "changes", "comment"]),
        body: z.string().max(20000).default(""),
      })
      .parse(raw);
    if (b.source_sha !== mr.source_sha || b.target_sha !== mr.target_sha)
      fail(409, "Review version changed; refresh");
    if (b.verdict !== "comment" && (user.id === mr.author_id || rank < 2))
      fail(403, "An independent developer must review");
    return env.DB.prepare(
      "INSERT INTO merge_reviews(mr_id,user_id,source_sha,target_sha,verdict,body) VALUES(?,?,?,?,?,?) RETURNING *",
    )
      .bind(mr.id, user.id, b.source_sha, b.target_sha, b.verdict, b.body)
      .first();
  }
  if (path === "/review-discussion") {
    const b = z
      .object({
        ...version,
        body: z.string().trim().min(1).max(20000),
        path: z.string().min(1).max(1000).optional(),
        side: z.enum(["old", "new"]).optional(),
        line: z.number().int().min(1).max(1000000).optional(),
      })
      .parse(raw);
    if (b.source_sha !== mr.source_sha || b.target_sha !== mr.target_sha)
      fail(409, "Discussion version changed; refresh");
    if (
      (b.path !== undefined || b.side !== undefined || b.line !== undefined) &&
      !(b.path && b.side && b.line)
    )
      fail(400, "A line discussion requires path, side and line");
    if (b.path) {
      const file = await repo.entry(
        b.side === "old" ? mr.target_sha : mr.source_sha,
        b.path,
      );
      if (file.entry.type !== "blob") fail(400, "Discussion requires a file");
      const object = await repo.store.get(file.entry.sha);
      if (object.data.includes(0))
        fail(400, "Binary files use general discussions");
      const content = text(object.data);
      const count = content
        ? content.split("\n").length - (content.endsWith("\n") ? 1 : 0)
        : 0;
      if (b.line! > count) fail(400, "Line is outside the reviewed file");
    }
    const discussion = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO merge_discussions(id,mr_id,author_id,source_sha,target_sha,path,side,line) VALUES(?,?,?,?,?,?,?,?)",
      ).bind(
        discussion,
        mr.id,
        user.id,
        mr.source_sha,
        mr.target_sha,
        b.path || null,
        b.side || null,
        b.line || null,
      ),
      env.DB.prepare(
        "INSERT INTO merge_discussion_comments(discussion_id,author_id,body) VALUES(?,?,?)",
      ).bind(discussion, user.id, b.body),
    ]);
    return { id: discussion };
  }
  const b = z
      .object({
        discussion: z.string().uuid(),
        body: z.string().trim().min(1).max(20000).optional(),
        resolved: z.boolean().optional(),
      })
      .parse(raw),
    thread = await env.DB.prepare(
      "SELECT * FROM merge_discussions WHERE id=? AND mr_id=?",
    )
      .bind(b.discussion, mr.id)
      .first<any>();
  if (!thread) fail(404, "Discussion not found");
  if (path === "/review-reply") {
    if (!b.body) fail(400, "Reply required");
    return env.DB.prepare(
      "INSERT INTO merge_discussion_comments(discussion_id,author_id,body) VALUES(?,?,?) RETURNING *",
    )
      .bind(thread.id, user.id, b.body)
      .first();
  }
  if (b.resolved === undefined) fail(400, "Resolution required");
  if (user.id !== thread.author_id && user.id !== mr.author_id && rank < 2)
    fail(403, "Discussion author, merge author or developer required");
  await env.DB.prepare(
    "UPDATE merge_discussions SET resolved=?,resolved_by=? WHERE id=?",
  )
    .bind(+b.resolved, b.resolved ? user.id : null, thread.id)
    .run();
  return { ok: true };
}
