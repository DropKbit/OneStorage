import type { Env } from "./types";
import {
  codeSearchInput,
  principalSQL,
  visibleSQL,
  searchCode,
  type SearchPrincipal,
  type CodeSearchInput,
} from "./code-search";
import {
  embeddings,
  semanticConfigured,
  semanticSettings,
  SEMANTIC_LIMITS,
} from "./semantic";
import { fail } from "./security";
import { z } from "zod";
export const semanticSearchInput = codeSearchInput.extend({
  mode: z.enum(["text", "semantic", "hybrid"]).default("text"),
});
const scope = (b: CodeSearchInput, p: SearchPrincipal) => [
  p?.id || "",
  p?.credential || "",
  Date.now(),
  b.namespace,
  b.namespace,
  b.archived,
  b.archived,
  b.archived,
];
async function authorize(env: Env, p: SearchPrincipal) {
  if (
    p &&
    !(await env.DB.prepare(principalSQL)
      .bind(p.id, p.credential, Date.now())
      .first())
  )
    fail(401, "Invalid or expired access token");
}
export async function semanticSearch(
  env: Env,
  b: CodeSearchInput,
  p: SearchPrincipal,
) {
  await authorize(env, p);
  if (!semanticConfigured(env) || !(await semanticSettings(env)).enabled)
    fail(503, "Semantic search is not enabled");
  const window = Math.floor(Date.now() / 60000);
  const rate = await env.DB.prepare(
    `INSERT INTO semantic_rate(actor,window,count) VALUES(?,?,1) ON CONFLICT(actor) DO UPDATE SET window=excluded.window,count=CASE WHEN window=excluded.window THEN count+1 ELSE 1 END WHERE window!=excluded.window OR count<20 RETURNING count`,
  )
    .bind(p?.id || "anonymous", window)
    .first();
  if (!rate)
    fail(429, "Semantic search rate limit reached; try again in one minute");
  const projects = (
    await env.DB.prepare(
      `WITH principal AS (${principalSQL}),visible AS (${visibleSQL}) SELECT r.id FROM visible r JOIN code_index_state c ON c.repo_id=r.id WHERE c.generation IS NOT NULL AND c.indexed_branch=r.default_branch ORDER BY r.id LIMIT ?`,
    )
      .bind(...scope(b, p), SEMANTIC_LIMITS.repos + 1)
      .all<{ id: string }>()
  ).results;
  const selected = projects.slice(0, SEMANTIC_LIMITS.repos),
    scores = new Map<string, number>();
  if (selected.length) {
    const [vector] = await embeddings(env, [b.q], "query");
    // Bound filter size below Vectorize's 2 KiB limit; no unauthorized repository is searched.
    for (let i = 0; i < selected.length; i += 32) {
      const matches = await env.CODE_VECTORS!.query(vector, {
        topK: 100,
        returnMetadata: "none",
        returnValues: false,
        filter: { repo: { $in: selected.slice(i, i + 32).map((r) => r.id) } },
      });
      for (const match of matches.matches)
        if (Number.isFinite(match.score)) scores.set(match.id, match.score);
    }
  }
  // Ignore provider metadata entirely. Resolve IDs through the current snapshot and live ACLs.
  const rows = (
    await env.DB.prepare(
      `WITH principal AS (${principalSQL}),visible AS (${visibleSQL})
 SELECT v.id AS vector_id,d.repo_id,r.namespace,r.name,r.archived_at,d.path,d.blob_sha,v.body AS excerpt,v.line,v.end_line,
 c.indexed_sha,c.indexed_branch,c.indexed_at,c.status,c.requested>c.completed AS stale
 FROM semantic_chunks v JOIN code_documents d ON d.repo_id=v.repo_id AND d.blob_sha=v.blob_sha JOIN visible r ON r.id=d.repo_id
 JOIN code_index_state c ON c.repo_id=d.repo_id AND c.generation=d.generation AND c.indexed_branch=r.default_branch
 WHERE v.ready=1 AND v.id IN(SELECT value FROM json_each(?)) AND (?='' OR instr(lower(d.path),lower(?))>0) AND (?='' OR d.extension=lower(?))
 ORDER BY d.repo_id,d.path,v.line LIMIT 4000`,
    )
      .bind(
        ...scope(b, p),
        JSON.stringify([...scores.keys()]),
        b.path,
        b.path,
        b.extension,
        b.extension,
      )
      .all<Record<string, unknown>>()
  ).results;
  await authorize(env, p);
  const ranked = rows
    .map(
      (r) =>
        ({
          ...r,
          type: "code",
          match: "semantic",
          score: scores.get(r.vector_id as string)!,
        }) as Record<string, unknown> & { score: number },
    )
    .sort(
      (a, b) =>
        b.score - a.score ||
        String(a.vector_id).localeCompare(String(b.vector_id)),
    );
  const seen = new Set<string>();
  const results = ranked.filter((r) => {
    const key = r.repo_id + "\0" + r.path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const coverage = await env.DB.prepare(
    `WITH principal AS (${principalSQL}),visible AS (${visibleSQL})
 SELECT count(*) AS projects,coalesce(sum(s.generation=c.generation),0) AS indexed_projects,
 coalesce(sum(s.repo_id IS NULL OR s.generation IS NOT c.generation OR s.status='indexing' OR c.requested>c.completed),0) AS pending_projects,
 coalesce(sum(s.status='partial' OR json_extract(c.coverage,'$.partial')=1),0) AS partial_projects,
 coalesce(sum(s.status='failed'),0) AS failed_projects
 FROM visible r LEFT JOIN code_index_state c ON c.repo_id=r.id LEFT JOIN semantic_state s ON s.repo_id=r.id`,
  )
    .bind(...scope(b, p))
    .first();
  return {
    coverage,
    results: results.slice(0, b.limit),
    has_more: false,
    next_cursor: null,
    semantic: {
      available: true,
      mode: "semantic",
      projects: Math.min(projects.length, SEMANTIC_LIMITS.repos),
      scope_limited: projects.length > SEMANTIC_LIMITS.repos,
      top_results: true,
      truncated: results.length > b.limit,
    },
  };
}
export async function searchWithSemantics(
  env: Env,
  b: z.infer<typeof semanticSearchInput>,
  p: SearchPrincipal,
) {
  if (b.mode === "text") return searchCode(env, b, p);
  if (b.cursor)
    fail(
      400,
      "Semantic and hybrid searches return ranked top results without cursors",
    );
  if (b.mode === "semantic") return semanticSearch(env, b, p);
  let semantic: Awaited<ReturnType<typeof semanticSearch>> | undefined;
  try {
    semantic = await semanticSearch(env, { ...b, limit: 50 }, p);
  } catch (error) {
    if (
      (error as { status?: number }).status === 401 ||
      (error as { status?: number }).status === 403
    )
      throw error;
  }
  // Run after vector retrieval to avoid returning text results authorized before a long inference.
  const text = await searchCode(env, { ...b, limit: 50 }, p);
  if (!semantic)
    return {
      ...text,
      results: text.results.slice(0, b.limit),
      has_more: false,
      next_cursor: null,
      semantic: { available: false, mode: "text", fallback: true },
    };
  const hits = new Map<
    string,
    { item: Record<string, unknown>; rank: number }
  >();
  const add = (items: Record<string, unknown>[], weight: number) =>
    items.forEach((item, i) => {
      const key = item.repo_id + "\0" + item.path,
        previous = hits.get(key),
        rank = weight / (60 + i + 1);
      if (previous) {
        previous.rank += rank;
        previous.item.match = "hybrid";
      } else
        hits.set(key, { item: { ...item, match: item.match || "text" }, rank });
    });
  add(text.results, 1.5);
  add(semantic.results, 1);
  const ranked = [...hits.values()]
    .sort((a, b) => b.rank - a.rank)
    .map((x) => ({ ...x.item, rank: x.rank }));
  const [auth, fresh] = await env.DB.batch([
    env.DB.prepare(
      `SELECT (?='' OR EXISTS(${principalSQL})) AS authorized`,
    ).bind(p?.id || "", p?.id || "", p?.credential || "", Date.now()),
    env.DB.prepare(
      `WITH principal AS (${principalSQL}),visible AS (${visibleSQL})
      SELECT j.value,r.namespace,r.name,r.archived_at FROM json_each(?) j
      JOIN visible r ON r.id=json_extract(j.value,'$.repo_id')
      JOIN code_index_state c ON c.repo_id=r.id AND c.indexed_branch=r.default_branch AND c.indexed_sha=json_extract(j.value,'$.indexed_sha')
      WHERE EXISTS(SELECT 1 FROM code_documents d WHERE d.repo_id=r.id AND d.generation=c.generation AND d.path=json_extract(j.value,'$.path') AND d.blob_sha=json_extract(j.value,'$.blob_sha'))
      ORDER BY CAST(j.key AS INTEGER)`,
    ).bind(...scope(b, p), JSON.stringify(ranked)),
  ]);
  if (!(auth.results[0] as { authorized: number }).authorized)
    fail(401, "Invalid or expired access token");
  return {
    ...text,
    results: fresh.results
      .slice(0, b.limit)
      .map((row: any) => ({
        ...JSON.parse(row.value),
        namespace: row.namespace,
        name: row.name,
        archived_at: row.archived_at,
      })),
    has_more: false,
    next_cursor: null,
    semantic: { ...semantic.semantic, mode: "hybrid" },
  };
}
