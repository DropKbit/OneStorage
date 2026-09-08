import { bytes, canonical, makeObject, treeBytes } from "../src/git/objects";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";
import { fixture as reviewFixture } from "./support/review-fixture";

async function repositoryClass() {
  const bundled = await build({
    entryPoints: ["src/repository.ts"],
    bundle: true,
    write: false,
    platform: "node",
    banner: {
      js: 'import { createRequire as alarmTestCreateRequire } from "node:module"; const require = alarmTestCreateRequire(import.meta.url);',
    },
    format: "esm",
    logLevel: "silent",
    plugins: [
      {
        name: "durable-object-test-host",
        setup(b) {
          b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "host",
            namespace: "test-host",
          }));
          b.onLoad({ filter: /.*/, namespace: "test-host" }, () => ({
            contents:
              "export class DurableObject { constructor(ctx,env) { this.ctx=ctx;this.env=env; } } export class WorkerEntrypoint {}",
          }));
        },
      },
    ],
  });
  const folder = await mkdtemp(join(tmpdir(), "onestorage-alarm-test-"));
  const entry = join(folder, "repository.mjs");
  await writeFile(entry, bundled.outputFiles[0].contents);
  let Repository;
  try {
    ({ Repository } = await import(pathToFileURL(entry).href));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
  return Repository;
}

test("real merge queue DO preserves exact candidate/result across failed D1 projection and eviction", async () => {
  const Repository = await repositoryClass(),
    f = reviewFixture();
  const id = "00000000-0000-4000-8000-000000000031";
  const base = await f.commit({ "base.txt": "base" }),
    source = await f.commit(
      { "base.txt": "base", "feature.txt": "feature" },
      base,
    );
  f.mr(source, base);
  await f.store.flush();
  for (const [key, value] of [...f.objects])
    f.objects.set(key.replace("repos/r/", "repos/" + id + "/"), value);
  f.db.exec(
    `PRAGMA foreign_keys=OFF; UPDATE repositories SET id='${id}' WHERE id='r'; UPDATE members SET repo_id='${id}' WHERE repo_id='r'; UPDATE merge_requests SET repo_id='${id}' WHERE repo_id='r'; UPDATE branch_protections SET repo_id='${id}',require_codeowners=0,require_queue=1 WHERE repo_id='r'; PRAGMA foreign_keys=ON;`,
  );
  f.db
    .prepare("INSERT INTO ci_pipelines(repo_id,config,enabled) VALUES(?,?,0)")
    .run(
      id,
      JSON.stringify({
        runner: "worker",
        steps: [{ type: "file", path: "base.txt" }],
      }),
    );
  f.db.exec(
    "INSERT INTO credentials(hash,id,user_id,name,kind,expires_at) VALUES('credential','credential','o','test','session',9999999999999)",
  );
  const index = new DatabaseSync(":memory:"),
    state = new Map<string, any>([
      ["project-version", 0],
      ["refs.v2", { "refs/heads/main": base, "refs/heads/feature": source }],
    ]);
  const storage: any = {
    sql: {
      exec(query: string, ...args: any[]) {
        if (!args.length && query.includes(";")) {
          index.exec(query);
          return { toArray: () => [] };
        }
        const stmt = index.prepare(query),
          rows = stmt.columns().length
            ? stmt.all(...args)
            : (stmt.run(...args), []);
        return {
          toArray: () => rows,
          one: () => {
            assert.equal(rows.length, 1);
            return rows[0];
          },
          [Symbol.iterator]: () => rows[Symbol.iterator](),
        };
      },
    },
    transactionSync(fn: () => any) {
      index.exec("SAVEPOINT tx");
      try {
        const result = fn();
        index.exec("RELEASE tx");
        return result;
      } catch (e) {
        index.exec("ROLLBACK TO tx;RELEASE tx");
        throw e;
      }
    },
    get: async (key: string) => structuredClone(state.get(key)),
    put: async (key: string | Record<string, any>, value: any) => {
      for (const [k, v] of typeof key === "string"
        ? [[key, value]]
        : Object.entries(key))
        state.set(k, structuredClone(v));
    },
    delete: async (key: string | string[]) => {
      for (const k of Array.isArray(key) ? key : [key]) state.delete(k);
    },
    list: async ({ prefix = "", limit = 1000 } = {}) =>
      new Map(
        [...state].filter(([key]) => key.startsWith(prefix)).slice(0, limit),
      ),
    getAlarm: async () => state.get("alarm") || null,
    setAlarm: async (n: number) => {
      state.set("alarm", n);
    },
  };
  let doRepo = new Repository({ storage }, f.env);
  const send = async (path: string, body?: any) =>
    doRepo.fetch(
      new Request("http://repository" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "x-repo-id": id, "x-lifecycle-revision": "0" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  const queued = await send("/internal/merge-queue-enqueue", {
    id: 1,
    actor_id: "o",
    credential: "credential",
    revision: 0,
    strategy: "merge",
  });
  assert.equal(queued.status, 200);
  await doRepo.alarm();
  await doRepo.alarm();
  const entry = f.db.prepare("SELECT * FROM merge_queue WHERE id=1").get()!;
  assert.ok(entry.candidate_sha);
  assert.ok(entry.run_id);
  assert.equal(state.get("refs.v2")["refs/heads/main"], base);
  f.db
    .prepare("UPDATE ci_runs SET status='succeeded' WHERE id=?")
    .run(entry.run_id);
  const batch = f.env.DB.batch;
  f.env.DB.batch = async () => {
    throw Error("projection unavailable");
  };
  await assert.rejects(doRepo.alarm(), /projection unavailable/);
  f.env.DB.batch = batch;
  assert.equal(state.get("refs.v2")["refs/heads/main"], entry.candidate_sha);
  assert.equal(state.get("merge-result:1").queue_id, 1);
  assert.ok(state.get("merge-projection:1"));
  assert.equal(
    f.db.prepare("SELECT state FROM merge_requests WHERE id=1").get()!.state,
    "open",
  );
  doRepo = new Repository({ storage }, f.env);
  await doRepo.alarm();
  await doRepo.alarm();
  assert.equal(
    f.db.prepare("SELECT state FROM merge_queue WHERE id=1").get()!.state,
    "merged",
  );
  assert.equal(
    f.db.prepare("SELECT merged_sha FROM merge_requests WHERE id=1").get()!
      .merged_sha,
    entry.candidate_sha,
  );
  assert.equal(state.has("merge-projection:1"), false);
  assert.equal(
    f.db
      .prepare(
        "SELECT count(*) AS n FROM audit WHERE action='merge_queue.merged'",
      )
      .get()!.n,
    1,
  );
  assert.equal(
    (
      await send("/internal/merge-queue-cancel", {
        id: 1,
        actor_id: "o",
        credential: "credential",
      })
    ).status,
    409,
  );
  // Published fork-source reads bypass an unrelated long-running target writer.
  let release!: () => void;
  const hold = new Promise<void>((r) => {
    release = r;
  });
  doRepo.handle = async () => {
    await hold;
    return new Response("done");
  };
  const busy = send("/writer", {});
  const snapshot = await Promise.race([
    send("/internal/queue-source?ref=refs%2Fheads%2Fmain"),
    new Promise<Response>((_, reject) => {
      const t = setTimeout(
        () => reject(Error("source read waited for writer")),
        1000,
      );
      t.unref();
    }),
  ]);
  assert.equal((await snapshot.json()).sha, entry.candidate_sha);
  release();
  await busy;
});

test("busy repository alarms return without joining the HTTP queue; idle alarms still collect", async () => {
  const Repository = await repositoryClass();
  let reads = 0,
    alarm = 0,
    cacheUnavailable = false,
    release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const storage = {
    get: async () => {
      reads++;
      return undefined;
    },
    list: async ({ prefix }: { prefix: string }) => {
      if (cacheUnavailable && prefix === "pack-cache:entry:")
        throw Error("cache unavailable");
      return new Map();
    },
    setAlarm: async (value: number) => {
      alarm = value;
    },
  };
  const repository = new Repository({ storage }, { OBJECTS: {} });
  repository.handle = async () => {
    await gate;
    return new Response("done");
  };
  const first = repository.fetch(new Request("https://repo/one")),
    queued = repository.fetch(new Request("https://repo/two"));
  assert.equal(repository.waiting, 2);
  const before = Date.now();
  await Promise.race([
    repository.alarm(),
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(Error("alarm joined active HTTP queue")),
        1000,
      );
      timer.unref();
    }),
  ]);
  assert.equal(reads, 0);
  assert.ok(alarm >= before + 30000);
  release();
  await Promise.all([first, queued]);
  await repository.gate.tail;
  assert.equal(repository.waiting, 0);
  await repository.alarm();
  assert.ok(reads > 0);
  cacheUnavailable = true;
  const prior = reads;
  await repository.alarm();
  assert.ok(reads > prior + 1, "cache failure does not stop other alarm work");
  assert.ok(alarm >= Date.now() + 29000);
});

test("real snapshot prelude checks project versions and uses isolated published refs", async () => {
  const Repository = await repositoryClass();
  const id = "00000000-0000-4000-8000-000000000001";
  const blob = await makeObject("blob", bytes("old readme"));
  const tree = await makeObject(
    "tree",
    treeBytes([
      { name: "README.md", type: "blob", mode: "100644", sha: blob.oid },
    ]),
  );
  const commit = await makeObject(
    "commit",
    bytes(
      `tree ${tree.oid}\nauthor A <a@b> 1 +0000\ncommitter A <a@b> 1 +0000\n\nold\n`,
    ),
  );
  const next = await makeObject(
    "commit",
    bytes(
      `tree ${tree.oid}\nparent ${commit.oid}\nauthor A <a@b> 2 +0000\ncommitter A <a@b> 2 +0000\n\nnew\n`,
    ),
  );
  const objects = new Map(
    [blob, tree, commit, next].map((o) => [o.oid, canonical(o)]),
  );
  const state = new Map<string, any>([
    ["project-version", 0],
    ["refs.v2", { "refs/heads/main": commit.oid }],
  ]);
  let release!: () => void,
    started!: () => void,
    serial = 0;
  const hold = new Promise<void>((r) => {
      release = r;
    }),
    entered = new Promise<void>((r) => {
      started = r;
    });
  const waits: Promise<unknown>[] = [];
  const storage = {
    get: async (key: string) => structuredClone(state.get(key)),
    put: async () => {
      throw Error("read wrote state");
    },
  };
  const repository = new Repository(
    {
      storage,
      waitUntil: (p: Promise<unknown>) => {
        waits.push(p);
      },
    },
    {
      OBJECTS: {
        get: async (key: string) => {
          const oid = key.split("/").at(-1)!;
          // Publication happens after the snapshot has captured its refs but before its tree read finishes.
          if (oid === tree.oid)
            state.set("refs.v2", { "refs/heads/main": next.oid });
          const data = objects.get(oid);
          return data
            ? {
                size: data.length,
                arrayBuffer: async () => data.slice().buffer,
              }
            : null;
        },
      },
    },
  );
  repository.objectIndex = { repoId: id };
  repository.handle = async (request: Request, ready: () => void) => {
    if (request.method === "POST") {
      ready();
      started();
      await hold;
      return new Response("push");
    }
    serial++;
    return new Response("serial");
  };
  const headers = { "x-repo-id": id, "x-lifecycle-revision": "0" };
  const upload = repository.fetch(
    new Request("https://repo/git/git-receive-pack", {
      method: "POST",
      headers,
    }),
  );
  await entered;
  const response = await repository.fetch(
    new Request("https://repo/browse", { headers }),
  );
  assert.equal(response.headers.get("x-onestorage-read-mode"), "snapshot");
  const data = await response.json();
  assert.equal(data.data.ref, commit.oid);
  assert.equal(data.readme.ref, commit.oid);
  assert.equal(data.readme.content, "old readme");
  await Promise.all(waits);
  state.set("project-version", 1);
  assert.equal(
    (await repository.fetch(new Request("https://repo/browse", { headers })))
      .status,
    409,
  );
  const hidden = repository.fetch(
    new Request("https://repo/browse?ref=" + "a".repeat(40), {
      headers: { ...headers, "x-lifecycle-revision": "1" },
    }),
  );
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(
    serial,
    0,
    "unpublished explicit SHA falls back behind the active push",
  );
  release();
  await upload;
  assert.equal(await (await hidden).text(), "serial");
  await repository.gate.tail;
  assert.equal(repository.waiting, 0);
});
