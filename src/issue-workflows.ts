import { publishPending } from "./webhooks";
import { z } from "zod";
import type { App, Env, Repo, User } from "./types";
import type { Context, Hono } from "hono";
import { fail, slug, digest } from "./security";
import { identity, jsonInput } from "./workspaces";
import { repositoryRole, roleRank } from "./access";
const ids = z
  .array(z.string().uuid())
  .max(20)
  .transform((v) => [...new Set(v)]);
export const issueChange = z.object({
  state: z.enum(["open", "closed"]).optional(),
  title: z.string().trim().min(1).max(240).optional(),
  body: z.string().max(20000).optional(),
  assignee: slug.nullable().optional(),
  milestone_id: z.string().uuid().nullable().optional(),
  labels: ids.optional(),
  add_labels: ids.optional(),
  remove_labels: ids.optional(),
});
const selections = z
  .array(
    z.object({
      id: z.number().int().positive(),
      revision: z.number().int().min(0),
    }),
  )
  .min(1)
  .max(50)
  .refine(
    (v) => new Set(v.map((x) => x.id)).size === v.length,
    "Duplicate issue IDs",
  );
const filters = z.object({
  state: z.enum(["all", "open", "closed"]).default("all"),
  q: z.string().max(200).default(""),
  author: z.string().max(48).default(""),
  assignee: z.string().max(48).default(""),
  milestone: z.string().max(48).default(""),
  labels: z.string().max(800).default(""),
  sort: z.enum(["newest", "oldest", "updated"]).default("newest"),
  limit: z.coerce.number().int().min(1).max(100).default(100),
  cursor: z.string().max(2000).optional(),
});
const memberSQL =
  "((r.workspace_id IS NULL AND r.owner_id=u.id) OR EXISTS(SELECT 1 FROM members m WHERE m.repo_id=r.id AND m.user_id=u.id AND m.role IN('developer','maintainer','owner')) OR EXISTS(SELECT 1 FROM workspace_members w WHERE w.workspace_id=r.workspace_id AND w.user_id=u.id AND w.role IN('developer','maintainer','owner')))";
const issueReadSQL =
  "u.disabled=0 AND r.deleted_at IS NULL AND (r.visibility='public' OR (r.workspace_id IS NULL AND r.owner_id=u.id) OR EXISTS(SELECT 1 FROM members m WHERE m.repo_id=r.id AND m.user_id=u.id) OR EXISTS(SELECT 1 FROM workspace_members w WHERE w.workspace_id=r.workspace_id AND w.user_id=u.id))";
export async function createIssue(
  env: Env,
  repo: Repo,
  user: User,
  title: string,
  body: string,
) {
  const issue = await env.DB.prepare(
    `INSERT INTO issues(repo_id,author_id,title,body,updated_at) SELECT r.id,u.id,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM repositories r JOIN users u ON u.id=? WHERE r.id=? AND ${issueReadSQL} RETURNING *`,
  )
    .bind(title, body, user.id, repo.id)
    .first<any>();
  if (!issue)
    fail(409, "Repository access changed; reload before creating an issue");
  return issue;
}
export async function createIssueComment(
  env: Env,
  repo: Repo,
  user: User,
  id: number,
  body: string,
) {
  const comment = await env.DB.prepare(
    `INSERT INTO comments(issue_id,author_id,body) SELECT i.id,u.id,? FROM issues i JOIN repositories r ON r.id=i.repo_id JOIN users u ON u.id=? WHERE i.id=? AND r.id=? AND ${issueReadSQL} RETURNING *`,
  )
    .bind(body, user.id, id, repo.id)
    .first<any>();
  if (!comment)
    fail(409, "Issue or repository access changed; reload before commenting");
  return comment;
}
export async function listIssues(
  env: Env,
  repo: Repo,
  query: Record<string, unknown>,
  user: User | null,
  extra: { labels?: string[]; exclude?: string[]; state?: string } = {},
) {
  const f = filters.parse(query),
    conditions = ["i.repo_id=?"],
    values: any[] = [repo.id];
  const state = extra.state || f.state;
  if (state !== "all") {
    conditions.push("i.state=?");
    values.push(state);
  }
  if (f.q) {
    conditions.push(
      "(i.title LIKE ? ESCAPE '\\' OR i.body LIKE ? ESCAPE '\\')",
    );
    const like = "%" + f.q.replace(/[\\%_]/g, "\\$&") + "%";
    values.push(like, like);
  }
  for (const [key, column] of [
    ["author", "author_id"],
    ["assignee", "assignee_id"],
  ] as const) {
    let name = f[key];
    if (name === "me") {
      if (!user) fail(401, "Sign in to filter by yourself");
      name = user.username;
    }
    if (!name) continue;
    if (name === "none" && key === "assignee")
      conditions.push("i.assignee_id IS NULL");
    else {
      slug.parse(name);
      conditions.push(`i.${column}=(SELECT id FROM users WHERE username=?)`);
      values.push(name);
    }
  }
  if (f.milestone === "none") conditions.push("i.milestone_id IS NULL");
  else if (f.milestone) {
    z.string().uuid().parse(f.milestone);
    conditions.push("i.milestone_id=?");
    values.push(f.milestone);
  }
  const labels = [
    ...new Set([
      ...ids.parse(f.labels ? f.labels.split(",") : []),
      ...(extra.labels || []),
    ]),
  ];
  for (const id of labels) {
    conditions.push(
      "EXISTS(SELECT 1 FROM issue_labels il WHERE il.issue_id=i.id AND il.label_id=?)",
    );
    values.push(id);
  }
  if (extra.exclude?.length) {
    conditions.push(
      "NOT EXISTS(SELECT 1 FROM issue_labels il WHERE il.issue_id=i.id AND il.label_id IN(SELECT value FROM json_each(?)))",
    );
    values.push(JSON.stringify(extra.exclude));
  }
  const where = conditions.join(" AND "),
    key = await digest(
      JSON.stringify({
        repo: repo.id,
        user: user?.id || "",
        ...f,
        cursor: undefined,
        extra,
      }),
    );
  let cursorClause = "",
    cursorValues: any[] = [];
  if (f.cursor) {
    let c: any;
    try {
      c = z
        .object({
          key: z.string(),
          id: z.number().int().positive(),
          updated: z.string().optional(),
        })
        .parse(JSON.parse(atob(f.cursor)));
    } catch {
      fail(400, "Invalid issue cursor");
    }
    if (
      c.key !== key ||
      !Number.isSafeInteger(c.id) ||
      c.id < 1 ||
      (f.sort === "updated" && typeof c.updated !== "string")
    )
      fail(400, "Cursor does not match these filters");
    if (f.sort === "updated") {
      cursorClause = " AND (i.updated_at<? OR (i.updated_at=? AND i.id<?))";
      cursorValues = [c.updated, c.updated, c.id];
    } else {
      cursorClause = ` AND i.id${f.sort === "oldest" ? ">" : "<"}?`;
      cursorValues = [c.id];
    }
  }
  const order =
    f.sort === "updated"
      ? "i.updated_at DESC,i.id DESC"
      : `i.id ${f.sort === "oldest" ? "ASC" : "DESC"}`;
  const [rows, count] = await Promise.all([
    env.DB.prepare(
      `SELECT i.*,u.username AS author,a.username AS assignee,m.title AS milestone,(SELECT json_group_array(json_object('id',l.id,'name',l.name,'color',l.color)) FROM labels l JOIN issue_labels il ON il.label_id=l.id WHERE il.issue_id=i.id) AS labels_json FROM issues i JOIN users u ON u.id=i.author_id LEFT JOIN users a ON a.id=i.assignee_id LEFT JOIN milestones m ON m.id=i.milestone_id WHERE ${where}${cursorClause} ORDER BY ${order} LIMIT ?`,
    )
      .bind(...values, ...cursorValues, f.limit + 1)
      .all<any>(),
    env.DB.prepare(
      `SELECT count(*) AS total,sum(i.state='open') AS open FROM issues i WHERE ${where}`,
    )
      .bind(...values)
      .first<any>(),
  ]);
  const more = rows.results.length > f.limit,
    items = rows.results.slice(0, f.limit).map(({ labels_json, ...i }) => ({
      ...i,
      labels: JSON.parse(labels_json || "[]"),
    })),
    last = items.at(-1);
  return {
    issues: items,
    total: count?.total || 0,
    open: count?.open || 0,
    has_more: more,
    next_cursor: more
      ? btoa(JSON.stringify({ key, id: last.id, updated: last.updated_at }))
      : null,
  };
}
export async function changeIssues(
  env: Env,
  repo: Repo,
  user: User,
  selection: unknown,
  change: unknown,
  allowAuthor = false,
  board?: { id: string; revision: number },
  action = allowAuthor
    ? "issue.update"
    : board
      ? "issue.move"
      : "issue.bulk_update",
) {
  const selected = selections.parse(selection),
    b = issueChange.parse(change),
    rank = roleRank[await repositoryRole(env, repo, user)];
  const planning = [
    "assignee",
    "milestone_id",
    "labels",
    "add_labels",
    "remove_labels",
  ].some((k) => Object.hasOwn(b, k));
  if (rank < 2 && !(allowAuthor && selected.length === 1 && !planning))
    fail(403, "Developer required");
  if (!Object.keys(b).length) fail(400, "No issue changes supplied");
  if (b.labels && (b.add_labels || b.remove_labels))
    fail(400, "Use replacement labels or incremental labels");
  if (selected.length > 1 && (b.title !== undefined || b.body !== undefined))
    fail(400, "Bulk title/body replacement is not supported");
  let assignee: string | null = null;
  if (b.assignee) {
    const u = await env.DB.prepare(
      "SELECT id,username,admin FROM users WHERE username=? AND disabled=0",
    )
      .bind(b.assignee)
      .first<User>();
    if (!u || roleRank[await repositoryRole(env, repo, u)] < 1)
      fail(400, "Assignee must be a repository member");
    assignee = u.id;
  }
  const allLabels = [
    ...new Set([
      ...(b.labels || []),
      ...(b.add_labels || []),
      ...(b.remove_labels || []),
    ]),
  ];
  if (allLabels.length) {
    const count = await env.DB.prepare(
      "SELECT count(*) AS n FROM labels WHERE repo_id=? AND id IN(SELECT value FROM json_each(?))",
    )
      .bind(repo.id, JSON.stringify(allLabels))
      .first<{ n: number }>();
    if (count?.n !== allLabels.length) fail(400, "Label not in repository");
  }
  if (
    b.milestone_id &&
    !(await env.DB.prepare("SELECT id FROM milestones WHERE id=? AND repo_id=?")
      .bind(b.milestone_id, repo.id)
      .first())
  )
    fail(400, "Milestone not in repository");
  const encoded = JSON.stringify(selected),
    targetIds = JSON.stringify(selected.map((i) => i.id)),
    guard = crypto.randomUUID();
  const checks = [
    `(SELECT count(*) FROM issues i JOIN json_each(?) j ON i.id=json_extract(j.value,'$.id') WHERE i.repo_id=? AND i.revision=json_extract(j.value,'$.revision'))=?`,
    `EXISTS(SELECT 1 FROM users u JOIN repositories r ON r.id=? WHERE u.id=? AND u.disabled=0 AND r.deleted_at IS NULL AND (${memberSQL}${allowAuthor && !planning && selected.length === 1 ? " OR EXISTS(SELECT 1 FROM issues i WHERE i.id=? AND i.repo_id=r.id AND i.author_id=u.id AND (r.visibility='public' OR (r.workspace_id IS NULL AND r.owner_id=u.id) OR EXISTS(SELECT 1 FROM members m WHERE m.repo_id=r.id AND m.user_id=u.id) OR EXISTS(SELECT 1 FROM workspace_members w WHERE w.workspace_id=r.workspace_id AND w.user_id=u.id)))" : ""}))`,
    "(SELECT count(*) FROM labels WHERE repo_id=? AND id IN(SELECT value FROM json_each(?)))=?",
  ];
  const bindings: any[] = [
    encoded,
    repo.id,
    selected.length,
    repo.id,
    user.id,
    ...(allowAuthor && !planning && selected.length === 1
      ? [selected[0].id]
      : []),
    repo.id,
    JSON.stringify(allLabels),
    allLabels.length,
  ];
  if (b.milestone_id) {
    checks.push("EXISTS(SELECT 1 FROM milestones WHERE repo_id=? AND id=?)");
    bindings.push(repo.id, b.milestone_id);
  }
  if (assignee) {
    checks.push(
      "EXISTS(SELECT 1 FROM users u JOIN repositories r ON r.id=? WHERE u.id=? AND u.disabled=0 AND ((r.workspace_id IS NULL AND r.owner_id=u.id) OR EXISTS(SELECT 1 FROM members m WHERE m.repo_id=r.id AND m.user_id=u.id) OR EXISTS(SELECT 1 FROM workspace_members w WHERE w.workspace_id=r.workspace_id AND w.user_id=u.id)))",
    );
    bindings.push(repo.id, assignee);
  }
  if (board && board.id !== "default") {
    checks.push(
      "EXISTS(SELECT 1 FROM issue_boards WHERE id=? AND repo_id=? AND revision=?)",
    );
    bindings.push(board.id, repo.id, board.revision);
  }
  if (b.add_labels?.length) {
    checks.push(
      "NOT EXISTS(SELECT 1 FROM json_each(?) selected WHERE (SELECT count(*) FROM (SELECT label_id AS value FROM issue_labels WHERE issue_id=selected.value AND label_id NOT IN(SELECT value FROM json_each(?)) UNION SELECT value FROM json_each(?)))>50)",
    );
    bindings.push(
      targetIds,
      JSON.stringify(b.remove_labels || []),
      JSON.stringify(b.add_labels),
    );
  }
  const statements = [
    env.DB.prepare(
      `INSERT INTO mutation_guards(id,accepted) SELECT ?,CASE WHEN ${checks.join(" AND ")} THEN 1 ELSE 0 END`,
    ).bind(guard, ...bindings),
  ];
  const sets: string[] = [],
    args: any[] = [];
  for (const k of ["state", "title", "body", "milestone_id"] as const)
    if (b[k] !== undefined) {
      sets.push(k + "=?");
      args.push(b[k]);
    }
  if (b.assignee !== undefined) {
    sets.push("assignee_id=?");
    args.push(assignee);
  }
  if (sets.length)
    statements.push(
      env.DB.prepare(
        `UPDATE issues SET ${sets.join(",")} WHERE repo_id=? AND id IN(SELECT value FROM json_each(?))`,
      ).bind(...args, repo.id, targetIds),
    );
  if (b.labels || b.remove_labels?.length)
    statements.push(
      env.DB.prepare(
        `DELETE FROM issue_labels WHERE issue_id IN(SELECT value FROM json_each(?))${b.labels ? "" : " AND label_id IN(SELECT value FROM json_each(?))"}`,
      ).bind(targetIds, ...(b.labels ? [] : [JSON.stringify(b.remove_labels)])),
    );
  const add = b.labels || b.add_labels || [];
  if (add.length)
    statements.push(
      env.DB.prepare(
        "INSERT OR IGNORE INTO issue_labels(issue_id,label_id) SELECT i.value,l.value FROM json_each(?) i CROSS JOIN json_each(?) l",
      ).bind(targetIds, JSON.stringify(add)),
    );
  const detail =
    ["issue.assign", "issue.open", "issue.closed", "issue.update"].includes(
      action,
    ) && selected.length === 1
      ? String(selected[0].id)
      : targetIds;
  statements.push(
    env.DB.prepare(
      "INSERT INTO audit(repo_id,actor_id,action,detail) VALUES(?,?,?,?)",
    ).bind(repo.id, user.id, action, detail),
    env.DB.prepare("DELETE FROM mutation_guards WHERE id=?").bind(guard),
  );
  const event = {
    id: crypto.randomUUID(),
    event: action,
    repository_id: repo.id,
    actor: user.username,
    detail,
    timestamp: new Date().toISOString(),
  };
  statements.push(
    env.DB.prepare(
      "INSERT INTO deliveries(id,webhook_id,payload) SELECT ?||':'||w.id,w.id,? FROM webhooks w WHERE w.repo_id=? AND EXISTS(SELECT 1 FROM json_each(w.events) WHERE value='*' OR value=?)",
    ).bind(event.id, JSON.stringify(event), repo.id, action),
  );
  try {
    await env.DB.batch(statements);
  } catch (e) {
    if (String(e).includes("CHECK constraint failed"))
      fail(409, "Issue, board or permissions changed; reload before updating");
    throw e;
  }
  return { ok: true, updated: selected.length };
}
interface Helpers {
  access(c: Context<App>, level?: "read" | "write" | "maintain"): Promise<Repo>;
}
export function registerIssueWorkflows(app: Hono<App>, h: Helpers) {
  const base = "/api/repos/:namespace/:repo";
  const notify = (c: Context<App>) => {
    if (c.env.EVENTS) c.executionCtx.waitUntil(publishPending(c.env));
  };
  app.use(base + "/issues/*", async (c, next) => {
    await next();
    if (
      c.res.ok &&
      (c.req.method === "PATCH" ||
        c.req.path.endsWith("/bulk") ||
        c.req.path.endsWith("/planning") ||
        c.req.path.endsWith("/move"))
    )
      notify(c);
  });
  app.use(base + "/issue-boards/*", async (c, next) => {
    await next();
    if (
      c.res.ok &&
      (c.req.method === "PATCH" ||
        c.req.path.endsWith("/bulk") ||
        c.req.path.endsWith("/planning") ||
        c.req.path.endsWith("/move"))
    )
      notify(c);
  });
  const access = async (
    c: Context<App>,
    level: "read" | "write" | "maintain" = "read",
  ) => {
    if (c.get("delegation"))
      fail(403, "Git delegation cannot manage issue workflows");
    return h.access(c, level);
  };
  app.get(base + "/issues", async (c) =>
    c.json(
      await listIssues(c.env, await access(c), c.req.query(), c.get("user")),
    ),
  );
  app.get(base + "/issues/:id", async (c) => {
    const repo = await access(c),
      id = z.coerce.number().int().positive().parse(c.req.param("id")),
      after = z.coerce
        .number()
        .int()
        .min(0)
        .parse(c.req.query("comments_after") || 0);
    const issue = await c.env.DB.prepare(
      "SELECT i.*,u.username AS author,a.username AS assignee,m.title AS milestone FROM issues i JOIN users u ON u.id=i.author_id LEFT JOIN users a ON a.id=i.assignee_id LEFT JOIN milestones m ON m.id=i.milestone_id WHERE i.id=? AND i.repo_id=?",
    )
      .bind(id, repo.id)
      .first<any>();
    if (!issue) fail(404, "Issue not found");
    const [comments, labels] = await Promise.all([
      c.env.DB.prepare(
        "SELECT c.*,u.username AS author FROM comments c JOIN users u ON u.id=c.author_id WHERE c.issue_id=? AND c.id>? ORDER BY c.id LIMIT 201",
      )
        .bind(id, after)
        .all<any>(),
      c.env.DB.prepare(
        "SELECT l.* FROM labels l JOIN issue_labels il ON il.label_id=l.id WHERE il.issue_id=?",
      )
        .bind(id)
        .all<any>(),
    ]);
    return c.json({
      ...issue,
      labels: labels.results,
      comments: comments.results.slice(0, 200),
      comments_next:
        comments.results.length > 200 ? comments.results[199].id : null,
    });
  });
  app.post(base + "/issues/bulk", async (c) => {
    const repo = await access(c, "write"),
      b = await jsonInput(c);
    return c.json(
      await changeIssues(c.env, repo, identity(c), b.issues, b.changes),
    );
  });
  app.put(base + "/issues/:id/planning", async (c) => {
    const repo = await access(c, "write"),
      raw = await jsonInput(c),
      b = z
        .object({
          assignee: slug.nullable().default(null),
          milestone_id: z.string().uuid().nullable().default(null),
          labels: ids.default([]),
          revision: z.number().int().min(0).optional(),
        })
        .parse(raw);
    const issue = await c.env.DB.prepare(
      "SELECT id,revision FROM issues WHERE id=? AND repo_id=?",
    )
      .bind(c.req.param("id"), repo.id)
      .first<any>();
    if (!issue) fail(404, "Issue not found");
    const { revision, ...change } = b;
    return c.json(
      await changeIssues(
        c.env,
        repo,
        identity(c),
        [{ id: issue.id, revision: revision ?? issue.revision }],
        change,
        false,
        undefined,
        "issue.assign",
      ),
    );
  });
  app.patch(base + "/issues/:id", async (c) => {
    const repo = await access(c),
      user = identity(c),
      b = z
        .object({
          state: z.enum(["open", "closed"]).optional(),
          title: z.string().trim().min(1).max(240).optional(),
          body: z.string().max(20000).optional(),
          revision: z.number().int().min(0).optional(),
        })
        .parse(await jsonInput(c));
    if (c.get("scope") === "read") fail(403, "Read-only token");
    const issue = await c.env.DB.prepare(
      "SELECT id,revision FROM issues WHERE id=? AND repo_id=?",
    )
      .bind(c.req.param("id"), repo.id)
      .first<any>();
    if (!issue) fail(404, "Issue not found");
    const { revision, ...change } = b;
    return c.json(
      await changeIssues(
        c.env,
        repo,
        user,
        [{ id: issue.id, revision: revision ?? issue.revision }],
        change,
        true,
        undefined,
        b.state ? "issue." + b.state : "issue.update",
      ),
    );
  });
  const boardInput = z.object({
    name: z.string().trim().min(1).max(80),
    labels: ids.refine((v) => v.length <= 12, "Maximum 12 board columns"),
    revision: z.number().int().min(0).optional(),
  });
  const getBoard = async (c: Context<App>, repo: Repo) => {
    const id = c.req.param("board");
    if (id === "default")
      return { id, name: "All issues", revision: 0, labels: [] as any[] };
    const board = await c.env.DB.prepare(
      "SELECT * FROM issue_boards WHERE id=? AND repo_id=?",
    )
      .bind(id, repo.id)
      .first<any>();
    if (!board) fail(404, "Board not found");
    const rows = await c.env.DB.prepare(
      "SELECT * FROM labels WHERE repo_id=? AND id IN(SELECT value FROM json_each(?))",
    )
      .bind(repo.id, board.label_ids)
      .all<any>();
    return {
      ...board,
      labels: JSON.parse(board.label_ids)
        .map((id: string) => rows.results.find((r) => r.id === id))
        .filter(Boolean),
    };
  };
  app.get(base + "/issue-boards", async (c) => {
    const repo = await access(c);
    return c.json({
      boards: [
        { id: "default", name: "All issues", revision: 0 },
        ...(
          await c.env.DB.prepare(
            "SELECT id,name,revision FROM issue_boards WHERE repo_id=? ORDER BY created_at,id",
          )
            .bind(repo.id)
            .all()
        ).results,
      ],
    });
  });
  app.post(base + "/issue-boards", async (c) => {
    const repo = await access(c, "maintain"),
      b = boardInput.parse(await jsonInput(c));
    const labels = (
      await c.env.DB.prepare(
        "SELECT id FROM labels WHERE repo_id=? AND id IN(SELECT value FROM json_each(?))",
      )
        .bind(repo.id, JSON.stringify(b.labels))
        .all()
    ).results;
    if (labels.length !== b.labels.length) fail(400, "Label not in repository");
    const id = crypto.randomUUID(),
      r = await c.env.DB.prepare(
        "INSERT INTO issue_boards(id,repo_id,name,label_ids) SELECT ?,?,?,? WHERE (SELECT count(*) FROM issue_boards WHERE repo_id=?)<20",
      )
        .bind(id, repo.id, b.name, JSON.stringify(b.labels), repo.id)
        .run();
    if (!r.meta.changes) fail(409, "Maximum 20 boards");
    return c.json({ id }, 201);
  });
  app.get(base + "/issue-boards/:board", async (c) =>
    c.json(await getBoard(c, await access(c))),
  );
  app.put(base + "/issue-boards/:board", async (c) => {
    const repo = await access(c, "maintain"),
      b = boardInput.parse(await jsonInput(c));
    if (b.revision === undefined) fail(400, "Board revision required");
    const labels = (
      await c.env.DB.prepare(
        "SELECT id FROM labels WHERE repo_id=? AND id IN(SELECT value FROM json_each(?))",
      )
        .bind(repo.id, JSON.stringify(b.labels))
        .all()
    ).results;
    if (labels.length !== b.labels.length) fail(400, "Label not in repository");
    const result = await c.env.DB.prepare(
      "UPDATE issue_boards SET name=?,label_ids=?,revision=revision+1 WHERE id=? AND repo_id=? AND revision=?",
    )
      .bind(
        b.name,
        JSON.stringify(b.labels),
        c.req.param("board"),
        repo.id,
        b.revision,
      )
      .run();
    if (!result.meta.changes) fail(409, "Board changed or not found");
    return c.json({ ok: true });
  });
  app.delete(base + "/issue-boards/:board", async (c) => {
    const repo = await access(c, "maintain");
    await c.env.DB.prepare("DELETE FROM issue_boards WHERE id=? AND repo_id=?")
      .bind(c.req.param("board"), repo.id)
      .run();
    return c.json({ ok: true });
  });
  app.get(base + "/issue-boards/:board/cards", async (c) => {
    const repo = await access(c),
      board = await getBoard(c, repo),
      column = c.req.query("column") || "open";
    if (
      !["open", "closed", ...board.labels.map((l: any) => l.id)].includes(
        column,
      )
    )
      fail(404, "Board column not found");
    return c.json(
      await listIssues(c.env, repo, c.req.query(), c.get("user"), {
        state: column === "closed" ? "closed" : "open",
        labels: column === "open" || column === "closed" ? [] : [column],
        exclude: column === "open" ? board.labels.map((l: any) => l.id) : [],
      }),
    );
  });
  app.post(base + "/issue-boards/:board/move", async (c) => {
    const repo = await access(c, "write"),
      board = await getBoard(c, repo),
      b = z
        .object({
          issue: z.object({
            id: z.number().int().positive(),
            revision: z.number().int().min(0),
          }),
          from: z.string(),
          to: z.string(),
          board_revision: z.number().int().min(0),
        })
        .parse(await jsonInput(c)),
      columns = ["open", "closed", ...board.labels.map((l: any) => l.id)];
    if (!columns.includes(b.from) || !columns.includes(b.to))
      fail(400, "Unknown board column");
    if (b.board_revision !== board.revision) fail(409, "Board changed; reload");
    const sourceIssue = await c.env.DB.prepare(
      "SELECT state,revision,(SELECT json_group_array(label_id) FROM issue_labels WHERE issue_id=i.id) AS labels FROM issues i WHERE id=? AND repo_id=?",
    )
      .bind(b.issue.id, repo.id)
      .first<any>();
    if (!sourceIssue) fail(404, "Issue not found");
    const sourceLabels = JSON.parse(sourceIssue.labels || "[]");
    const inSource =
      b.from === "closed"
        ? sourceIssue.state === "closed"
        : sourceIssue.state === "open" &&
          (b.from === "open"
            ? !board.labels.some((l: any) => sourceLabels.includes(l.id))
            : sourceLabels.includes(b.from));
    if (!inSource || sourceIssue.revision !== b.issue.revision)
      fail(409, "Issue moved or changed; reload the board");
    const change: any = { state: b.to === "closed" ? "closed" : "open" };
    if (b.to === "open")
      change.remove_labels = board.labels.map((l: any) => l.id);
    else if (b.to !== "closed") {
      change.add_labels = [b.to];
      if (b.from !== "open" && b.from !== "closed" && b.from !== b.to)
        change.remove_labels = [b.from];
    }
    return c.json(
      await changeIssues(c.env, repo, identity(c), [b.issue], change, false, {
        id: board.id,
        revision: b.board_revision,
      }),
    );
  });
}
