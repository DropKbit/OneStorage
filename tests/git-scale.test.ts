import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { GitObjectIndex } from "../src/git/object-index";
import {
  ObjectStore,
  makeObject,
  bytes,
  treeBytes,
  canonical,
  LIMITS,
  type GitObject,
} from "../src/git/objects";
import { GitRepository } from "../src/git/repository";
import {
  packChunks,
  streamResponse,
  responseCompletion,
} from "../src/git/pack-stream";
import { parsePack } from "../src/git/pack";
function fixture() {
  const db = new DatabaseSync(":memory:"),
    values = new Map<string, any>(),
    objects = new Map<string, Uint8Array>();
  let reads = 0,
    writes = 0,
    badIndex: boolean | string = false,
    badRefs = false;
  const storage = {
    sql: {
      exec(query: string, ...args: any[]) {
        if (
          badIndex &&
          (badIndex === true || args[0] === badIndex) &&
          query.startsWith("INSERT INTO git_objects_v1")
        )
          throw Error("index disk failed");
        if (!args.length && query.includes(";")) {
          db.exec(query);
          return { toArray: () => [] };
        }
        const stmt = db.prepare(query),
          rows = stmt.columns().length
            ? stmt.all(...args)
            : (stmt.run(...args), []);
        return {
          toArray: () => rows,
          one: () => {
            assert.equal(rows.length, 1);
            return rows[0];
          },
        };
      },
    } as unknown as SqlStorage,
    transactionSync<T>(fn: () => T) {
      db.exec("SAVEPOINT tx");
      try {
        const result = fn();
        db.exec("RELEASE tx");
        return result;
      } catch (e) {
        db.exec("ROLLBACK TO tx; RELEASE tx");
        throw e;
      }
    },
    async get<T>(key: string) {
      return values.get(key) as T;
    },
    async put<T>(key: string, value: T) {
      if (badRefs) throw Error("refs disk failed");
      values.set(key, structuredClone(value));
    },
  };
  const bucket = {
    async get(key: string) {
      reads++;
      const data = objects.get(key);
      return data
        ? { size: data.length, arrayBuffer: async () => data.slice().buffer }
        : null;
    },
    async put(key: string, data: Uint8Array) {
      writes++;
      if (objects.has(key)) return null;
      objects.set(key, data.slice());
      return {};
    },
  } as any;
  const index = new GitObjectIndex("r", storage);
  const fresh = () =>
    new GitRepository(
      new ObjectStore("r", bucket, undefined, index),
      storage,
      structuredClone(values.get("refs.v2") || {}),
      "main",
    );
  return {
    db,
    storage,
    index,
    bucket,
    objects,
    values,
    fresh,
    stats: () => ({ reads, writes }),
    badIndex: (v: boolean | string) => {
      badIndex = v;
    },
    badRefs: (v: boolean) => {
      badRefs = v;
    },
  };
}
const commit = async (store: ObjectStore, tree: string, parent?: string) =>
  store.create(
    "commit",
    bytes(
      `tree ${tree}\n${parent ? `parent ${parent}\n` : ""}author A <a@b> 1 +0000\ncommitter A <a@b> 1 +0000\n\nCommit\n`,
    ),
  );
test("persistent closure index skips verified history, survives failed publication, and never grants access to hidden objects", async () => {
  const f = fixture(),
    repo = f.fresh(),
    blob = await repo.store.create("blob", bytes("public")),
    tree = await repo.store.create(
      "tree",
      treeBytes([
        { name: "file", mode: "100644", type: "blob", sha: blob.oid },
      ]),
    ),
    tip = await commit(repo.store, tree.oid);
  await repo.publish({ "refs/heads/main": tip.oid });
  const cold = f.fresh(),
    before = f.stats().reads;
  await cold.store.validateClosure([tip.oid]);
  assert.equal(
    f.stats().reads,
    before,
    "persisted closure requires no R2 reads",
  );
  const secret = await cold.store.create(
      "blob",
      bytes("unpublished private data"),
    ),
    secretTree = await cold.store.create(
      "tree",
      treeBytes([
        { name: "secret", mode: "100644", type: "blob", sha: secret.oid },
      ]),
    ),
    secretTip = await commit(cold.store, secretTree.oid, tip.oid);
  f.badRefs(true);
  await assert.rejects(
    cold.publish({ "refs/heads/main": secretTip.oid }),
    /refs disk/,
  );
  f.badRefs(false);
  assert.ok(f.index.get(secretTip.oid));
  await assert.rejects(f.fresh().validateFetch([secret.oid]), /not reachable/);
  assert.deepEqual(
    [...(await f.fresh().validateFetch([tip.oid]))].sort(),
    [blob.oid, tree.oid, tip.oid].sort(),
  );
  const restart = new GitObjectIndex("r", f.storage);
  assert.ok(restart.get(tip.oid));
  assert.throws(
    () => new GitObjectIndex("other", f.storage),
    /another repository/,
  );
  assert.throws(
    () => new ObjectStore("other", f.bucket, undefined, f.index),
    /scope mismatch/,
  );
});
test("index construction rolls back incomplete parents, recovers from missing objects, validates every edge type, and rejects forged staged hashes", async () => {
  const f = fixture(),
    repo = f.fresh(),
    blob = await repo.store.create("blob", bytes("child")),
    tree = await repo.store.create(
      "tree",
      treeBytes([{ name: "a", mode: "100644", type: "blob", sha: blob.oid }]),
    );
  await repo.store.flush();
  f.badIndex(true);
  await assert.rejects(repo.store.validateClosure([tree.oid]), /index disk/);
  assert.equal(f.index.get(tree.oid), undefined);
  assert.equal(f.values.get("refs.v2"), undefined);
  f.badIndex(false);
  const content = f.objects.get(`repos/r/objects/${blob.oid}`)!;
  f.objects.delete(`repos/r/objects/${blob.oid}`);
  await assert.rejects(
    f.fresh().store.validateClosure([tree.oid]),
    /Missing Git/,
  );
  assert.equal(f.index.get(tree.oid), undefined);
  f.objects.set(`repos/r/objects/${blob.oid}`, content);
  await f.fresh().store.validateClosure([tree.oid]);
  const bad = f.fresh(),
    wrong = await bad.store.create(
      "tree",
      treeBytes([
        { name: "wrong", mode: "40000", type: "tree", sha: blob.oid },
      ]),
    );
  await assert.rejects(
    bad.publish({ "refs/heads/main": wrong.oid }),
    /type mismatch/,
  );
  assert.equal(f.index.get(wrong.oid), undefined);
  const valid = f.fresh(),
    parent = await valid.store.create(
      "tree",
      treeBytes([
        { name: "another", mode: "100644", type: "blob", sha: blob.oid },
      ]),
    );
  f.badIndex(parent.oid);
  await assert.rejects(
    valid.publish({ "refs/heads/main": parent.oid }),
    /index disk/,
  );
  assert.equal(f.index.get(parent.oid), undefined);
  assert.equal(
    f.db
      .prepare("SELECT COUNT(*) AS n FROM git_edges_v1 WHERE parent=?")
      .get(parent.oid)!.n,
    0,
  );
  assert.ok(f.index.get(blob.oid));
  f.badIndex(false);
  await f.fresh().store.validateClosure([parent.oid]);
  assert.ok(f.index.get(parent.oid));
  const forged = f.fresh();
  forged.store.add({ ...blob, oid: "a".repeat(40) });
  await assert.rejects(forged.store.flush(), /hash mismatch/);
  assert.equal(f.objects.has("repos/r/objects/" + "a".repeat(40)), false);
});
test("more than 5000 persisted objects use metadata-only reachability and preserve exclusions across cold stores", async () => {
  const f = fixture();
  let previous: string | undefined;
  const all = new Set<string>();
  for (let batch = 0; batch < 6; batch++) {
    const repo = f.fresh(),
      entries = [];
    for (let n = 0; n < 900; n++) {
      const blob = await repo.store.create(
        "blob",
        bytes(`batch${batch}-file${n}`),
      );
      entries.push({
        name: `file${n}`,
        mode: "100644",
        type: "blob" as const,
        sha: blob.oid,
      });
      all.add(blob.oid);
    }
    const tree = await repo.store.create("tree", treeBytes(entries)),
      tip = await commit(repo.store, tree.oid, previous);
    all.add(tree.oid);
    all.add(tip.oid);
    await repo.publish({ "refs/heads/main": tip.oid });
    previous = tip.oid;
    assert.equal(repo.store.memoryUsage.stagedBytes, 0);
  }
  assert.ok(all.size > 5000);
  const before = f.stats().reads,
    repo = f.fresh();
  assert.deepEqual(await repo.validateFetch([previous!]), all);
  assert.equal(f.stats().reads, before);
  assert.equal((await repo.store.walk([previous!], all)).size, 0);
  const hugeExclusion = new Set([
    ...all,
    ...Array.from({ length: 26000 }, (_, i) =>
      i.toString(16).padStart(40, "0"),
    ),
  ]);
  assert.equal(f.index.walk([previous!], hugeExclusion).size, 0);
  assert.equal(
    f.db.prepare("SELECT COUNT(*) AS n FROM git_walk_excluded_v1").get()!.n,
    0,
  );
});
test("pack chunks preserve native pack hash and objects while loading only on demand", async () => {
  const objects = await Promise.all([
    makeObject("blob", new Uint8Array()),
    makeObject("blob", bytes("test\n")),
    makeObject("tree", new Uint8Array()),
  ]);
  let loads = 0;
  const stream = packChunks(
    objects.map((o) => o.oid),
    async (oid) => {
      loads++;
      return objects.find((o) => o.oid === oid)!;
    },
  );
  assert.equal(loads, 0);
  const first = await stream.next();
  assert.equal(loads, 0);
  const parts = [first.value!];
  for await (const chunk of stream) parts.push(chunk);
  const result = await parsePack(new Uint8Array(Buffer.concat(parts)));
  assert.deepEqual(
    result.map((o) => o.oid),
    objects.map((o) => o.oid),
  );
  assert.equal(loads, objects.length);
});
test("stream backpressure, cancellation and idle timeout retain the queue until in-flight reads drain", async () => {
  let started = 0,
    cleaned = false,
    unblock!: () => void;
  const gate = new Promise<void>((r) => {
    unblock = r;
  });
  async function* chunks() {
    try {
      started++;
      yield bytes("first");
      await gate;
      yield bytes("last");
    } finally {
      cleaned = true;
    }
  }
  const response = streamResponse(chunks(), {}, 50),
    reader = response.body!.getReader();
  let done = false;
  void responseCompletion(response)!.then(() => {
    done = true;
  });
  assert.equal(started, 0);
  assert.equal(new TextDecoder().decode((await reader.read()).value), "first");
  const reading = reader.read();
  const rejected = assert.rejects(reading, /idle timeout/);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(done, false);
  assert.equal(cleaned, false);
  unblock();
  await rejected;
  await responseCompletion(response);
  assert.equal(done, true);
  assert.equal(cleaned, true);
  let loaded = 0;
  const canceled = streamResponse(
    (async function* () {
      loaded++;
      yield bytes("x");
      loaded++;
      yield bytes("y");
    })(),
    {},
  );
  const r = canceled.body!.getReader();
  await r.read();
  await r.cancel();
  await responseCompletion(canceled);
  assert.equal(loaded, 1);
  const untouched = streamResponse(
    (async function* () {
      throw Error("must not start");
      yield bytes("never");
    })(),
    {},
    10,
  );
  await responseCompletion(untouched);
  await assert.rejects(untouched.arrayBuffer(), /idle timeout/);
});

test("stateless v0/v2 common-have negotiation sends only new objects and never ACKs an unpublished object", async () => {
  const { upload } = await import("../src/git/protocol"),
    { pkt, FLUSH, DELIM, readPackets } = await import("../src/git/pkt"),
    { concat, text } = await import("../src/git/objects");
  const f = fixture(),
    repo = f.fresh(),
    tree = await repo.store.create("tree", new Uint8Array()),
    first = await commit(repo.store, tree.oid);
  await repo.publish({ "refs/heads/main": first.oid });
  const second = await commit(repo.store, tree.oid, first.oid);
  await repo.publish({ "refs/heads/main": second.oid });
  const hidden = await repo.store.create("blob", bytes("not published"));
  await repo.store.flush();
  await repo.store.validateClosure([hidden.oid]);
  for (const v2 of [true, false]) {
    const body = v2
      ? concat(
          pkt("command=fetch\n"),
          DELIM,
          pkt(`want ${second.oid}\n`),
          pkt(`have ${first.oid}\n`),
          pkt(`have ${hidden.oid}\n`),
          FLUSH,
        )
      : concat(
          pkt(`want ${second.oid} multi_ack_detailed no-done side-band-64k\n`),
          FLUSH,
          pkt(`have ${first.oid}\n`),
          pkt(`have ${hidden.oid}\n`),
          FLUSH,
        );
    const response = await upload(f.fresh(), body),
      raw = new Uint8Array(await response.arrayBuffer()),
      packets = readPackets(raw).packets.filter(
        (p) => p instanceof Uint8Array,
      ) as Uint8Array[];
    const acks = packets.filter((p) => text(p).startsWith("ACK")).map(text);
    assert.ok(acks.some((a) => a.includes(first.oid)));
    assert.ok(!acks.some((a) => a.includes(hidden.oid)));
    const pack = concat(
      ...packets.filter((p) => p[0] === 1).map((p) => p.subarray(1)),
    );
    assert.deepEqual(
      (await parsePack(pack)).map((o) => o.oid),
      [second.oid],
    );
    assert.ok(raw.length < 1024);
  }
});
