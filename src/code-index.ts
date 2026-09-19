import { semanticConfigured } from "./semantic";
import type { Env, Repo } from "./types";
import type { ForgeRepository } from "./git/forge";
import { parseCommit, parseTree, bytes } from "./git/objects";
import { codeGrams, codeFold } from "./code-search";
import { digest } from "./security";

export const CODE_LIMITS = {
  fileBytes: 256 * 1024,
  fileGrams: 65536,
  files: 10000,
  bytes: 64 * 1024 * 1024,
  postings: 2_000_000,
  depth: 64,
  pathBytes: 1000,
};
interface Walk {
  stack: { tree: string; path: string; offset: number }[];
  skipped: Record<string, number>;
  reused_files?: number;
  created_contents?: number;
  written_postings?: number;
  unscanned?: boolean;
  limit?: string;
}
interface IndexState {
  repo_id: string;
  index_version: number;
  build_version: number;
  content_epoch: string;
  build_epoch: string | null;
  requested: number;
  completed: number;
  force_rebuild: number;
  gc_pending: number;
  generation: string | null;
  indexed_sha: string | null;
  indexed_branch: string | null;
  build_generation: string | null;
  build_sha: string | null;
  build_branch: string | null;
  build_request: number | null;
  cursor: string | null;
  files: number;
  indexed_files: number;
  skipped_files: number;
  bytes: number;
  postings: number;
}
/** D1 is the durable intent. Event replay may increment the request but never rolls a snapshot backwards. */
export async function stageCodeIndex(env: Env, repoId: string, ref?: string) {
  await env.DB.prepare(
    `INSERT INTO code_index_state(repo_id) SELECT id FROM repositories WHERE id=? AND deleted_at IS NULL AND (? IS NULL OR ?='refs/heads/'||default_branch)
    ON CONFLICT(repo_id) DO UPDATE SET requested=requested+1,status=CASE WHEN build_generation IS NULL THEN 'queued' ELSE 'indexing' END`,
  )
    .bind(repoId, ref || null, ref || null)
    .run();
}
/** Recover missed wakeups and backfill existing projects without a fixed project ceiling. */
export async function publishCodeIndexes(env: Env) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO code_index_state(repo_id) SELECT r.id FROM repositories r WHERE r.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM code_index_state s WHERE s.repo_id=r.id) ORDER BY r.id LIMIT 50`,
  ).run();
  const pending = (
    await env.DB.prepare(
      `SELECT s.repo_id,r.lifecycle_revision FROM code_index_state s JOIN repositories r ON r.id=s.repo_id WHERE r.deleted_at IS NULL AND r.sync_status!='initializing' AND (s.index_version<2 OR s.requested>s.completed OR s.build_generation IS NOT NULL OR s.gc_pending=1) ORDER BY s.checked_at,s.repo_id LIMIT 20`,
    ).all<{ repo_id: string; lifecycle_revision: number }>()
  ).results;
  for (let i = 0; i < pending.length; i += 2)
    await Promise.allSettled(
      pending.slice(i, i + 2).map(async (r) => {
        // Rotate attempts before RPC, including unavailable DOs; later projects must not starve.
        await env.DB.prepare(
          "UPDATE code_index_state SET checked_at=? WHERE repo_id=?",
        )
          .bind(Date.now(), r.repo_id)
          .run();
        const response = await env.REPOSITORIES.get(
          env.REPOSITORIES.idFromName(r.repo_id),
        ).fetch(
          new Request("http://repository/internal/code-index-wake", {
            method: "POST",
            headers: {
              "x-repo-id": r.repo_id,
              "x-lifecycle-revision": String(r.lifecycle_revision),
            },
          }),
        );
        await response.body?.cancel();
        if (!response.ok) throw Error("Index wakeup unavailable");
      }),
    );
}
/** Delete only unreferenced content, after bounded obsolete path cleanup. */
export async function collectCodeIndex(env: Env, repoId: string) {
  const paths = await env.DB.prepare(
    `DELETE FROM code_documents WHERE id IN(SELECT d.id FROM code_documents d JOIN code_index_state s ON s.repo_id=d.repo_id WHERE d.repo_id=? AND d.generation!=coalesce(s.generation,'') AND d.generation!=coalesce(s.build_generation,'') LIMIT 5)`,
  )
    .bind(repoId)
    .run();
  if (paths.meta.changes) return true;
  const contents = await env.DB.prepare(
    `DELETE FROM code_contents WHERE id IN(SELECT c.id FROM code_contents c WHERE c.repo_id=? AND NOT EXISTS(SELECT 1 FROM code_documents d WHERE d.content_id=c.id) LIMIT 5)`,
  )
    .bind(repoId)
    .run();
  return !!contents.meta.changes;
}
/** Run behind the repository DO writer gate, with the same immutable R2 store as ordinary Git reads. */
export async function advanceCodeIndex(
  env: Env,
  metadata: Repo,
  repo: ForgeRepository,
): Promise<boolean> {
  const s = await env.DB.prepare(
    "SELECT * FROM code_index_state WHERE repo_id=?",
  )
    .bind(metadata.id)
    .first<IndexState>();
  if (!s) return false;
  const sha = repo.refs["refs/heads/" + metadata.default_branch] || null;
  // Each cleanup step deletes a bounded number of documents; FK postings have a deletion index.
  if (s.gc_pending) {
    if (!(await collectCodeIndex(env, metadata.id)))
      await env.DB.prepare(
        "UPDATE code_index_state SET gc_pending=0 WHERE repo_id=?",
      )
        .bind(metadata.id)
        .run();
  }
  if (
    !s.build_generation &&
    s.requested <= s.completed &&
    s.index_version === 2
  ) {
    await env.DB.prepare(
      "UPDATE code_index_state SET status=CASE WHEN json_extract(coverage,'$.partial')=1 THEN 'partial' ELSE 'ready' END,error=NULL WHERE repo_id=? AND requested<=completed AND build_generation IS NULL",
    )
      .bind(metadata.id)
      .run();
    return !!s.gc_pending;
  }
  if (
    !s.build_generation ||
    s.build_branch !== metadata.default_branch ||
    s.build_version !== 2
  ) {
    if (
      s.index_version === 2 &&
      s.generation &&
      s.indexed_sha === sha &&
      s.indexed_branch === metadata.default_branch &&
      !s.force_rebuild
    ) {
      await env.DB.prepare(
        `UPDATE code_index_state SET completed=?,status=CASE WHEN json_extract(coverage,'$.partial')=1 THEN 'partial' ELSE 'ready' END,error=NULL WHERE repo_id=? AND requested=?`,
      )
        .bind(s.requested, metadata.id, s.requested)
        .run();
      return !!s.gc_pending;
    }
    const root = sha ? parseCommit(await repo.store.get(sha)).tree : null;
    const cursor: Walk = {
      stack: root ? [{ tree: root, path: "", offset: 0 }] : [],
      skipped: {},
    };
    await env.DB.prepare(
      `UPDATE code_index_state SET build_generation=?,build_sha=?,build_branch=?,build_request=?,cursor=?,build_version=2,build_epoch=?,force_rebuild=0,files=0,indexed_files=0,skipped_files=0,bytes=0,postings=0,status='indexing',error=NULL,gc_pending=1,checked_at=? WHERE repo_id=? AND requested=? AND force_rebuild=? AND EXISTS(SELECT 1 FROM repositories WHERE id=repo_id AND default_branch=? AND deleted_at IS NULL)`,
    )
      .bind(
        crypto.randomUUID(),
        sha,
        metadata.default_branch,
        s.requested,
        JSON.stringify(cursor),
        s.force_rebuild
          ? crypto.randomUUID()
          : s.build_epoch || s.content_epoch,
        Date.now(),
        metadata.id,
        s.requested,
        s.force_rebuild,
        metadata.default_branch,
      )
      .run();
    return true;
  }
  const cursor = JSON.parse(s.cursor!) as Walk,
    documents: {
      id: string;
      path: string;
      sha: string;
      content: string;
      extension: string;
    }[] = [];
  const contents = new Map<
    string,
    {
      id: string;
      sha: string;
      body?: string;
      bytes: number;
      grams: number;
      values?: string[];
    }
  >();
  let lastTree:
    { sha: string; entries: ReturnType<typeof parseTree> } | undefined;
  let visited = 0,
    filesThisStep = 0;
  const skip = (reason: string) => {
    cursor.skipped[reason] = (cursor.skipped[reason] || 0) + 1;
    s.skipped_files++;
  };
  while (cursor.stack.length && visited++ < 256 && filesThisStep < 8) {
    const top = cursor.stack.at(-1)!;
    if (lastTree?.sha !== top.tree) {
      const tree = await repo.store.get(top.tree);
      if (tree.type !== "tree") throw Error("Code index expected a Git tree");
      lastTree = { sha: top.tree, entries: parseTree(tree.data) };
    }
    const entry = lastTree.entries[top.offset++];
    if (!entry) {
      cursor.stack.pop();
      continue;
    }
    const path = top.path + entry.name;
    if (bytes(path).length > CODE_LIMITS.pathBytes) {
      if (entry.type === "tree") cursor.unscanned = true;
      skip("long_path");
      continue;
    }
    try {
      repo.path(path);
    } catch {
      if (entry.type === "tree") cursor.unscanned = true;
      skip("unsupported_path");
      continue;
    }
    if (entry.type === "tree") {
      if (cursor.stack.length >= CODE_LIMITS.depth) {
        cursor.unscanned = true;
        skip("depth");
        continue;
      }
      cursor.stack.push({ tree: entry.sha, path: path + "/", offset: 0 });
      continue;
    }
    if (s.files >= CODE_LIMITS.files) {
      cursor.unscanned = true;
      cursor.limit = "files";
      cursor.stack = [];
      break;
    }
    s.files++;
    filesThisStep++;
    if (!["100644", "100755"].includes(entry.mode)) {
      skip("non_regular");
      continue;
    }
    let content =
      contents.get(entry.sha) ||
      (await env.DB.prepare(
        "SELECT id,blob_sha AS sha,bytes,grams FROM code_contents WHERE repo_id=? AND epoch=? AND blob_sha=?",
      )
        .bind(metadata.id, s.build_epoch, entry.sha)
        .first<{
          id: string;
          sha: string;
          body?: string;
          bytes: number;
          grams: number;
          values?: string[];
        }>());
    const reused = !!content;
    if (!content) {
      const hint = repo.store.index?.get(entry.sha);
      if (hint && hint.size > CODE_LIMITS.fileBytes) {
        skip("large_file");
        continue;
      }
      const obj = await repo.store.get(entry.sha);
      if (obj.type !== "blob") throw Error("Code index expected a Git blob");
      if (obj.data.length > CODE_LIMITS.fileBytes) {
        skip("large_file");
        continue;
      }
      if (obj.data.includes(0)) {
        skip("binary");
        continue;
      }
      let body: string;
      try {
        body = new TextDecoder("utf-8", { fatal: true }).decode(obj.data);
      } catch {
        skip("invalid_utf8");
        continue;
      }
      const values = codeGrams(body);
      if (values.length > CODE_LIMITS.fileGrams) {
        skip("complex_file");
        continue;
      }
      content = {
        id: await digest(metadata.id + "\0" + s.build_epoch + "\0" + entry.sha),
        sha: entry.sha,
        body,
        bytes: obj.data.length,
        grams: values.length,
        values,
      };
    }
    if (
      s.bytes + content.bytes > CODE_LIMITS.bytes ||
      s.postings + content.grams > CODE_LIMITS.postings
    ) {
      cursor.unscanned = true;
      cursor.limit =
        s.bytes + content.bytes > CODE_LIMITS.bytes ? "bytes" : "postings";
      cursor.stack = [];
      skip("project_budget");
      break;
    }
    if (reused) cursor.reused_files = (cursor.reused_files || 0) + 1;
    else {
      cursor.created_contents = (cursor.created_contents || 0) + 1;
      cursor.written_postings = (cursor.written_postings || 0) + content.grams;
    }
    contents.set(entry.sha, content);
    const suffix = entry.name.includes(".")
      ? entry.name.split(".").at(-1)!
      : "";
    documents.push({
      id: await digest(s.build_generation + "\0" + path),
      path,
      sha: entry.sha,
      content: content.id,
      extension: codeFold(suffix),
    });
    s.indexed_files++;
    s.bytes += content.bytes;
    s.postings += content.grams;
  }
  const done = !cursor.stack.length,
    guard = crypto.randomUUID();
  const statements = [
    env.DB.prepare(
      `INSERT INTO mutation_guards(id,accepted) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM code_index_state s JOIN repositories r ON r.id=s.repo_id WHERE s.repo_id=? AND s.build_generation=? AND s.build_version=2 AND s.cursor=? AND r.deleted_at IS NULL AND r.default_branch=s.build_branch) THEN 1 ELSE 0 END`,
    ).bind(guard, metadata.id, s.build_generation, s.cursor),
  ];
  for (const c of contents.values())
    if (c.values) {
      statements.push(
        env.DB.prepare(
          "INSERT INTO code_contents(id,repo_id,epoch,blob_sha,body,bytes,grams) VALUES(?,?,?,?,?,?,?)",
        ).bind(
          c.id,
          metadata.id,
          s.build_epoch,
          c.sha,
          c.body!,
          c.bytes,
          c.grams,
        ),
      );
      statements.push(
        env.DB.prepare(
          "INSERT INTO code_content_grams(gram,content_id) SELECT value,? FROM json_each(?)",
        ).bind(c.id, JSON.stringify(c.values)),
      );
    }
  for (const d of documents)
    statements.push(
      env.DB.prepare(
        "INSERT INTO code_documents(id,repo_id,generation,path,blob_sha,body,extension,content_id) VALUES(?,?,?,?,?,'',?,?)",
      ).bind(
        d.id,
        metadata.id,
        s.build_generation,
        d.path,
        d.sha,
        d.extension,
        d.content,
      ),
    );
  const coverage = {
    files: s.files,
    indexed_files: s.indexed_files,
    skipped_files: s.skipped_files,
    bytes: s.bytes,
    postings: s.postings,
    index_version: 2,
    reused_files: cursor.reused_files || 0,
    created_contents: cursor.created_contents || 0,
    written_postings: cursor.written_postings || 0,
    skipped: cursor.skipped,
    partial: !!(s.skipped_files || cursor.unscanned),
    unscanned: !!cursor.unscanned,
    limit: cursor.limit || null,
  };
  statements.push(
    env.DB.prepare(
      `UPDATE code_index_state SET cursor=?,files=?,indexed_files=?,skipped_files=?,bytes=?,postings=?,checked_at=? WHERE repo_id=?`,
    ).bind(
      JSON.stringify(cursor),
      s.files,
      s.indexed_files,
      s.skipped_files,
      s.bytes,
      s.postings,
      Date.now(),
      metadata.id,
    ),
  );
  if (done)
    statements.push(
      env.DB.prepare(
        `UPDATE code_index_state SET generation=build_generation,indexed_sha=build_sha,indexed_branch=build_branch,indexed_at=?,completed=build_request,coverage=?,status=?,index_version=2,content_epoch=build_epoch,build_epoch=NULL,build_generation=NULL,build_sha=NULL,build_branch=NULL,build_request=NULL,cursor=NULL,gc_pending=1,error=NULL WHERE repo_id=?`,
      ).bind(
        Date.now(),
        JSON.stringify(coverage),
        coverage.partial ? "partial" : "ready",
        metadata.id,
      ),
    );
  statements.push(
    env.DB.prepare("DELETE FROM mutation_guards WHERE id=?").bind(guard),
  );
  await env.DB.batch(statements);
  if (done && semanticConfigured(env)) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO semantic_state(repo_id) VALUES(?)",
    )
      .bind(metadata.id)
      .run();
    await env.EVENTS?.send({ id: "semantic:" + metadata.id }).catch(() => {});
  }
  return true;
}
