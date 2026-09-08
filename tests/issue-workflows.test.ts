import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import {
  listIssues,
  changeIssues,
  registerIssueWorkflows,
  createIssue,
  createIssueComment,
} from "../src/issue-workflows";
import { fixture } from "./support/review-fixture";
import { repositoryRole, roleRank } from "../src/access";
import type { App, User } from "../src/types";
function setup() {
  const f = fixture(),
    labels = Array.from({ length: 3 }, () => crypto.randomUUID());
  for (const [i, id] of labels.entries())
    f.db
      .prepare("INSERT INTO labels(id,repo_id,name) VALUES(?,?,?)")
      .run(id, i === 2 ? "other" : "r", "Label " + i);
  const milestone = crypto.randomUUID();
  f.db
    .prepare(
      "INSERT INTO milestones(id,repo_id,title) VALUES(?,'r','Milestone')",
    )
    .run(milestone);
  for (let i = 1; i <= 205; i++)
    f.db
      .prepare(
        "INSERT INTO issues(id,repo_id,author_id,title,body,state,assignee_id,milestone_id) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        i,
        i === 205 ? "other" : "r",
        i % 2 ? "a" : "o",
        "Issue " + i,
        i === 2 ? "100%_ literal" : "Description",
        i % 3 ? "open" : "closed",
        i % 2 ? "d" : null,
        i % 2 ? milestone : null,
      );
  f.db.prepare("INSERT INTO issue_labels VALUES(1,?)").run(labels[0]);
  f.db.prepare("INSERT INTO issue_labels VALUES(1,?)").run(labels[1]);
  const user = { id: "d", username: "dev", admin: 0 } as User;
  const issue = (id: number) =>
    f.db.prepare("SELECT * FROM issues WHERE id=?").get(id) as any;
  return { ...f, labels, milestone, user, issue };
}
test("issue keyset pagination covers all rows without leaking another project; filters are conjunctive and counts span pages", async () => {
  const f = setup();
  let cursor: string | null = null,
    seen: number[] = [];
  do {
    const p = await listIssues(
      f.env,
      f.repo,
      { limit: 37, ...(cursor ? { cursor } : {}) },
      f.user,
    );
    assert.equal(p.total, 204);
    seen.push(...p.issues.map((i) => i.id));
    cursor = p.next_cursor;
  } while (cursor);
  assert.equal(seen.length, 204);
  assert.equal(new Set(seen).size, 204);
  assert.equal(seen.includes(205), false);
  const p = await listIssues(
    f.env,
    f.repo,
    {
      assignee: "dev",
      author: "author",
      state: "open",
      milestone: f.milestone,
      labels: f.labels.slice(0, 2).join(","),
    },
    f.user,
  );
  assert.deepEqual(
    p.issues.map((i) => i.id),
    [1],
  );
  assert.equal(p.issues[0].labels.length, 2);
  assert.equal(p.issues[0].assignee, "dev");
  assert.deepEqual(
    (await listIssues(f.env, f.repo, { q: "100%_" }, f.user)).issues.map(
      (i) => i.id,
    ),
    [2],
  );
  const first = await listIssues(f.env, f.repo, { limit: 1 }, f.user);
  await assert.rejects(
    listIssues(
      f.env,
      f.repo,
      { limit: 1, state: "open", cursor: first.next_cursor },
      f.user,
    ),
    /Cursor/,
  );
  await assert.rejects(
    listIssues(f.env, f.repo, { cursor: btoa("null") }, f.user),
    /Invalid issue cursor/,
  );
  await assert.rejects(
    listIssues(f.env, f.repo, { assignee: "me" }, null),
    /Sign in/,
  );
  assert.equal(
    (await listIssues(f.env, f.repo, { assignee: "none" }, f.user)).total,
    102,
  );
});
test("bulk mutations atomically reject stale/cross-project selections and preserve all unaffected labels", async () => {
  const f = setup();
  f.db.exec(
    `INSERT INTO webhooks(id,repo_id,url,events,secret) VALUES('hook','r','https://example.invalid','["*"]','test')`,
  );
  const one = f.issue(1),
    two = f.issue(2);
  await assert.rejects(
    changeIssues(
      f.env,
      f.repo,
      f.user,
      [
        { id: 1, revision: one.revision },
        { id: 2, revision: 99 },
      ],
      { state: "closed" },
    ),
    /changed/,
  );
  assert.equal(f.issue(1).state, "open");
  assert.equal(f.issue(1).revision, one.revision);
  await assert.rejects(
    changeIssues(
      f.env,
      f.repo,
      f.user,
      [
        { id: 1, revision: one.revision },
        { id: 205, revision: 0 },
      ],
      { state: "closed" },
    ),
    /changed/,
  );
  await changeIssues(
    f.env,
    f.repo,
    f.user,
    [
      { id: 1, revision: one.revision },
      { id: 2, revision: two.revision },
    ],
    {
      state: "closed",
      assignee: "owner",
      milestone_id: f.milestone,
      remove_labels: [f.labels[0]],
      add_labels: [f.labels[1]],
    },
  );
  assert.equal(f.issue(1).state, "closed");
  assert.equal(f.issue(2).assignee_id, "o");
  const deliveries = f.db.prepare("SELECT payload FROM deliveries").all();
  assert.equal(deliveries.length, 1);
  assert.equal(
    JSON.parse(deliveries[0].payload as string).event,
    "issue.bulk_update",
  );
  assert.deepEqual(
    f.db
      .prepare("SELECT label_id FROM issue_labels WHERE issue_id=1")
      .all()
      .map((r) => r.label_id),
    [f.labels[1]],
  );
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM mutation_guards").get()!.n,
    0,
  );
  await assert.rejects(
    changeIssues(
      f.env,
      f.repo,
      f.user,
      [{ id: 2, revision: f.issue(2).revision }],
      { add_labels: [f.labels[2]] },
    ),
    /not in repository/,
  );
});
test("permission revocation or foreign-key changes immediately before D1 batch cannot permit partial issue writes", async () => {
  const f = setup(),
    batch = f.env.DB.batch.bind(f.env.DB);
  let mutate = () => f.db.exec("DELETE FROM members WHERE user_id='d'");
  f.env.DB.batch = async (statements: any) => {
    mutate();
    return batch(statements);
  };
  await assert.rejects(
    changeIssues(
      f.env,
      f.repo,
      f.user,
      [{ id: 2, revision: f.issue(2).revision }],
      { title: "Forbidden" },
    ),
    /changed/,
  );
  assert.equal(f.issue(2).title, "Issue 2");
  f.db.exec("INSERT INTO members VALUES('r','d','developer')");
  mutate = () => {
    f.db.prepare("DELETE FROM labels WHERE id=?").run(f.labels[0]);
  };
  await assert.rejects(
    changeIssues(
      f.env,
      f.repo,
      f.user,
      [{ id: 2, revision: f.issue(2).revision }],
      { state: "closed", add_labels: [f.labels[0]] },
    ),
    /changed/,
  );
  assert.equal(f.issue(2).state, "open");
});
test("authors can edit only their own issue, and planning/other issue changes still require project membership", async () => {
  const f = setup(),
    author = { id: "a", username: "author", admin: 0 };
  f.db.exec(
    "DELETE FROM members WHERE user_id='a';UPDATE repositories SET visibility='public' WHERE id='r'",
  );
  await changeIssues(
    f.env,
    f.repo,
    author,
    [{ id: 1, revision: f.issue(1).revision }],
    { title: "Mine" },
    true,
  );
  assert.equal(f.issue(1).title, "Mine");
  await assert.rejects(
    changeIssues(
      f.env,
      f.repo,
      author,
      [{ id: 2, revision: f.issue(2).revision }],
      { title: "Not mine" },
      true,
    ),
    /changed/,
  );
  await assert.rejects(
    changeIssues(
      f.env,
      f.repo,
      author,
      [{ id: 1, revision: f.issue(1).revision }],
      { assignee: "owner" },
      true,
    ),
    /Developer/,
  );
});
test("incremental labels enforce a total limit and reject overflow before changing state", async () => {
  const f = setup(),
    all = Array.from({ length: 51 }, () => crypto.randomUUID());
  for (const id of all)
    f.db
      .prepare("INSERT INTO labels(id,repo_id,name) VALUES(?,'r',?)")
      .run(id, id);
  for (const id of all.slice(0, 50))
    f.db.prepare("INSERT INTO issue_labels VALUES(2,?)").run(id);
  await assert.rejects(
    changeIssues(
      f.env,
      f.repo,
      f.user,
      [{ id: 2, revision: f.issue(2).revision }],
      { state: "closed", add_labels: [all[50]] },
    ),
    /changed/,
  );
  assert.equal(f.issue(2).state, "open");
  await changeIssues(
    f.env,
    f.repo,
    f.user,
    [{ id: 2, revision: f.issue(2).revision }],
    { remove_labels: [all[0]], add_labels: [all[50]] },
  );
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM issue_labels WHERE issue_id=2").get()!
      .n,
    50,
  );
});
test("actual board routes persist views and move cards with source/version checks, preserving non-board labels and private access", async () => {
  const f = setup(),
    app = new Hono<App>();
  app.onError((e, c) =>
    c.json(
      { error: e.message },
      e instanceof HTTPException ? e.status : e instanceof ZodError ? 400 : 500,
    ),
  );
  app.use("*", async (c, next) => {
    c.set(
      "user",
      c.req.header("x-test-user") === "guest"
        ? null
        : { id: "o", username: "owner", admin: 0 },
    );
    c.set("scope", c.req.header("x-read-only") ? "read" : "write");
    await next();
  });
  registerIssueWorkflows(app, {
    access: async (c, level = "read") => {
      const u = c.get("user"),
        role = await repositoryRole(c.env, f.repo, u);
      c.set("repoRole", role);
      if (
        !u ||
        roleRank[role] < (level === "read" ? 1 : level === "write" ? 2 : 3)
      )
        throw new HTTPException(404, { message: "Not found" });
      if (level !== "read" && c.get("scope") === "read")
        throw new HTTPException(403, { message: "Read-only token" });
      return f.repo;
    },
  });
  const api = async (
    path: string,
    method = "GET",
    body?: any,
    status = 200,
    headers: any = {},
  ) => {
    const response = await app.request(
      "http://test/api/repos/owner/repo" + path,
      {
        method,
        headers: { "content-type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      f.env,
    );
    const data = (await response.json()) as any;
    assert.equal(response.status, status, JSON.stringify(data));
    return data;
  };
  for (let n = 0; n < 205; n++)
    f.db
      .prepare("INSERT INTO comments(issue_id,author_id,body) VALUES(1,'o',?)")
      .run("Comment " + n);
  const firstComments = await api("/issues/1");
  assert.equal(firstComments.comments.length, 200);
  const nextComments = await api(
    "/issues/1?comments_after=" + firstComments.comments_next,
  );
  assert.equal(nextComments.comments.length, 5);
  assert.equal(nextComments.comments_next, null);
  await api("/issues/1?comments_after=-1", "GET", undefined, 400);
  await api("/issues/205", "GET", undefined, 404);
  const b = await api(
      "/issue-boards",
      "POST",
      { name: "Workflow", labels: [f.labels[0]] },
      201,
    ),
    board = await api("/issue-boards/" + b.id);
  assert.equal(board.labels.length, 1);
  assert.equal(
    (await api("/issue-boards/" + b.id + "/cards?column=" + f.labels[0]))
      .issues[0].id,
    1,
  );
  await api(
    "/issue-boards/" + b.id + "/move",
    "POST",
    {
      issue: { id: 1, revision: f.issue(1).revision },
      from: "open",
      to: "closed",
      board_revision: 0,
    },
    409,
  );
  await api("/issue-boards/" + b.id + "/move", "POST", {
    issue: { id: 1, revision: f.issue(1).revision },
    from: f.labels[0],
    to: "open",
    board_revision: 0,
  });
  assert.deepEqual(
    f.db
      .prepare("SELECT label_id FROM issue_labels WHERE issue_id=1")
      .all()
      .map((r) => r.label_id),
    [f.labels[1]],
  );
  const revision = f.issue(1).revision;
  await api("/issue-boards/" + b.id, "PUT", {
    name: "Changed",
    labels: [f.labels[0]],
    revision: 0,
  });
  await api(
    "/issue-boards/" + b.id + "/move",
    "POST",
    {
      issue: { id: 1, revision },
      from: "open",
      to: "closed",
      board_revision: 0,
    },
    409,
  );
  await api("/issue-boards/" + b.id + "/move", "POST", {
    issue: { id: 1, revision },
    from: "open",
    to: "closed",
    board_revision: 1,
  });
  assert.equal(f.issue(1).state, "closed");
  await api("/issue-boards/" + b.id + "/cards", "GET", undefined, 404, {
    "x-test-user": "guest",
  });
  await api(
    "/issues/bulk",
    "POST",
    {
      issues: [{ id: 1, revision: f.issue(1).revision }],
      changes: { state: "open" },
    },
    403,
    { "x-read-only": "1" },
  );
  await api("/issue-boards/" + b.id, "DELETE");
  assert.equal(f.issue(1).state, "closed");
});

test("an author loses mutation access when the project becomes private before commit", async () => {
  const f = setup(),
    author = { id: "a", username: "author", admin: 0 };
  f.db.exec(
    "DELETE FROM members WHERE user_id='a';UPDATE repositories SET visibility='public' WHERE id='r'",
  );
  const batch = f.env.DB.batch.bind(f.env.DB);
  f.env.DB.batch = async (stmts: any) => {
    f.db.exec("UPDATE repositories SET visibility='private' WHERE id='r'");
    return batch(stmts);
  };
  await assert.rejects(
    changeIssues(
      f.env,
      { ...f.repo, visibility: "public" },
      author,
      [{ id: 1, revision: f.issue(1).revision }],
      { title: "Forbidden" },
      true,
    ),
    /changed/,
  );
  assert.equal(f.issue(1).title, "Issue 1");
});

test("issue creation and comments recheck live read access and disabled accounts at insertion", async () => {
  const f = setup();
  f.db.exec("DELETE FROM members WHERE user_id='d'");
  await assert.rejects(
    createIssue(f.env, f.repo, f.user, "No access", ""),
    /access changed/,
  );
  await assert.rejects(
    createIssueComment(f.env, f.repo, f.user, 1, "No access"),
    /access changed/,
  );
  f.db.exec("UPDATE repositories SET visibility='public' WHERE id='r'");
  const made = await createIssue(
    f.env,
    f.repo,
    f.user,
    "Public contribution",
    "",
  );
  assert.equal(made.author_id, "d");
  await createIssueComment(f.env, f.repo, f.user, made.id, "Public comment");
  f.db.exec("UPDATE users SET disabled=1 WHERE id='d'");
  await assert.rejects(
    createIssueComment(f.env, f.repo, f.user, made.id, "Disabled"),
    /access changed/,
  );
  assert.equal(
    f.db
      .prepare("SELECT count(*) n FROM comments WHERE issue_id=?")
      .get(made.id)!.n,
    1,
  );
});
