import MarkdownIt from "markdown-it";
import type { Env, Repo } from "./types";
import { ObjectStore, LIMITS, parseCommit, bytes } from "./git/objects";
import { fail } from "./security";

const markdown = new MarkdownIt({ html: true, linkify: false });
/** Only prose, excluding quoted text, code and HTML, can close same-project issues. */
export function closingIssueIds(description: string) {
  const ids = new Set<number>();
  let quoted = 0;
  for (const token of markdown.parse(description, {})) {
    if (token.type === "blockquote_open") quoted++;
    else if (token.type === "blockquote_close") quoted--;
    else if (token.type === "inline" && !quoted) {
      const prose = (token.children || [])
        .map((t) => (t.type === "text" ? t.content : "\n"))
        .join("");
      const pattern =
        /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+(#[1-9][0-9]*(?![\w/])(?:(?:\s*,\s*(?:and\s+)?|\s+and\s+)#[1-9][0-9]*(?![\w/]))*)/gi;
      for (const match of prose.matchAll(pattern))
        for (const reference of match[1].matchAll(/#([1-9][0-9]*)/g)) {
          const id = Number(reference[1]);
          if (Number.isSafeInteger(id)) ids.add(id);
          if (ids.size > 100)
            fail(413, "At most 100 closing issue references per merge request");
        }
    }
  }
  return [...ids];
}
export async function plannedIssueClosures(
  env: Env,
  repo: Repo,
  mr: any,
  store: ObjectStore,
  defaultBranch: string,
) {
  if (mr.target !== defaultBranch || mr.state !== "open") return [] as number[];
  const excluded = new Set<string>(),
    todo = [mr.target_sha];
  while (todo.length) {
    const oid = todo.pop()!;
    if (excluded.has(oid)) continue;
    excluded.add(oid);
    if (excluded.size > LIMITS.graph)
      fail(413, "Issue closing commit graph exceeded");
    todo.push(...parseCommit(await store.get(oid)).parents);
  }
  const ids = new Set(closingIssueIds(mr.body)),
    seen = new Set<string>();
  let size = bytes(mr.body).length;
  todo.push(mr.source_sha);
  while (todo.length) {
    const oid = todo.pop()!;
    if (excluded.has(oid) || seen.has(oid)) continue;
    seen.add(oid);
    if (seen.size > LIMITS.graph)
      fail(413, "Issue closing commit graph exceeded");
    const commit = parseCommit(await store.get(oid));
    size += bytes(commit.message).length;
    if (size > 1024 * 1024) fail(413, "Issue closing messages exceed 1 MiB");
    for (const id of closingIssueIds(commit.message)) ids.add(id);
    if (ids.size > 100)
      fail(413, "At most 100 closing issue references per merge request");
    todo.push(...commit.parents);
  }
  const result: number[] = [];
  // D1 has a 100-bind limit; bounded batches also work for the maximum 100 references.
  const values = [...ids];
  for (let i = 0; i < values.length; i += 90) {
    const part = values.slice(i, i + 90);
    const rows = await env.DB.prepare(
      `SELECT id FROM issues WHERE repo_id=? AND id IN(${part.map(() => "?").join(",")}) ORDER BY id`,
    )
      .bind(repo.id, ...part)
      .all<{ id: number }>();
    result.push(...rows.results.map((r) => r.id));
  }
  return result;
}
export interface MergeResult {
  sha: string;
  issue_ids?: number[];
  actor_id?: string;
  queue_id?: number;
}
/** D1 projection is atomic and repeatable; durable refs/result remain the source of truth. */
export async function projectMerge(
  env: Env,
  repoId: string,
  mrId: number,
  result: MergeResult,
) {
  const statements = [
    env.DB.prepare(
      "UPDATE merge_requests SET state='merged',merged_sha=? WHERE id=? AND repo_id=?",
    ).bind(result.sha, mrId, repoId),
  ];
  if (result.queue_id)
    statements.push(
      env.DB.prepare(
        "UPDATE merge_queue SET state='merged',reason='',merged_sha=?,finished_at=? WHERE id=? AND mr_id=? AND repo_id=?",
      ).bind(result.sha, Date.now(), result.queue_id, mrId, repoId),
    );
  if (result.issue_ids?.length)
    statements.push(
      env.DB.prepare(
        "INSERT OR IGNORE INTO merge_issue_closures(mr_id,issue_id,sha,actor_id) SELECT ?,i.id,?,? FROM issues i JOIN json_each(?) j ON i.id=j.value WHERE i.repo_id=?",
      ).bind(
        mrId,
        result.sha,
        result.actor_id!,
        JSON.stringify(result.issue_ids),
        repoId,
      ),
    );
  await env.DB.batch(statements);
}
