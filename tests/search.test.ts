import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { fixture } from "./support/review-fixture";
import {
  registerSearch,
  searchCollaboration,
  searchInput,
} from "../src/search";
import type { App } from "../src/types";

function setup() {
  const f = fixture();
  f.db.exec(`
    INSERT INTO credentials(id,hash,user_id,name,kind,scope,expires_at) VALUES
      ('o','owner-token','o','test','pat','read',9999999999999),
      ('d','dev-token','d','test','session','write',9999999999999),
      ('a','author-token','a','test','pat','write',9999999999999),
      ('g','guest-token','g','test','pat','read',9999999999999);
    UPDATE repositories SET description='Needle project';
    INSERT INTO repositories(id,owner_id,namespace,name,visibility,description) VALUES('public','a','author','public','public','Needle project');
    INSERT INTO workspaces(id,slug,name) VALUES('w','team','Team');
    INSERT INTO workspace_members VALUES('w','a','owner'),('w','d','reader');
    INSERT INTO repositories(id,owner_id,namespace,name,visibility,workspace_id,description) VALUES('team','o','team','project','private','w','Needle project');
    INSERT INTO issues(id,repo_id,author_id,title,body) VALUES
      (1,'r','o','Needle private','private body'),(2,'other','o','Needle other','other body'),
      (3,'public','a','Needle public','public body'),(4,'team','a','Needle team','team body');
    UPDATE merge_requests SET title='Needle merge',body='merge body';
    INSERT INTO wiki_pages(repo_id,slug,title,body,author_id) VALUES('r','guide','Needle wiki','wiki body','o');
  `);
  const search = (user: string | null, options: Record<string, unknown> = {}) =>
    searchCollaboration(
      f.env,
      searchInput.parse({ q: "needle", ...options }),
      user
        ? {
            id: user,
            credential:
              ({ o: "owner", d: "dev", a: "author", g: "guest" } as any)[user] +
              "-token",
          }
        : null,
    );
  return { ...f, search };
}
test("cross-project search enforces direct, inherited, public and personal-owner access without admin bypass", async () => {
  const f = setup();
  const repos = (rows: any) =>
    [...new Set(rows.results.map((r: any) => r.repo_id))].sort();
  assert.deepEqual(repos(await f.search(null)), ["public"]);
  assert.deepEqual(repos(await f.search("g")), ["public"]);
  assert.deepEqual(repos(await f.search("o")), ["other", "public", "r"]);
  assert.deepEqual(repos(await f.search("d")), ["public", "r", "team"]);
  f.db.exec("UPDATE users SET admin=1 WHERE id='g'");
  assert.deepEqual(repos(await f.search("g")), ["public"]);
  f.db.exec(
    "DELETE FROM members WHERE user_id='d';DELETE FROM workspace_members WHERE user_id='d'",
  );
  assert.deepEqual(repos(await f.search("d")), ["public"]);
});
test("search validates the credential and disabled status in its D1 read transaction", async () => {
  for (const mutation of [
    "UPDATE users SET disabled=1 WHERE id='d'",
    "DELETE FROM credentials WHERE user_id='d'",
    "UPDATE credentials SET expires_at=0 WHERE user_id='d'",
    "UPDATE credentials SET user_id='g' WHERE user_id='d'",
  ]) {
    const f = setup();
    f.db.exec(mutation);
    await assert.rejects(f.search("d"), /Invalid or expired/);
  }
});
test("keyset pages visit all kinds and projects once; cursors are bound to identity and filters", async () => {
  const f = setup(),
    expected = (await f.search("o")).results;
  let cursor: string | null = null;
  const seen = [];
  do {
    const page = await f.search("o", {
      limit: 1,
      ...(cursor ? { cursor } : {}),
    });
    seen.push(...page.results);
    cursor = page.next_cursor;
  } while (cursor);
  assert.deepEqual(seen, expected);
  assert.deepEqual(
    [...new Set(seen.map((r) => r.type))],
    ["issue", "merge", "project", "wiki"],
  );
  const first = await f.search("o", { limit: 1 });
  for (const change of [
    { q: "other" },
    { type: "wiki" },
    { namespace: "team" },
    { archived: "only" },
    { state: "open" },
  ])
    await assert.rejects(
      f.search("o", { cursor: first.next_cursor, ...change }),
      /Invalid search cursor/,
    );
  await assert.rejects(
    f.search("d", { cursor: first.next_cursor }),
    /Invalid search cursor/,
  );
  await assert.rejects(
    f.search("o", { cursor: "not-json" }),
    /Invalid search cursor/,
  );
  // Removing a preceding row cannot shift an offset and skip later records.
  f.db.exec("DELETE FROM issues WHERE id=2");
  const rest = await f.search("o", { cursor: first.next_cursor });
  assert.deepEqual(rest.results, expected.slice(1));
});
test("visibility changes, transfers, removals and archive filters use current repository state", async () => {
  const f = setup();
  f.db.exec("UPDATE repositories SET visibility='private' WHERE id='public'");
  assert.equal((await f.search(null)).results.length, 0);
  f.db.exec(
    "UPDATE repositories SET namespace='moved',name='new-name',workspace_id='w' WHERE id='r'",
  );
  assert.equal(
    (await f.search("o")).results.some((r) => r.repo_id === "r"),
    false,
  );
  const rows = (await f.search("a", { namespace: "MOVED" })).results;
  assert.equal(rows.length, 4);
  assert.ok(
    rows.every((r) => r.namespace === "moved" && r.name === "new-name"),
  );
  f.db.exec("UPDATE repositories SET archived_at=datetime('now') WHERE id='r'");
  assert.equal((await f.search("a", { archived: "only" })).results.length, 4);
  assert.equal(
    (await f.search("a", { archived: "exclude", namespace: "moved" })).results
      .length,
    0,
  );
  f.db.exec("UPDATE repositories SET deleted_at=datetime('now') WHERE id='r'");
  assert.equal((await f.search("a", { namespace: "moved" })).results.length, 0);
});
test("literal Chinese, punctuation and long-body matches return useful bounded excerpts with no SQL wildcard syntax", async () => {
  const f = setup(),
    body =
      "x".repeat(2000) +
      "100%_\\ cloud 中文检索 <img onerror=alert(1)>" +
      "y".repeat(1000);
  f.db.prepare("UPDATE issues SET title='title',body=? WHERE id=1").run(body);
  for (const q of ["100%_\\", "中文检索", "<img", "CLOUD"]) {
    const page = await f.search("o", { q, type: "issue" });
    assert.equal(page.results.length, 1);
    assert.match(page.results[0].excerpt, /中文检索/);
    assert.ok(page.results[0].excerpt.length <= 320);
  }
  assert.equal((await f.search("o", { q: "' OR 1=1 --" })).results.length, 0);
  assert.equal((await f.search("o", { q: "%" })).results.length, 1);
  for (const b of [
    { q: "" },
    { q: "a\nb" },
    { q: "x".repeat(129) },
    { limit: 51 },
    { type: "code" },
    { state: "invalid" },
  ])
    assert.equal(searchInput.safeParse({ q: "needle", ...b }).success, false);
});
test("type and state filters cover current Wiki only, omit comments, and track edits immediately", async () => {
  const f = setup();
  f.db.exec(
    "UPDATE issues SET state='closed' WHERE id=1;UPDATE merge_requests SET state='merged';UPDATE wiki_pages SET title='New title',body='New content',version=2 WHERE repo_id='r';INSERT INTO comments(issue_id,author_id,body) VALUES(1,'o','CommentOnly')",
  );
  assert.equal((await f.search("o", { type: "wiki" })).results.length, 0);
  assert.equal(
    (await f.search("o", { q: "New content", type: "wiki" })).results.length,
    1,
  );
  assert.equal((await f.search("o", { q: "CommentOnly" })).results.length, 0);
  assert.equal((await f.search("o", { state: "closed" })).results.length, 1);
  assert.equal(
    (await f.search("o", { state: "merged" })).results[0].type,
    "merge",
  );
  assert.equal(
    (await f.search("o", { state: "open", type: "project" })).results.length,
    0,
  );
});
test("the global route refuses delegated Git and deploy identities", async () => {
  for (const kind of ["delegation", "deploy"] as const) {
    const f = setup(),
      app = new Hono<App>();
    app.use("*", async (c, next) => {
      c.set(kind, {} as any);
      await next();
    });
    registerSearch(app);
    const response = await app.request("/api/search?q=needle", {}, f.env);
    assert.equal(response.status, 403);
  }
});

test("pagination searches beyond the repository listing's first hundred projects", async () => {
  const f = setup();
  const insert = f.db.prepare(
    "INSERT INTO repositories(id,owner_id,namespace,name,visibility,description) VALUES(?,'o','owner',?,'private','BeyondFirstHundred')",
  );
  for (let i = 0; i < 151; i++)
    insert.run("scale-" + String(i).padStart(3, "0"), "scale-" + i);
  let cursor: string | null = null;
  const ids: string[] = [];
  do {
    const page = await f.search("o", {
      q: "BeyondFirstHundred",
      limit: 50,
      ...(cursor ? { cursor } : {}),
    });
    ids.push(...page.results.map((r) => r.repo_id));
    cursor = page.next_cursor;
  } while (cursor);
  assert.equal(ids.length, 151);
  assert.equal(new Set(ids).size, 151);
  assert.equal(ids.at(-1), "scale-150");
  assert.equal(
    (await f.search(null, { q: "BeyondFirstHundred" })).results.length,
    0,
  );
});
