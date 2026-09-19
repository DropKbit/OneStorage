import { z } from "zod";
import type { Env } from "./types";
import { fail } from "./security";
import { base64, unbase64 } from "./git/signatures";

export type SearchPrincipal = { id: string; credential: string } | null;
export const codeSearchInput = z.object({
  q: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .refine(
      (s) => !/[\r\n\0]/.test(s) && [...s].length >= 3,
      "Code search requires at least three characters",
    ),
  namespace: z.string().max(64).default(""),
  path: z.string().max(1000).default(""),
  extension: z
    .string()
    .max(32)
    .regex(/^[a-zA-Z0-9_-]*$/)
    .default(""),
  archived: z.enum(["include", "exclude", "only"]).default("include"),
  limit: z.coerce.number().int().min(1).max(50).default(30),
  cursor: z.string().max(8192).optional(),
});
export type CodeSearchInput = z.infer<typeof codeSearchInput>;
type Input = CodeSearchInput;
export const codeFold = (value: string) =>
  value.replace(/[A-Z]/g, (c) => c.toLowerCase());
/** Unicode codepoints, ASCII-only case folding, matching SQLite's lower/instr behavior. */
export function codeGrams(value: string) {
  const chars = [...codeFold(value)],
    result = new Set<string>();
  for (let i = 0; i + 2 < chars.length; i++)
    result.add(chars[i] + chars[i + 1] + chars[i + 2]);
  return [...result];
}
export const principalSQL = `SELECT u.id FROM users u JOIN credentials c ON c.user_id=u.id
 WHERE u.id=? AND u.disabled=0 AND c.hash=? AND c.kind IN('session','pat') AND c.expires_at>?`;
export const visibleSQL = `SELECT r.* FROM repositories r WHERE r.deleted_at IS NULL
 AND (r.visibility='public' OR EXISTS(SELECT 1 FROM principal p WHERE
 (r.workspace_id IS NULL AND r.owner_id=p.id)
 OR EXISTS(SELECT 1 FROM members m WHERE m.repo_id=r.id AND m.user_id=p.id)
 OR EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=r.workspace_id AND m.user_id=p.id)))
 AND (?='' OR r.namespace=? COLLATE NOCASE)
 AND (?='include' OR (?='only' AND r.archived_at IS NOT NULL) OR (?='exclude' AND r.archived_at IS NULL))`;
const context = (b: Input, p: SearchPrincipal) => [
  b.q,
  b.namespace,
  b.path,
  b.extension,
  b.archived,
  p?.id || "",
];
function after(b: Input, p: SearchPrincipal): string[] {
  if (!b.cursor) return ["", ""];
  try {
    const cursor = z
      .object({
        v: z.literal(1),
        context: z.array(z.string()).length(6),
        after: z.tuple([z.string().max(128), z.string().max(1000)]),
      })
      .strict()
      .parse(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(unbase64(b.cursor)),
        ),
      );
    if (JSON.stringify(cursor.context) !== JSON.stringify(context(b, p)))
      throw Error();
    return cursor.after;
  } catch {
    fail(400, "Invalid code search cursor or changed filters");
  }
}
interface CodeHit {
  repo_id: string;
  namespace: string;
  name: string;
  path: string;
  excerpt: string;
  line: number;
  blob_sha: string;
  indexed_sha: string;
  indexed_branch: string;
  indexed_at: number;
  status: string;
  archived_at: string | null;
  requested: number;
  completed: number;
}
export interface CodeCoverage {
  projects: number;
  indexed_projects: number;
  pending_projects: number;
  partial_projects: number;
  failed_projects: number;
}
export async function searchCode(env: Env, b: Input, p: SearchPrincipal) {
  const position = after(b, p),
    grams = codeGrams(b.q),
    now = Date.now();
  const identity = [p?.id || "", p?.credential || "", now],
    scope = [
      ...identity,
      b.namespace,
      b.namespace,
      b.archived,
      b.archived,
      b.archived,
    ];
  // Start from an indexed trigram rather than scanning every indexed file. Remaining
  // grams are exact indexed probes; instr verifies order, multiplicity and adjacency.
  const sql = `WITH principal AS (${principalSQL}),visible AS (${visibleSQL}),candidates AS (
 SELECT d.repo_id,d.generation,d.path,d.blob_sha,d.body,d.extension FROM code_postings first CROSS JOIN code_documents d ON d.id=first.document_id
 WHERE d.content_id IS NULL AND first.gram=? AND NOT EXISTS(SELECT 1 FROM json_each(?) q WHERE NOT EXISTS(SELECT 1 FROM code_postings p WHERE p.gram=q.value AND p.document_id=d.id))
 UNION ALL
 SELECT d.repo_id,d.generation,d.path,d.blob_sha,b.body,d.extension FROM code_content_grams first JOIN code_contents b ON b.id=first.content_id JOIN code_documents d ON d.content_id=b.id AND d.repo_id=b.repo_id
 WHERE first.gram=? AND NOT EXISTS(SELECT 1 FROM json_each(?) q WHERE NOT EXISTS(SELECT 1 FROM code_content_grams p WHERE p.gram=q.value AND p.content_id=b.id))
 )
 SELECT d.repo_id,r.namespace,r.name,r.archived_at,d.path,d.blob_sha,
 substr(d.body,max(1,instr(lower(d.body),lower(?))-100),length(?)+300) AS excerpt,
 length(substr(d.body,1,instr(lower(d.body),lower(?))-1))-length(replace(substr(d.body,1,instr(lower(d.body),lower(?))-1),char(10),''))+1 AS line,
 s.indexed_sha,s.indexed_branch,s.indexed_at,s.status,s.requested,s.completed
 FROM candidates d
 JOIN visible r ON r.id=d.repo_id JOIN code_index_state s ON s.repo_id=d.repo_id AND s.generation=d.generation AND s.indexed_branch=r.default_branch
 WHERE instr(lower(d.body),lower(?))>0 AND (?='' OR instr(lower(d.path),lower(?))>0)
 AND (?='' OR d.extension=lower(?)) AND (d.repo_id,d.path)>(?,?)
 ORDER BY d.repo_id,d.path LIMIT ?`;
  const [auth, rows, coverage] = await env.DB.batch([
    env.DB.prepare(
      `SELECT (?='' OR EXISTS(${principalSQL})) AS authorized`,
    ).bind(p?.id || "", ...identity),
    env.DB.prepare(sql).bind(
      ...scope,
      grams[0],
      JSON.stringify(grams.slice(1)),
      grams[0],
      JSON.stringify(grams.slice(1)),
      b.q,
      b.q,
      b.q,
      b.q,
      b.q,
      b.path,
      b.path,
      b.extension,
      b.extension,
      ...position,
      b.limit + 1,
    ),
    env.DB.prepare(
      `WITH principal AS (${principalSQL}),visible AS (${visibleSQL})
      SELECT count(*) AS projects,
      coalesce(sum(CASE WHEN s.generation IS NOT NULL AND s.indexed_branch=r.default_branch THEN 1 ELSE 0 END),0) AS indexed_projects,
      coalesce(sum(CASE WHEN s.repo_id IS NULL OR s.requested>s.completed OR s.generation IS NULL THEN 1 ELSE 0 END),0) AS pending_projects,
      coalesce(sum(CASE WHEN s.generation IS NOT NULL AND json_extract(s.coverage,'$.partial')=1 THEN 1 ELSE 0 END),0) AS partial_projects,
      coalesce(sum(CASE WHEN s.status='failed' THEN 1 ELSE 0 END),0) AS failed_projects
      FROM visible r LEFT JOIN code_index_state s ON s.repo_id=r.id`,
    ).bind(...scope),
  ]);
  if (!(auth.results[0] as { authorized: number }).authorized)
    fail(401, "Invalid or expired access token");
  const hits = rows.results as unknown as CodeHit[],
    has_more = hits.length > b.limit;
  const results = hits
    .slice(0, b.limit)
    .map(({ requested, completed, ...hit }) => ({
      ...hit,
      type: "code",
      stale: requested > completed,
    }));
  const last = results.at(-1);
  return {
    results,
    has_more,
    coverage: coverage.results[0] as unknown as CodeCoverage,
    next_cursor:
      has_more && last
        ? base64(
            new TextEncoder().encode(
              JSON.stringify({
                v: 1,
                context: context(b, p),
                after: [last.repo_id, last.path],
              }),
            ),
          )
        : null,
  };
}
