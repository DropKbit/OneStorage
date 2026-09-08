import test from "node:test";
import assert from "node:assert/strict";
import {
  ObjectStore,
  bytes,
  canonical,
  makeObject,
  treeBytes,
  LIMITS,
} from "../src/git/objects";
import { publishRefs } from "../src/git/repository";
function bucket() {
  const objects = new Map<string, Uint8Array>();
  let active = 0,
    peak = 0,
    reads = 0,
    writes = 0;
  async function delay() {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 2));
    active--;
  }
  return {
    objects,
    stats: () => ({ active, peak, reads, writes }),
    async get(k: string) {
      reads++;
      await delay();
      const data = objects.get(k);
      return data
        ? { size: data.length, arrayBuffer: async () => data.slice().buffer }
        : null;
    },
    async put(k: string, data: Uint8Array) {
      writes++;
      await delay();
      if (objects.has(k)) return null;
      objects.set(k, data);
      return {};
    },
  };
}
test("concurrent reads for one OID share one R2 request, failures drain and permit retry", async () => {
  const b = bucket(),
    o = await makeObject("blob", bytes("data")),
    s = new ObjectStore("r", b as any),
    key = "repos/r/objects/" + o.oid;
  await assert.rejects(
    Promise.all([s.get(o.oid), s.get(o.oid)]),
    /Missing Git/,
  );
  assert.equal(b.stats().reads, 1);
  assert.equal(b.stats().active, 0);
  b.objects.set(key, canonical(o));
  const [a, c] = await Promise.all([s.get(o.oid), s.get(o.oid)]);
  assert.equal(a, c);
  assert.equal(b.stats().reads, 2);
});
test("graph traversal and immutable writes use two I/O lanes, preserving deduplication and object/type checks", async () => {
  const b = bucket(),
    s = new ObjectStore("r", b as any),
    blobs = await Promise.all(
      Array.from({ length: 12 }, (_, i) => s.create("blob", bytes("blob" + i))),
    );
  const tree = await s.create(
    "tree",
    treeBytes(
      blobs.map((o, i) => ({
        mode: "100644",
        name: "file" + i,
        sha: o.oid,
        type: "blob" as const,
      })),
    ),
  );
  await s.flush();
  assert.equal(b.stats().peak, 2);
  assert.equal(b.stats().active, 0);
  const fresh = new ObjectStore("r", b as any),
    graph = await fresh.walk([tree.oid, tree.oid]);
  assert.equal(graph.size, 13);
  assert.equal(b.stats().reads, 13);
  assert.equal(b.stats().peak, 2);
  const invalid = await s.create(
    "tree",
    treeBytes([
      { mode: "40000", name: "invalid", sha: blobs[0].oid, type: "tree" },
    ]),
  );
  await s.flush();
  await assert.rejects(
    new ObjectStore("r", b as any).walk([invalid.oid, blobs[0].oid]),
    /type mismatch/,
  );
});
test("parallel write failure drains the other lane and never publishes refs", async () => {
  const b = bucket(),
    s = new ObjectStore("r", b as any),
    first = await s.create("blob", bytes("first"));
  await s.create("blob", bytes("second"));
  b.objects.set("repos/r/objects/" + first.oid, bytes("corrupt"));
  let published = false;
  await assert.rejects(
    publishRefs(
      s,
      {
        get: async () => undefined,
        put: async () => {
          published = true;
        },
      },
      { "refs/heads/main": first.oid },
    ),
    /Conflicting stored/,
  );
  assert.equal(published, false);
  assert.equal(b.stats().active, 0);
  assert.equal(b.stats().writes, 2);
});
test("large graph reads evict payloads while staging remains bounded", async () => {
  const b = bucket(),
    s = new ObjectStore("r", b as any),
    ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    const o = await makeObject("blob", new Uint8Array(LIMITS.object).fill(i));
    b.objects.set("repos/r/objects/" + o.oid, canonical(o));
    ids.push(o.oid);
  }
  assert.equal((await s.walk(ids)).size, 5);
  assert.ok(s.memoryUsage.peakCachedBytes <= LIMITS.cacheBytes);
  assert.equal(s.memoryUsage.stagedBytes, 0);
  for (let i = 0; i < 4; i++) s.add(await s.get(ids[i]));
  await assert.rejects(
    async () => s.add(await s.get(ids[4])),
    /Staged Git objects/,
  );
  assert.equal(b.stats().active, 0);
});

test("streamed import write batches use four lanes only within their payload budget", async () => {
  const b = bucket(),
    store = new ObjectStore("r", b as any);
  for (let i = 0; i < 8; i++) await store.create("blob", bytes("small " + i));
  await store.flush(4);
  assert.equal(b.stats().peak, 4);
  assert.equal(b.stats().active, 0);
  const largeBucket = bucket(),
    large = new ObjectStore("large", largeBucket as any);
  for (let i = 0; i < 3; i++) {
    const data = new Uint8Array(5 * 1024 * 1024);
    data[0] = i;
    await large.create("blob", data);
  }
  await large.flush(4);
  assert.equal(largeBucket.stats().peak, 1);
  assert.equal(largeBucket.stats().active, 0);
});

test("a failed four-lane import write drains every started write before returning", async () => {
  let active = 0,
    started = 0,
    completed = 0;
  const b = {
    put: async () => {
      active++;
      const position = ++started;
      try {
        if (position === 1) throw Error("permanent write failure");
        await new Promise((r) => setTimeout(r, 10));
        completed++;
        return {};
      } finally {
        active--;
      }
    },
  };
  const store = new ObjectStore("r", b as any);
  for (let i = 0; i < 4; i++) await store.create("blob", bytes(String(i)));
  await assert.rejects(store.flush(4), /permanent write failure/);
  assert.equal(active, 0);
  assert.equal(completed, 3);
});
