import type { Hono } from "hono";
import { z } from "zod";
import type { App, Env } from "./types";
import { fail } from "./security";
import { base64, unbase64 } from "./git/signatures";

const kinds = ["project", "issue", "merge", "wiki"] as const;
export const searchInput = z.object({
  q: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .refine((s) => !/[\r\n\0]/.test(s)),
  type: z.enum(["all", ...kinds]).default("all"),
  namespace: z.string().max(64).default(""),
  state: z.enum(["all", "open", "closed", "merged"]).default("all"),
  archived: z.enum(["include", "exclude", "only"]).default("include"),
  limit: z.coerce.number().int().min(1).max(50).default(30),
  cursor: z.string().max(4096).optional(),
});
type Input = z.infer<typeof searchInput>;
type Principal = { id: string; credential: string } | null;
interface Result {
  type: (typeof kinds)[number];
  repo_id: string;
  id: string;
  namespace: string;
  name: string;
  title: string;
  excerpt: string;
  state: string | null;
  archived_at: string | null;
  date: string;
}
const position = z.tuple([
  z.enum(kinds),
  z.string().min(1).max(128),
  z.string().max(256),
]);
function cursorContext(b: Input, p: Principal) {
  return [b.q, b.type, b.namespace, b.state, b.archived, p?.id || ""];
}
function decodeCursor(b: Input, p: Principal): string[] {
  if (!b.cursor) return ["", "", ""];
  try {
    const c = z
      .object({
        v: z.literal(1),
        context: z.array(z.string()).length(6),
        after: position,
      })
      .strict()
      .parse(JSON.parse(new TextDecoder().decode(unbase64(b.cursor))));
    if (JSON.stringify(c.context) !== JSON.stringify(cursorContext(b, p)))
      throw Error();
    return c.after;
  } catch {
    fail(400, "Invalid search cursor or changed filters");
  }
}

// Current access is evaluated inside the same D1 batch as the credential check.
// A site administrator has no implicit read access to other users' private code.
export async function searchCollaboration(env: Env, b: Input, p: Principal) {
  const after = decodeCursor(b, p),
    now = Date.now();
  const principal = `SELECT u.id FROM users u JOIN credentials c ON c.user_id=u.id
    WHERE u.id=? AND u.disabled=0 AND c.hash=? AND c.kind IN ('session','pat') AND c.expires_at>?`;
  const select = {
    project: `SELECT 'project' AS type,r.id AS repo_id,'' AS id,r.name AS title,r.description AS body,NULL AS state,r.created_at AS date FROM visible r`,
    issue: `SELECT 'issue',i.repo_id,CAST(i.id AS TEXT),i.title,i.body,i.state,i.created_at FROM issues i JOIN visible r ON r.id=i.repo_id`,
    merge: `SELECT 'merge',m.repo_id,CAST(m.id AS TEXT),m.title,m.body,m.state,m.created_at FROM merge_requests m JOIN visible r ON r.id=m.repo_id`,
    wiki: `SELECT 'wiki',w.repo_id,w.slug,w.title,w.body,NULL,w.updated_at FROM wiki_pages w JOIN visible r ON r.id=w.repo_id`,
  };
  // No Git/R2 reads, per-project RPC fanout, fixed project cap, or content index.
  const sql = `WITH principal AS (${principal}), visible AS (
    SELECT r.* FROM repositories r WHERE r.deleted_at IS NULL
    AND (r.visibility='public' OR EXISTS(SELECT 1 FROM principal p WHERE
      (r.workspace_id IS NULL AND r.owner_id=p.id)
      OR EXISTS(SELECT 1 FROM members m WHERE m.repo_id=r.id AND m.user_id=p.id)
      OR EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=r.workspace_id AND wm.user_id=p.id)))
    AND (?='' OR r.namespace=? COLLATE NOCASE)
    AND (?='include' OR (?='only' AND r.archived_at IS NOT NULL) OR (?='exclude' AND r.archived_at IS NULL))
  ), documents(type,repo_id,id,title,body,state,date) AS (${(b.type === "all" ? kinds : [b.type]).map((k) => select[k]).join(" UNION ALL ")})
  SELECT d.type,d.repo_id,d.id,r.namespace,r.name,d.title,d.state,d.date,r.archived_at,
    substr(d.body,max(1,instr(lower(d.body),lower(?))-80),320) AS excerpt
  FROM documents d JOIN visible r ON r.id=d.repo_id
  WHERE (?='all' OR d.state=?)
    AND (instr(lower(d.title),lower(?))>0 OR instr(lower(d.body),lower(?))>0)
    AND (d.type,d.repo_id,d.id)>(?,?,?)
  ORDER BY d.type,d.repo_id,d.id LIMIT ?`;
  const [auth, result] = await env.DB.batch([
    env.DB.prepare(`SELECT (?='' OR EXISTS(${principal})) AS authorized`).bind(
      p?.id || "",
      p?.id || "",
      p?.credential || "",
      now,
    ),
    env.DB.prepare(sql).bind(
      p?.id || "",
      p?.credential || "",
      now,
      b.namespace,
      b.namespace,
      b.archived,
      b.archived,
      b.archived,
      b.q,
      b.state,
      b.state,
      b.q,
      b.q,
      ...after,
      b.limit + 1,
    ),
  ]);
  if (!(auth.results[0] as { authorized: number }).authorized)
    fail(401, "Invalid or expired access token");
  const rows = result.results as unknown as Result[],
    results = rows.slice(0, b.limit),
    last = results.at(-1),
    has_more = rows.length > b.limit;
  return {
    results,
    has_more,
    next_cursor:
      has_more && last
        ? base64(
            new TextEncoder().encode(
              JSON.stringify({
                v: 1,
                context: cursorContext(b, p),
                after: [last.type, last.repo_id, last.id],
              }),
            ),
          )
        : null,
  };
}

export function registerSearch(app: Hono<App>) {
  app.get("/api/search", async (c) => {
    if (c.get("delegation") || c.get("deploy"))
      fail(
        403,
        "Global collaboration search requires a session or personal access token",
      );
    const user = c.get("user"),
      credential = c.get("credential");
    if (user && !credential) fail(401, "Authentication required");
    return c.json(
      await searchCollaboration(
        c.env,
        searchInput.parse(c.req.query()),
        user ? { id: user.id, credential: credential! } : null,
      ),
    );
  });
}
