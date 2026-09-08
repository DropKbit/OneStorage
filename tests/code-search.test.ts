import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support/review-fixture";
import { codeGrams, codeSearchInput, searchCode } from "../src/code-search";

function setup() {
  const f = fixture();
  f.db
    .exec(`INSERT INTO credentials(id,hash,user_id,name,kind,expires_at) VALUES('d','dev-token','d','test','pat',9999999999999),('g','guest-token','g','test','session',9999999999999),('o','owner-token','o','test','pat',9999999999999);
 INSERT INTO repositories(id,owner_id,namespace,name,visibility) VALUES('public','a','author','public','public');
 INSERT INTO workspaces(id,slug,name) VALUES('w','team','Team');INSERT INTO workspace_members VALUES('w','a','owner'),('w','d','reader');
 INSERT INTO repositories(id,owner_id,namespace,name,workspace_id,visibility) VALUES('team','o','team','project','w','private');`);
  function document(
    repo: string,
    path: string,
    body: string,
    generation = "gen",
  ) {
    const id = repo + ":" + generation + ":" + path;
    f.db
      .prepare(
        "INSERT INTO code_documents(id,repo_id,generation,path,blob_sha,body,extension) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        id,
        repo,
        generation,
        path,
        "a".repeat(40),
        body,
        path.split(".").at(-1)!,
      );
    const put = f.db.prepare(
      "INSERT INTO code_postings(gram,document_id) VALUES(?,?)",
    );
    for (const gram of codeGrams(body)) put.run(gram, id);
    return id;
  }
  for (const r of ["r", "other", "team", "public"]) {
    document(
      r,
      "source.ts",
      'first line\nconst Needle = "中文搜索";\nthird line',
    );
    f.db
      .prepare(
        "UPDATE code_index_state SET generation='gen',indexed_sha=?,indexed_branch='main',indexed_at=1,status='ready',completed=requested WHERE repo_id=?",
      )
      .run("b".repeat(40), r);
  }
  const search = (user: string | null, options: Record<string, unknown> = {}) =>
    searchCode(
      f.env,
      codeSearchInput.parse({ q: "needle", ...options }),
      user
        ? {
            id: user,
            credential:
              ({ d: "dev", o: "owner", g: "guest" } as any)[user] + "-token",
          }
        : null,
    );
  return { ...f, document, search };
}
test("global code search combines inverted index with live private/public/inherited ACLs", async () => {
  const f = setup(),
    repos = (r: any) => r.results.map((x: any) => x.repo_id).sort();
  assert.deepEqual(repos(await f.search(null)), ["public"]);
  assert.deepEqual(repos(await f.search("o")), ["other", "public", "r"]);
  assert.deepEqual(repos(await f.search("d")), ["public", "r", "team"]);
  f.db.exec("UPDATE users SET admin=1 WHERE id='g'");
  assert.deepEqual(repos(await f.search("g")), ["public"]);
  f.db.exec(
    "DELETE FROM members WHERE user_id='d';DELETE FROM workspace_members WHERE user_id='d';UPDATE repositories SET visibility='private' WHERE id='public'",
  );
  assert.deepEqual(repos(await f.search("d")), []);
});
test("code index only exposes a published generation, with bounded snippets and coverage status", async () => {
  const f = setup();
  f.document("r", "pending.ts", "pending needle", "pending");
  let result = await f.search("d");
  assert.equal(result.results.length, 3);
  assert.equal(result.results[0].line, 2);
  assert.equal(Object.hasOwn(result.results[0], "body"), false);
  assert.equal(result.coverage.indexed_projects, 3);
  f.db.exec(
    "UPDATE code_index_state SET requested=requested+1,status='indexing' WHERE repo_id='r'",
  );
  result = await f.search("d");
  assert.equal(result.results.find((r) => r.repo_id === "r")!.stale, true);
  assert.equal(result.coverage.pending_projects, 1);
  f.db.exec("UPDATE repositories SET default_branch='next' WHERE id='r'");
  result = await f.search("d");
  assert.equal(
    result.results.some((r) => r.repo_id === "r"),
    false,
  );
  assert.equal(result.coverage.indexed_projects, 2);
});
test("literal grams handle Unicode, punctuation and overlapping terms without tokenizer/operator semantics", async () => {
  const f = setup();
  f.document(
    "public",
    "special.ts",
    "one\n😀中文搜索 aaaab a%_b 'quoted' NOT NEAR test",
  );
  for (const q of ["😀中文", "中文搜", "aaaab", "a%_b", "'quoted'", "NOT NEAR"])
    assert.equal(
      (await f.search(null, { q })).results.some(
        (r) => r.path === "special.ts",
      ),
      true,
      q,
    );
  assert.equal((await f.search(null, { q: "AAAAB" })).results.length, 1);
  assert.equal((await f.search(null, { q: "aaaaab" })).results.length, 0);
  assert.throws(() => codeSearchInput.parse({ q: "😀中" }));
});
test("search cursor uses visible result keys and rejects changed identity/filters; current credentials rechecked", async () => {
  const f = setup();
  const first = await f.search("d", { limit: 1 });
  assert.ok(first.next_cursor);
  const all = [...first.results];
  let cursor: string | null = first.next_cursor;
  while (cursor) {
    const page = await f.search("d", { limit: 1, cursor });
    all.push(...page.results);
    cursor = page.next_cursor;
  }
  assert.equal(all.length, 3);
  assert.equal(new Set(all.map((x) => x.repo_id + ":" + x.path)).size, 3);
  await assert.rejects(f.search("o", { cursor: first.next_cursor }), /cursor/);
  await assert.rejects(
    f.search("d", { cursor: first.next_cursor, path: "src" }),
    /cursor/,
  );
  f.db.exec("DELETE FROM credentials WHERE user_id='d'");
  await assert.rejects(
    f.search("d", { cursor: first.next_cursor }),
    /Invalid or expired/,
  );
});
test("path, extension, namespace, lifecycle and archive filters do not leak other scopes", async () => {
  const f = setup();
  f.document("r", "docs/guide.md", "needle");
  assert.deepEqual(
    (await f.search("d", { extension: "MD" })).results.map((r) => r.path),
    ["docs/guide.md"],
  );
  assert.deepEqual(
    (await f.search("d", { path: "docs/" })).results.map((r) => r.path),
    ["docs/guide.md"],
  );
  assert.equal((await f.search("d", { namespace: "team" })).results.length, 1);
  f.db.exec("UPDATE repositories SET archived_at=datetime('now') WHERE id='r'");
  assert.equal((await f.search("d", { archived: "only" })).results.length, 2);
  f.db.exec("UPDATE repositories SET deleted_at=datetime('now') WHERE id='r'");
  assert.equal((await f.search("d", { archived: "only" })).results.length, 0);
});
