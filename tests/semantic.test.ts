import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support/review-fixture";
import {
  advanceSemantic,
  chunkCode,
  publishSemantic,
  collectSemantic,
  reserveSemanticUsage,
  EMBEDDING_DIMENSIONS,
} from "../src/semantic";
import {
  semanticSearchInput,
  searchWithSemantics,
} from "../src/semantic-search";
import { codeGrams } from "../src/code-search";
function setup() {
  const f = fixture();
  f.db.exec(
    `INSERT INTO credentials(id,hash,user_id,name,kind,scope,expires_at) VALUES('d','dev-token','d','test','pat','write',9999999999999),('o','owner-token','o','test','pat','write',9999999999999);INSERT INTO repositories(id,owner_id,namespace,name,visibility) VALUES('public','a','author','public','public');`,
  );
  const vectors = new Map<string, any>(),
    calls: string[][] = [],
    sent: string[] = [];
  let afterEmbedding: (() => void) | undefined;
  f.env.AI = {
    async run(_model: string, input: { text: string[] }) {
      calls.push(input.text);
      afterEmbedding?.();
      return {
        data: input.text.map(() => Array(EMBEDDING_DIMENSIONS).fill(0.1)),
      };
    },
  } as any;
  f.env.CODE_VECTORS = {
    async upsert(v: any[]) {
      for (const x of v) vectors.set(x.id, x);
      return { mutationId: "x" };
    },
    async query(_v: any, options: any) {
      return {
        matches: [...vectors.values()]
          .filter((v) => options.filter.repo.$in.includes(v.metadata.repo))
          .map((v) => ({ id: v.id, score: 0.8 })),
      };
    },
    async deleteByIds(ids: string[]) {
      for (const id of ids) vectors.delete(id);
    },
  } as any;
  f.env.EVENTS = {
    async send(m: any) {
      sent.push(m.id);
    },
  } as any;
  function document(
    repo: string,
    body: string,
    sha = "a".repeat(40),
    generation = "gen",
    path = "source.ts",
  ) {
    const id = repo + ":" + generation + ":" + path;
    f.db
      .prepare(
        "INSERT INTO code_documents(id,repo_id,generation,path,blob_sha,body,extension) VALUES(?,?,?,?,?,?,?)",
      )
      .run(id, repo, generation, path, sha, body, path.split(".").at(-1)!);
    for (const gram of codeGrams(body))
      f.db
        .prepare("INSERT INTO code_postings(gram,document_id) VALUES(?,?)")
        .run(gram, id);
    f.db
      .prepare(
        "UPDATE code_index_state SET generation=?,indexed_sha=?,indexed_branch='main',indexed_at=1,status='ready',completed=requested WHERE repo_id=?",
      )
      .run(generation, "b".repeat(40), repo);
  }
  async function index(repo: string) {
    await publishSemantic(f.env);
    for (let i = 0; i < 100; i++) {
      await advanceSemantic(f.env, repo);
      const s = f.db
        .prepare("SELECT status FROM semantic_state WHERE repo_id=?")
        .get(repo);
      if (s?.status === "ready" || s?.status === "partial") return;
    }
    throw Error("Index did not finish");
  }
  const search = (
    mode = "semantic",
    user: string | null = "d",
    extra: any = {},
  ) =>
    searchWithSemantics(
      f.env,
      semanticSearchInput.parse({ mode, q: "用户登录权限", ...extra }),
      user
        ? { id: user, credential: user === "d" ? "dev-token" : "owner-token" }
        : null,
    );
  return {
    ...f,
    vectors,
    calls,
    sent,
    document,
    index,
    search,
    afterEmbedding: (fn: () => void) => {
      afterEmbedding = fn;
    },
  };
}
test("code chunks retain line positions, bounded overlap and long-line content", () => {
  const lines = Array.from(
    { length: 150 },
    (_, i) => "const line" + i + " = " + i + ";",
  );
  const { chunks, partial } = chunkCode(lines.join("\n"));
  assert.equal(partial, false);
  assert.ok(chunks.length > 2);
  for (const c of chunks) {
    assert.equal(c.body, lines.slice(c.line - 1, c.end_line).join("\n"));
    assert.ok(c.body.length <= 2000);
  }
  assert.ok(chunks[1].line <= chunks[0].end_line);
  const long = chunkCode("a".repeat(5500));
  assert.equal(long.chunks.map((c) => c.body).join(""), "a".repeat(5500));
  assert.ok(long.chunks.every((c) => c.line === 1 && c.end_line === 1));
  assert.equal(chunkCode("a\n".repeat(50000)).partial, true);
});
test("queue indexing is incremental, reuses unchanged blobs and persists across batches", async () => {
  const f = setup();
  f.document(
    "r",
    Array.from(
      { length: 700 },
      (_, i) => "const item" + i + " = " + i + ";",
    ).join("\n"),
  );
  await f.index("r");
  assert.ok(f.calls.length > 1);
  const first = f.calls.length;
  assert.ok(f.vectors.size > 8);
  f.document(
    "r",
    f.db.prepare("SELECT body FROM code_documents WHERE repo_id='r'").get()!
      .body as string,
    "a".repeat(40),
    "gen2",
    "renamed.ts",
  );
  await f.index("r");
  assert.equal(f.calls.length, first);
  assert.equal((await f.search()).results[0].path, "renamed.ts");
  f.document(
    "r",
    "export function verifySession() { return true; }",
    "c".repeat(40),
    "gen3",
  );
  await f.index("r");
  assert.equal(f.calls.length, first + 2); // one query plus changed-blob inference
  f.db.close();
});
test("vector retrieval enforces live private/public membership and distrusts provider IDs", async () => {
  const f = setup();
  for (const r of ["r", "other", "public"]) {
    f.document(r, "function authorize() { return permission; }");
    await f.index(r);
  }
  assert.deepEqual(
    (await f.search()).results.map((r: any) => r.repo_id).sort(),
    ["public", "r"],
  );
  assert.deepEqual(
    (await f.search("semantic", null)).results.map((r: any) => r.repo_id),
    ["public"],
  );
  f.env.CODE_VECTORS!.query = (async () => ({
    matches: [...f.vectors.keys()].map((id) => ({ id, score: 0.9 })),
  })) as any;
  assert.deepEqual(
    (await f.search()).results.map((r: any) => r.repo_id).sort(),
    ["public", "r"],
  );
  f.afterEmbedding(() =>
    f.db.exec("DELETE FROM members WHERE repo_id='r' AND user_id='d'"),
  );
  assert.deepEqual(
    (await f.search()).results.map((r: any) => r.repo_id),
    ["public"],
  );
  f.db.close();
});
test("revoked credentials, stale generations, deleted repos and branch changes cannot return snippets", async () => {
  const f = setup();
  f.document("r", "private body");
  await f.index("r");
  f.db.exec("UPDATE code_index_state SET generation='new' WHERE repo_id='r'");
  assert.equal((await f.search()).results.length, 0);
  f.db.exec(
    "UPDATE code_index_state SET generation='gen' WHERE repo_id='r'; UPDATE repositories SET default_branch='other' WHERE id='r'",
  );
  assert.equal((await f.search()).results.length, 0);
  f.afterEmbedding(() =>
    f.db.exec("DELETE FROM credentials WHERE hash='dev-token'"),
  );
  f.document("r", "body", "c".repeat(40), "another");
  f.db.exec(
    "UPDATE repositories SET default_branch='main' WHERE id='r'; UPDATE code_index_state SET generation='another',indexed_branch='main' WHERE repo_id='r'",
  );
  await assert.rejects(f.search(), /Invalid or expired/);
  f.db.close();
});
test("file filters, literal fallback and ranked hybrid results retain exact Git locations", async () => {
  const f = setup();
  f.document("r", "const needle = true;");
  await f.index("r");
  const hybrid = await f.search("hybrid", "d", { q: "needle" });
  assert.equal(hybrid.results.length, 1);
  assert.equal(hybrid.results[0].match, "hybrid");
  assert.equal(hybrid.results[0].indexed_sha, "b".repeat(40));
  assert.equal(
    (await f.search("semantic", "d", { path: "missing" })).results.length,
    0,
  );
  assert.equal(
    (await f.search("semantic", "d", { extension: "py" })).results.length,
    0,
  );
  f.env.AI = undefined;
  const fallback = await f.search("hybrid", "d", { q: "needle" });
  assert.ok("semantic" in fallback);
  assert.equal(fallback.semantic?.available, false);
  assert.equal(fallback.results.length, 1);
  await assert.rejects(f.search(), /not enabled/);
  await assert.rejects(
    f.search("hybrid", "d", { cursor: "old" }),
    /without cursors/,
  );
  f.db.close();
});
test("budget reservations are atomic, failures preserve outbox IDs and retries are bounded", async () => {
  const f = setup();
  f.db.exec("UPDATE semantic_settings SET daily_chars=1000");
  await reserveSemanticUsage(f.env, "index", 900);
  await assert.rejects(reserveSemanticUsage(f.env, "query", 101), /budget/);
  await reserveSemanticUsage(f.env, "query", 100);
  f.document("r", "new content");
  await publishSemantic(f.env);
  await assert.rejects(advanceSemantic(f.env, "r"), /budget/);
  assert.equal(
    f.db.prepare("SELECT status FROM semantic_state WHERE repo_id='r'").get()!
      .status,
    "failed",
  );
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM semantic_chunks").get()!.n,
    1,
  );
  const n = f.calls.length;
  await advanceSemantic(f.env, "r");
  assert.equal(f.calls.length, n);
  f.db.close();
});
test("active leases avoid duplicate inference; expired owners cannot publish over a rebuild", async () => {
  const f = setup();
  f.document("r", "content");
  await publishSemantic(f.env);
  f.db
    .prepare(
      "UPDATE semantic_state SET lease='busy',lease_until=? WHERE repo_id='r'",
    )
    .run(Date.now() + 100000);
  await advanceSemantic(f.env, "r");
  assert.equal(f.calls.length, 0);
  f.db.exec("UPDATE semantic_state SET lease_until=0 WHERE repo_id='r'");
  f.afterEmbedding(() =>
    f.db.exec(
      "UPDATE semantic_state SET lease='replacement' WHERE repo_id='r'",
    ),
  );
  await advanceSemantic(f.env, "r");
  assert.equal(f.vectors.size, 0);
  assert.equal(
    f.db.prepare("SELECT lease FROM semantic_state WHERE repo_id='r'").get()!
      .lease,
    "replacement",
  );
  f.db.close();
});
test("garbage collection removes vectors after project deletion and preserves live content", async () => {
  const f = setup();
  f.document("r", "private body");
  await f.index("r");
  f.db.exec("UPDATE semantic_chunks SET touched_at=1");
  await collectSemantic(f.env);
  assert.equal(f.vectors.size, 1);
  f.db.exec("UPDATE repositories SET deleted_at='now' WHERE id='r'");
  await collectSemantic(f.env);
  assert.equal(f.vectors.size, 0);
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM semantic_chunks").get()!.n,
    0,
  );
  f.db.close();
});
test("hybrid final merge rechecks access after its independent retrievals", async () => {
  const f = setup();
  f.document("r", "needle");
  await f.index("r");
  const prepare = f.env.DB.prepare.bind(f.env.DB);
  let reads = 0;
  f.env.DB.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (sql.includes("FROM candidates d")) {
      const run = statement.run.bind(statement);
      statement.run = async () => {
        f.db.exec("DELETE FROM members WHERE user_id='d' AND repo_id='r'");
        reads++;
        return run();
      };
    }
    return statement;
  }) as any;
  const result = await f.search("hybrid", "d", { q: "needle" });
  assert.equal(reads, 1);
  assert.equal(result.results.length, 0);
  f.db.close();
});
test("query rate controls are separate from the daily budget and do not call AI on rejection", async () => {
  const f = setup();
  f.document("r", "body");
  await f.index("r");
  f.db
    .prepare("INSERT INTO semantic_rate VALUES(?,?,20)")
    .run("d", Math.floor(Date.now() / 60000));
  const before = f.calls.length;
  await assert.rejects(f.search(), /rate limit/);
  assert.equal(f.calls.length, before);
  f.db.close();
});
