import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { PackCache, collectPackCache } from "../src/git/pack-cache";
import {
  packChunks,
  responseCompletion,
  streamResponse,
} from "../src/git/pack-stream";
import { parsePack } from "../src/git/pack";
import {
  ObjectStore,
  bytes,
  canonical,
  concat,
  makeObject,
  treeBytes,
} from "../src/git/objects";
import { GitRepository } from "../src/git/repository";
import { upload } from "../src/git/protocol";
import { pkt, FLUSH } from "../src/git/pkt";

const repoId = "00000000-0000-4000-8000-000000000001";
const otherId = "00000000-0000-4000-8000-000000000002";
const partSize = 4 * 1024 * 1024;
function fixture() {
  const values = new Map<string, any>(),
    objects = new Map<string, Uint8Array>();
  let alarm: number | null = null,
    now = 100000,
    writes = 0,
    maxWrite = 0;
  let failWrite = false,
    failPublish = false,
    failDelete = false,
    failGet = false;
  const storage = {
    get: async (key: string) => structuredClone(values.get(key)),
    put: async (key: string | Record<string, unknown>, value?: unknown) => {
      if (typeof key === "object" && failPublish)
        throw Error("publication failed");
      for (const [k, v] of typeof key === "string"
        ? [[key, value] as [string, unknown]]
        : Object.entries(key))
        values.set(k, structuredClone(v));
    },
    delete: async (key: string) => values.delete(key),
    list: async ({
      prefix,
      limit = 1000,
    }: {
      prefix: string;
      limit?: number;
    }) =>
      new Map(
        [...values].filter(([key]) => key.startsWith(prefix)).slice(0, limit),
      ),
    getAlarm: async () => alarm,
    setAlarm: async (at: number) => {
      alarm = at;
    },
  } as unknown as DurableObjectStorage;
  const bucket = {
    get: async (key: string) => {
      if (failGet) throw Error("cache read unavailable");
      const data = objects.get(key);
      return data
        ? { size: data.length, arrayBuffer: async () => data.slice().buffer }
        : null;
    },
    put: async (key: string, data: Uint8Array) => {
      writes++;
      maxWrite = Math.max(maxWrite, data.length);
      if (failWrite) throw Error("cache write unavailable");
      if (objects.has(key)) return null;
      objects.set(key, data.slice());
      return {};
    },
    list: async ({ prefix }: { prefix: string }) => ({
      objects: [...objects.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ key })),
      truncated: false,
    }),
    delete: async (keys: string[]) => {
      if (failDelete) throw Error("cleanup unavailable");
      keys.forEach((key) => objects.delete(key));
    },
  } as unknown as R2Bucket;
  return {
    storage,
    bucket,
    values,
    objects,
    cache: (id = repoId) => new PackCache(id, bucket, storage, () => now),
    stats: () => ({ alarm, writes, maxWrite }),
    tick: (ms: number) => {
      now += ms;
      alarm = null;
    },
    now: () => now,
    failures: (
      kind: "write" | "publish" | "delete" | "get",
      value: boolean,
    ) => {
      if (kind === "write") failWrite = value;
      if (kind === "publish") failPublish = value;
      if (kind === "delete") failDelete = value;
      if (kind === "get") failGet = value;
    },
  };
}
async function consume(stream: AsyncIterable<Uint8Array>) {
  const parts = [];
  for await (const part of stream) parts.push(part.slice());
  return concat(...parts);
}
function source(data: Uint8Array, state = { starts: 0, closed: 0 }) {
  return {
    state,
    generate: async function* () {
      state.starts++;
      try {
        for (let i = 0; i < data.length; i += 16384)
          yield data.subarray(i, i + 16384);
      } finally {
        state.closed++;
      }
    },
  };
}

test("persisted full pack cache survives a new instance and avoids object reads", async () => {
  const f = fixture(),
    blob = await makeObject("blob", randomBytes(partSize + 1024));
  let reads = 0;
  const generate = () =>
    packChunks([blob.oid], async () => {
      reads++;
      return blob;
    });
  const first = await consume(f.cache().stream([blob.oid], generate));
  assert.equal(reads, 1);
  const cache = f.cache();
  const second = await consume(cache.stream([blob.oid], generate));
  assert.equal(reads, 1);
  assert.deepEqual(second, first);
  assert.equal((await parsePack(second))[0].oid, blob.oid);
  assert.equal(cache.metrics.hit, true);
  assert.equal(cache.metrics.reads, 2);
  assert.ok(f.stats().maxWrite <= partSize);
});

for (const damage of ["missing", "corrupt", "read-error"] as const) {
  test(`cache ${damage} regenerates an identical pack, including after a verified prefix`, async () => {
    const f = fixture(),
      data = new Uint8Array(randomBytes(partSize + 90000)),
      s = source(data);
    await consume(f.cache().stream(["a"], s.generate));
    const keys = [...f.objects.keys()];
    if (damage === "missing") f.objects.delete(keys[1]);
    if (damage === "corrupt") f.objects.get(keys[1])![42] ^= 1;
    if (damage === "read-error") f.failures("get", true);
    const cache = f.cache();
    assert.deepEqual(await consume(cache.stream(["a"], s.generate)), data);
    assert.equal(cache.metrics.fallback, true);
    assert.equal(s.state.starts, 2);
    assert.equal(f.values.has("pack-cache:current"), false);
    f.failures("get", false);
    await collectPackCache(f.bucket, f.storage, f.now());
    assert.equal(f.objects.size, 0);
  });
}

test("selection and repository identity prevent reuse; old entries are evicted before replacement", async () => {
  const f = fixture(),
    a = source(bytes("a".repeat(100))),
    b = source(bytes("b".repeat(100)));
  await consume(f.cache().stream(["a"], a.generate));
  const old = [...f.objects.keys()];
  const changed = f.cache();
  assert.deepEqual(
    await consume(changed.stream(["b"], b.generate)),
    bytes("b".repeat(100)),
  );
  assert.equal(changed.metrics.hit, false);
  assert.ok(old.every((key) => !f.objects.has(key)));
  const foreign = f.cache(otherId);
  await consume(foreign.stream(["b"], b.generate));
  assert.equal(foreign.metrics.hit, false);
  assert.equal(b.state.starts, 2);
  assert.equal(f.objects.size, 1);
});

test("TTL collects stale packs and keeps an earlier scheduled alarm", async () => {
  const f = fixture(),
    s = source(bytes("x".repeat(100)));
  await consume(f.cache().stream(["a"], s.generate));
  assert.equal(f.stats().alarm, f.now() + 1000);
  f.tick(1000);
  await collectPackCache(f.bucket, f.storage, f.now());
  assert.equal(f.objects.size, 1);
  assert.equal(f.stats().alarm, 100000 + 86400000);
  f.tick(86400000);
  await collectPackCache(f.bucket, f.storage, f.now());
  assert.equal(f.objects.size, 0);
  assert.equal(f.values.size, 0);
});

for (const failure of ["write", "publish"] as const) {
  test(`${failure} failure leaves valid Git bytes and a recoverable cleanup marker`, async () => {
    const f = fixture(),
      data = new Uint8Array(randomBytes(partSize + 90)),
      s = source(data);
    f.failures(failure, true);
    assert.deepEqual(await consume(f.cache().stream(["a"], s.generate)), data);
    assert.equal(f.values.has("pack-cache:current"), false);
    assert.equal(
      [...f.values.keys()].filter((key) => key.startsWith("pack-cache:entry:"))
        .length,
      1,
    );
    await collectPackCache(f.bucket, f.storage, f.now());
    assert.equal(f.objects.size, 0);
    assert.equal(f.values.size, 0);
  });
}

test("cleanup failure prevents more cache writes but allows authoritative fetch", async () => {
  const f = fixture(),
    s = source(bytes("x".repeat(100)));
  await consume(f.cache().stream(["a"], s.generate));
  f.failures("delete", true);
  const before = f.stats().writes;
  await consume(f.cache().stream(["b"], s.generate));
  assert.equal(f.stats().writes, before);
  assert.equal(f.objects.size, 1);
  f.failures("delete", false);
  await collectPackCache(f.bucket, f.storage, f.now(), true);
  assert.equal(f.values.size, 0);
});

test("cancellation closes the producer and never publishes an incomplete cache", async () => {
  const f = fixture(),
    s = source(randomBytes(partSize + 100));
  const response = streamResponse(f.cache().stream(["a"], s.generate), {});
  const reader = response.body!.getReader();
  let count = 0;
  while (count < partSize) count += (await reader.read()).value!.length;
  await reader.cancel();
  await responseCompletion(response);
  assert.equal(s.state.closed, 1);
  assert.equal(f.values.has("pack-cache:current"), false);
  assert.equal(f.objects.size, 1);
  await collectPackCache(f.bucket, f.storage, f.now());
  assert.equal(f.objects.size, 0);
});

test("authoritative generation errors propagate and cannot publish a cache", async () => {
  const f = fixture();
  async function* broken() {
    yield bytes("PACK");
    throw Error("missing Git object");
  }
  await assert.rejects(
    consume(f.cache().stream(["a"], broken)),
    /missing Git object/,
  );
  assert.equal(f.values.has("pack-cache:current"), false);
  await collectPackCache(f.bucket, f.storage, f.now());
  assert.equal(f.values.size, 0);
});

test("cancellation drains an in-flight R2 cache write before releasing the response barrier", async () => {
  const f = fixture(),
    s = source(randomBytes(partSize + 100));
  let release!: () => void, entered!: () => void;
  const writing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const put = f.bucket.put.bind(f.bucket);
  f.bucket.put = (async (...args: Parameters<R2Bucket["put"]>) => {
    entered();
    await gate;
    return put(...args);
  }) as R2Bucket["put"];
  const response = streamResponse(f.cache().stream(["a"], s.generate), {});
  const reader = response.body!.getReader();
  for (let read = 0; read < partSize - 16384; read += 16384)
    await reader.read();
  const pending = reader.read();
  await writing;
  let completed = false;
  responseCompletion(response)!.then(() => {
    completed = true;
  });
  const canceled = reader.cancel();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(completed, false);
  release();
  await Promise.all([pending, canceled, responseCompletion(response)]);
  assert.equal(completed, true);
  assert.equal(s.state.closed, 1);
  assert.equal(f.values.has("pack-cache:current"), false);
  await collectPackCache(f.bucket, f.storage, f.now());
  assert.equal(f.objects.size, 0);
});

test("protocol recomputes visibility before cache access and skips caching incremental fetch", async () => {
  const f = fixture(),
    store = new ObjectStore(repoId, f.bucket);
  const blob = await makeObject("blob", bytes("visible"));
  const hidden = await makeObject("blob", bytes("hidden"));
  const tree = await makeObject(
    "tree",
    treeBytes([{ name: "file", mode: "100644", type: "blob", sha: blob.oid }]),
  );
  const commit = await makeObject(
    "commit",
    bytes(
      `tree ${tree.oid}\nauthor A <a@b> 1 +0000\ncommitter A <a@b> 1 +0000\n\nTest\n`,
    ),
  );
  for (const o of [blob, hidden, tree, commit])
    f.objects.set(`repos/${repoId}/objects/${o.oid}`, canonical(o));
  const repo = new GitRepository(
    store,
    f.storage,
    { "refs/heads/main": commit.oid },
    "main",
  );
  const request = (want: string, have?: string) =>
    concat(
      pkt(`want ${want}\n`),
      FLUSH,
      ...(have ? [pkt(`have ${have}\n`)] : []),
      pkt("done\n"),
    );
  const first = await upload(repo, request(commit.oid), f.cache());
  await first.arrayBuffer();
  const before = f.stats().writes;
  const cache = f.cache();
  const second = await upload(repo, request(commit.oid), cache);
  await second.arrayBuffer();
  assert.equal(cache.metrics.hit, true);
  await assert.rejects(upload(repo, request(hidden.oid), f.cache()));
  const incremental = f.cache();
  await (
    await upload(repo, request(commit.oid, commit.oid), incremental)
  ).arrayBuffer();
  assert.equal(incremental.metrics.hit, false);
  assert.equal(f.stats().writes, before);
  repo.refs = {};
  await assert.rejects(upload(repo, request(commit.oid), f.cache()));
});
