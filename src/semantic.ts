import type { Env } from "./types";
import { digest, fail } from "./security";
export const EMBEDDING_MODEL = "@cf/baai/bge-m3" as const;
export const EMBEDDING_DIMENSIONS = 1024;
export const SEMANTIC_LIMITS = {
  chars: 2000,
  lines: 60,
  chunksPerFile: 128,
  chunksPerRepo: 8192,
  batch: 8,
  repos: 128,
};
export interface Chunk {
  body: string;
  line: number;
  end_line: number;
}
/** Line-bounded windows with overlap; split very long lines without losing their source line. */
export function chunkCode(body: string): { chunks: Chunk[]; partial: boolean } {
  const units: { text: string; line: number }[] = [];
  for (const [i, line] of body.split("\n").entries()) {
    const chars = Array.from(line);
    if (!chars.length) units.push({ text: "", line: i + 1 });
    for (let j = 0; j < chars.length; j += SEMANTIC_LIMITS.chars)
      units.push({
        text: chars.slice(j, j + SEMANTIC_LIMITS.chars).join(""),
        line: i + 1,
      });
  }
  const chunks: Chunk[] = [];
  let start = 0;
  while (
    start < units.length &&
    chunks.length < SEMANTIC_LIMITS.chunksPerFile
  ) {
    let end = start,
      size = 0;
    while (
      end < units.length &&
      end - start < SEMANTIC_LIMITS.lines &&
      size + units[end].text.length + (end > start ? 1 : 0) <=
        SEMANTIC_LIMITS.chars
    ) {
      size += units[end].text.length + (end > start ? 1 : 0);
      end++;
    }
    // UTF-16 length can exceed codepoint count for non-BMP characters.
    if (end === start) end++;
    const text = units
      .slice(start, end)
      .map((x) => x.text)
      .join("\n");
    if (text.trim())
      chunks.push({
        body: text,
        line: units[start].line,
        end_line: units[end - 1].line,
      });
    if (end >= units.length) {
      start = end;
      break;
    }
    start = end - start > 6 ? end - 4 : end;
  }
  return { chunks, partial: start < units.length };
}
export function semanticConfigured(env: Env) {
  return !!(env.AI && env.CODE_VECTORS);
}
export async function semanticSettings(env: Env) {
  return (await env.DB.prepare(
    "SELECT enabled,daily_chars FROM semantic_settings WHERE id=1",
  ).first<{ enabled: number; daily_chars: number }>())!;
}
export async function reserveSemanticUsage(
  env: Env,
  kind: "index" | "query",
  chars: number,
) {
  const row = await env.DB.prepare(
    `INSERT INTO semantic_usage(day,${kind}_chars,${kind}_requests) SELECT ?,?,1 FROM semantic_settings WHERE id=1 AND enabled=1 AND daily_chars>=?
 ON CONFLICT(day) DO UPDATE SET ${kind}_chars=${kind}_chars+excluded.${kind}_chars,${kind}_requests=${kind}_requests+1
 WHERE EXISTS(SELECT 1 FROM semantic_settings WHERE id=1 AND enabled=1 AND daily_chars>=semantic_usage.index_chars+semantic_usage.query_chars+excluded.${kind}_chars) RETURNING day`,
  )
    .bind(new Date().toISOString().slice(0, 10), chars, chars)
    .first();
  if (!row)
    fail(429, "Semantic search paused or daily character budget reached");
}
export async function embeddings(
  env: Env,
  text: string[],
  kind: "index" | "query",
) {
  await reserveSemanticUsage(
    env,
    kind,
    text.reduce((n, s) => n + s.length, 0),
  );
  const result = await env.AI!.run(EMBEDDING_MODEL, { text });
  const data = (result as { data?: number[][] }).data;
  if (
    !data ||
    data.length !== text.length ||
    data.some(
      (v) =>
        v.length !== EMBEDDING_DIMENSIONS || v.some((n) => !Number.isFinite(n)),
    )
  )
    throw Error("Unexpected embedding dimensions");
  return data;
}
export async function collectSemantic(env: Env) {
  if (!env.CODE_VECTORS) return;
  // Grace period fences late writes after lease expiration and bounds deletion batches.
  const repos = (
    await env.DB.prepare(
      `SELECT DISTINCT c.repo_id FROM semantic_chunks c WHERE c.touched_at<? AND NOT EXISTS(
 SELECT 1 FROM code_documents d JOIN code_index_state s ON s.repo_id=d.repo_id JOIN repositories r ON r.id=d.repo_id
 WHERE d.repo_id=c.repo_id AND d.blob_sha=c.blob_sha AND r.deleted_at IS NULL AND (d.generation=s.generation OR d.generation=s.build_generation)) LIMIT 5`,
    )
      .bind(Date.now() - 600000)
      .all<{ repo_id: string }>()
  ).results;
  for (const repo of repos) {
    const lease = crypto.randomUUID();
    const lock = await env.DB.prepare(
      "UPDATE semantic_state SET lease=?,lease_until=? WHERE repo_id=? AND lease_until<? RETURNING repo_id",
    )
      .bind(lease, Date.now() + 120000, repo.repo_id, Date.now())
      .first();
    if (!lock) continue;
    try {
      const rows = (
        await env.DB.prepare(
          `SELECT c.id FROM semantic_chunks c WHERE c.repo_id=? AND c.touched_at<? AND NOT EXISTS(SELECT 1 FROM code_documents d JOIN code_index_state s ON s.repo_id=d.repo_id JOIN repositories r ON r.id=d.repo_id WHERE d.repo_id=c.repo_id AND d.blob_sha=c.blob_sha AND r.deleted_at IS NULL AND (d.generation=s.generation OR d.generation=s.build_generation)) LIMIT 100`,
        )
          .bind(repo.repo_id, Date.now() - 600000)
          .all<{ id: string }>()
      ).results;
      if (rows.length) {
        await env.CODE_VECTORS.deleteByIds(rows.map((r) => r.id));
        await env.DB.prepare(
          "DELETE FROM semantic_chunks WHERE id IN(SELECT value FROM json_each(?)) AND EXISTS(SELECT 1 FROM semantic_state WHERE repo_id=? AND lease=?)",
        )
          .bind(JSON.stringify(rows.map((r) => r.id)), repo.repo_id, lease)
          .run();
      }
    } finally {
      await env.DB.prepare(
        "UPDATE semantic_state SET lease=NULL,lease_until=0 WHERE repo_id=? AND lease=?",
      )
        .bind(repo.repo_id, lease)
        .run();
    }
  }
  await env.DB.prepare("DELETE FROM semantic_rate WHERE window<?")
    .bind(Math.floor(Date.now() / 60000) - 10)
    .run();
  await env.DB.prepare(
    "DELETE FROM semantic_usage WHERE day<date('now','-90 days')",
  ).run();
}
export async function publishSemantic(env: Env) {
  if (!semanticConfigured(env)) return;
  await collectSemantic(env);
  if (!(await semanticSettings(env)).enabled) return;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO semantic_state(repo_id) SELECT r.id FROM repositories r JOIN code_index_state c ON c.repo_id=r.id WHERE r.deleted_at IS NULL AND c.generation IS NOT NULL`,
  ).run();
  const rows = (
    await env.DB.prepare(
      `SELECT s.repo_id FROM semantic_state s JOIN repositories r ON r.id=s.repo_id JOIN code_index_state c ON c.repo_id=s.repo_id WHERE r.deleted_at IS NULL AND c.generation IS NOT NULL AND c.indexed_branch=r.default_branch AND s.lease_until<? AND s.retry_at<? AND (s.generation IS NOT c.generation OR s.status NOT IN('ready','partial')) ORDER BY s.checked_at,s.repo_id LIMIT 20`,
    )
      .bind(Date.now(), Date.now())
      .all<{ repo_id: string }>()
  ).results;
  for (const r of rows) {
    await env.DB.prepare(
      "UPDATE semantic_state SET checked_at=? WHERE repo_id=?",
    )
      .bind(Date.now(), r.repo_id)
      .run();
    if (env.EVENTS) await env.EVENTS.send({ id: "semantic:" + r.repo_id });
  }
}
interface IndexState {
  repo_id: string;
  generation: string | null;
  cursor_blob: string;
  chunk_offset: number;
  chunks: number;
  skipped: number;
  lease: string | null;
  status: string;
}
/** Separate queue job: never waits inside the Git repository writer gate. */
export async function advanceSemantic(env: Env, repoId: string) {
  if (!semanticConfigured(env) || !(await semanticSettings(env)).enabled)
    return;
  const lease = crypto.randomUUID(),
    now = Date.now();
  const state = await env.DB.prepare(
    `UPDATE semantic_state SET lease=?,lease_until=?,checked_at=? WHERE repo_id=? AND lease_until<? AND retry_at<=? RETURNING *`,
  )
    .bind(lease, now + 120000, now, repoId, now, now)
    .first<IndexState>();
  if (!state) return;
  let pending = false;
  try {
    const live = await env.DB.prepare(
      `SELECT c.generation FROM code_index_state c JOIN repositories r ON r.id=c.repo_id WHERE r.id=? AND r.deleted_at IS NULL AND c.indexed_branch=r.default_branch`,
    )
      .bind(repoId)
      .first<{ generation: string | null }>();
    if (!live?.generation) return;
    if (state.generation !== live.generation) {
      state.generation = live.generation;
      state.cursor_blob = "";
      state.chunk_offset = 0;
      state.chunks = 0;
      state.skipped = 0;
    }
    const doc = await env.DB.prepare(
      `SELECT d.blob_sha,coalesce(b.body,d.body) AS body FROM code_documents d LEFT JOIN code_contents b ON b.id=d.content_id WHERE d.repo_id=? AND d.generation=? AND (d.blob_sha>? OR (d.blob_sha=? AND ?>0)) ORDER BY d.blob_sha LIMIT 1`,
    )
      .bind(
        repoId,
        state.generation,
        state.cursor_blob,
        state.cursor_blob,
        state.chunk_offset,
      )
      .first<{ blob_sha: string; body: string }>();
    if (doc && state.chunks < SEMANTIC_LIMITS.chunksPerRepo) {
      const all = chunkCode(doc.body),
        offset = doc.blob_sha === state.cursor_blob ? state.chunk_offset : 0;
      const batch = all.chunks.slice(
        offset,
        Math.min(
          offset + SEMANTIC_LIMITS.batch,
          offset + SEMANTIC_LIMITS.chunksPerRepo - state.chunks,
        ),
      );
      const parts = await Promise.all(
        batch.map(async (c, i) => ({
          ...c,
          chunk: offset + i,
          id: await digest(
            "bge-m3-v1\0" + repoId + "\0" + doc.blob_sha + "\0" + (offset + i),
          ),
        })),
      );
      const known = (
        await env.DB.prepare(
          "SELECT id FROM semantic_chunks WHERE repo_id=? AND blob_sha=? AND ready=1",
        )
          .bind(repoId, doc.blob_sha)
          .all<{ id: string }>()
      ).results;
      const ready = new Set(known.map((c) => c.id)),
        missing = parts.filter((c) => !ready.has(c.id));
      if (missing.length) {
        // Persist the outbox before external writes, so retry/GC always knows every vector ID.
        await env.DB.batch(
          missing.map((c) =>
            env.DB.prepare(
              `INSERT INTO semantic_chunks(id,repo_id,blob_sha,chunk,line,end_line,body,touched_at) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM semantic_state WHERE repo_id=? AND lease=?) ON CONFLICT(id) DO UPDATE SET touched_at=excluded.touched_at`,
            ).bind(
              c.id,
              repoId,
              doc.blob_sha,
              c.chunk,
              c.line,
              c.end_line,
              c.body,
              Date.now(),
              repoId,
              lease,
            ),
          ),
        );
        const owns = await env.DB.prepare(
          "SELECT repo_id FROM semantic_state WHERE repo_id=? AND lease=? AND lease_until>?",
        )
          .bind(repoId, lease, Date.now())
          .first();
        if (!owns) return;
        const values = await embeddings(
          env,
          missing.map((c) => c.body),
          "index",
        );
        if (
          !(await env.DB.prepare(
            "SELECT repo_id FROM semantic_state WHERE repo_id=? AND lease=? AND lease_until>?",
          )
            .bind(repoId, lease, Date.now())
            .first())
        )
          return;
        await env.CODE_VECTORS!.upsert(
          missing.map((c, i) => ({
            id: c.id,
            values: values[i],
            metadata: { repo: repoId },
          })),
        );
        await env.DB.prepare(
          `UPDATE semantic_chunks SET ready=1,touched_at=? WHERE id IN(SELECT value FROM json_each(?)) AND EXISTS(SELECT 1 FROM semantic_state WHERE repo_id=? AND lease=?)`,
        )
          .bind(
            Date.now(),
            JSON.stringify(missing.map((c) => c.id)),
            repoId,
            lease,
          )
          .run();
      }
      state.cursor_blob = doc.blob_sha;
      state.chunks += parts.length;
      state.chunk_offset =
        offset + parts.length < all.chunks.length ? offset + parts.length : 0;
      if (!state.chunk_offset && all.partial) state.skipped++;
      pending = true;
    }
    const status =
      pending && state.chunks < SEMANTIC_LIMITS.chunksPerRepo
        ? "indexing"
        : state.skipped || doc
          ? "partial"
          : "ready";
    const result = await env.DB.prepare(
      `UPDATE semantic_state SET generation=?,cursor_blob=?,chunk_offset=?,chunks=?,skipped=?,status=?,error=NULL,retry_at=0 WHERE repo_id=? AND lease=? AND EXISTS(SELECT 1 FROM code_index_state c JOIN repositories r ON r.id=c.repo_id WHERE c.repo_id=? AND c.generation=? AND r.deleted_at IS NULL AND c.indexed_branch=r.default_branch)`,
    )
      .bind(
        state.generation,
        state.cursor_blob,
        state.chunk_offset,
        state.chunks,
        state.skipped,
        status,
        repoId,
        lease,
        repoId,
        state.generation,
      )
      .run();
    pending = !!result.meta.changes && status === "indexing";
  } catch (error) {
    await env.DB.prepare(
      "UPDATE semantic_state SET status='failed',error='Embedding or vector service unavailable; retry scheduled',retry_at=? WHERE repo_id=? AND lease=?",
    )
      .bind(Date.now() + 300000, repoId, lease)
      .run();
    throw error;
  } finally {
    await env.DB.prepare(
      "UPDATE semantic_state SET lease=NULL,lease_until=0 WHERE repo_id=? AND lease=?",
    )
      .bind(repoId, lease)
      .run();
  }
  if (pending && env.EVENTS)
    await env.EVENTS.send({ id: "semantic:" + repoId }, { delaySeconds: 1 });
}
