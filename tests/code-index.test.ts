import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support/review-fixture";
import { ForgeRepository } from "../src/git/forge";
import {
  advanceCodeIndex,
  stageCodeIndex,
  publishCodeIndexes,
} from "../src/code-index";
import { codeSearchInput, searchCode } from "../src/code-search";

async function setup() {
  const f = fixture();
  f.db.exec("UPDATE repositories SET visibility='public' WHERE id='r'");
  const files = Object.fromEntries(
    Array.from({ length: 20 }, (_, i) => [
      "src/file" + String(i).padStart(2, "0") + ".ts",
      "line one\nconst needle = " + i,
    ]),
  );
  const sha = await f.commit(files);
  await f.store.flush();
  const git = new ForgeRepository(
    f.store,
    { get: async () => undefined, put: async () => {} },
    { "refs/heads/main": sha },
    "main",
    { rules: [] },
  );
  const tick = () => advanceCodeIndex(f.env, f.repo, git);
  const settle = async () => {
    for (let i = 0; i < 50; i++) if (!(await tick())) return;
    throw Error("index did not settle");
  };
  const search = (q = "needle") =>
    searchCode(f.env, codeSearchInput.parse({ q }), null);
  return { ...f, files, sha, git, tick, settle, search };
}
test("index builds a private staging generation incrementally, then atomically publishes one Git snapshot", async () => {
  const f = await setup();
  await f.tick();
  await f.tick();
  assert.ok(
    Number(
      f.db
        .prepare("SELECT count(*) n FROM code_documents WHERE repo_id='r'")
        .get()!.n,
    ) > 0,
  );
  assert.equal((await f.search()).results.length, 0);
  await f.settle();
  const results = await f.search();
  assert.equal(results.results.length, 20);
  assert.ok(results.results.every((r) => r.indexed_sha === f.sha));
  const state = f.db
    .prepare("SELECT * FROM code_index_state WHERE repo_id='r'")
    .get()!;
  assert.equal(state.status, "ready");
  assert.equal(state.files, 20);
  assert.equal(state.indexed_files, 20);
});
test("index advances to a new tree, removes deleted paths, and keeps the prior snapshot coherent during rebuild", async () => {
  const f = await setup();
  await f.settle();
  const next = await f.commit({ "renamed.ts": "next needle" }, f.sha);
  await f.store.flush();
  f.git.refs["refs/heads/main"] = next;
  await stageCodeIndex(f.env, "r", "refs/heads/main");
  await f.tick();
  assert.equal((await f.search()).results.length, 20);
  assert.ok((await f.search()).results.every((r) => r.stale));
  await f.settle();
  const result = await f.search();
  assert.deepEqual(
    result.results.map((r) => r.path),
    ["renamed.ts"],
  );
  assert.equal(result.results[0].indexed_sha, next);
  assert.equal(
    f.db
      .prepare("SELECT count(*) n FROM code_documents WHERE repo_id='r'")
      .get()!.n,
    1,
  );
  assert.equal(f.db.prepare("PRAGMA foreign_key_check").all().length, 0);
});
test("a lost D1 acknowledgement resumes after the committed cursor without duplicate documents/postings", async () => {
  const f = await setup();
  await f.tick();
  const batch = f.env.DB.batch.bind(f.env.DB);
  let once = true;
  f.env.DB.batch = (async (statements: any[]) => {
    const result = await batch(statements);
    if (once) {
      once = false;
      throw Error("ack lost");
    }
    return result;
  }) as any;
  await assert.rejects(f.tick(), /ack lost/);
  await f.settle();
  assert.equal((await f.search()).results.length, 20);
  assert.equal(
    f.db
      .prepare("SELECT indexed_files FROM code_index_state WHERE repo_id='r'")
      .get()!.indexed_files,
    20,
  );
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM mutation_guards").get()!.n,
    0,
  );
});
test("default branch changes immediately hide prior results and reject an in-flight old-branch publication", async () => {
  const f = await setup();
  await f.settle();
  await f.env.DB.prepare(
    "UPDATE code_index_state SET requested=requested+1,force_rebuild=1 WHERE repo_id='r'",
  ).run();
  await f.tick();
  const batch = f.env.DB.batch.bind(f.env.DB);
  let once = true;
  f.env.DB.batch = (async (s: any[]) => {
    if (once) {
      once = false;
      f.db.exec("UPDATE repositories SET default_branch='next' WHERE id='r'");
    }
    return batch(s);
  }) as any;
  await assert.rejects(f.tick(), /CHECK constraint failed/);
  assert.equal((await f.search()).results.length, 0);
  f.repo.default_branch = "next";
  f.git.refs["refs/heads/next"] = f.sha;
  await f.settle();
  assert.equal((await f.search()).results[0].indexed_branch, "next");
});
test("binary and over-limit blobs report partial coverage, while event replay avoids rebuilding identical snapshots", async () => {
  const f = await setup();
  const sha = await f.commit(
    {
      "valid.ts": "needle",
      binary: "a\0needle",
      "large.txt": "x".repeat(256 * 1024 + 1),
    },
    f.sha,
  );
  await f.store.flush();
  f.git.refs["refs/heads/main"] = sha;
  await f.settle();
  const state = f.db
      .prepare("SELECT * FROM code_index_state WHERE repo_id='r'")
      .get()!,
    coverage = JSON.parse(String(state.coverage));
  assert.equal(state.status, "partial");
  assert.equal(coverage.skipped.binary, 1);
  assert.equal(coverage.skipped.large_file, 1);
  assert.equal((await f.search()).results.length, 1);
  assert.equal((await f.search()).coverage.partial_projects, 1);
  await stageCodeIndex(f.env, "r", "refs/heads/other");
  assert.equal(
    f.db
      .prepare("SELECT requested FROM code_index_state WHERE repo_id='r'")
      .get()!.requested,
    state.requested,
  );
  await stageCodeIndex(f.env, "r", "refs/heads/main");
  await f.settle();
  assert.equal(
    f.db
      .prepare("SELECT generation FROM code_index_state WHERE repo_id='r'")
      .get()!.generation,
    state.generation,
  );
});

test("backfill wakeup attempts rotate past unavailable DOs without abandoning durable work", async () => {
  const f = fixture();
  for (let i = 0; i < 25; i++)
    f.db
      .prepare(
        "INSERT INTO repositories(id,owner_id,namespace,name,visibility) VALUES(?,'o','owner',?,'private')",
      )
      .run("backfill" + i, "backfill" + i);
  const attempts: string[] = [];
  f.env.REPOSITORIES = {
    idFromName: (id: string) => id,
    get: (id: string) => ({
      fetch: async () => {
        attempts.push(id);
        throw Error("unavailable");
      },
    }),
  } as any;
  await publishCodeIndexes(f.env);
  assert.equal(attempts.length, 20);
  const first = new Set(attempts);
  attempts.length = 0;
  await publishCodeIndexes(f.env);
  assert.ok(attempts.filter((id) => !first.has(id)).length >= 6);
  assert.equal(
    f.db
      .prepare(
        "SELECT count(*) n FROM code_index_state WHERE requested>completed",
      )
      .get()!.n,
    27,
  );
});
