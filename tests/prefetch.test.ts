import test from "node:test";
import assert from "node:assert/strict";
import { prefetchObjects } from "../src/git/prefetch";
import {
  packChunks,
  streamResponse,
  responseCompletion,
} from "../src/git/pack-stream";
import { makeObject, bytes, LIMITS, type GitObject } from "../src/git/objects";
import { parsePack } from "../src/git/pack";

const tick = () => new Promise<void>((r) => setImmediate(r));
function fixture(sizes: number[]) {
  const objects: GitObject[] = sizes.map((size, i) => ({
    oid: (i + 1).toString(16).padStart(40, "0"),
    type: "blob",
    data: new Uint8Array(size),
  }));
  const pending = new Map<
      string,
      { resolve: (o: GitObject) => void; reject: (e: unknown) => void }
    >(),
    calls: string[] = [];
  const load = (oid: string) => {
    calls.push(oid);
    return new Promise<GitObject>((resolve, reject) =>
      pending.set(oid, { resolve, reject }),
    );
  };
  const resolve = (i: number) =>
    pending.get(objects[i].oid)!.resolve(objects[i]);
  return {
    objects,
    ids: objects.map((o) => o.oid),
    load,
    calls,
    resolve,
    pending,
    size: (oid: string) => objects.find((o) => o.oid === oid)!.data.length,
  };
}

test("lookahead runs four small reads concurrently, preserves ordering and stops scheduling under backpressure", async () => {
  const f = fixture([1, 1, 1, 1, 1, 1]),
    observations: [number, number][] = [];
  const iterator = prefetchObjects(f.ids, f.load, {
    size: f.size,
    observe: (b, n) => observations.push([b, n]),
  });
  assert.equal(f.calls.length, 0);
  const first = iterator.next();
  await tick();
  assert.equal(f.calls.length, 4);
  f.resolve(2);
  f.resolve(3);
  await tick();
  let delivered = false;
  void first.then(() => {
    delivered = true;
  });
  await tick();
  assert.equal(delivered, false);
  f.resolve(0);
  assert.equal((await first).value!.oid, f.ids[0]);
  await tick();
  assert.equal(
    f.calls.length,
    4,
    "completed lookahead must not grow until the consumer advances",
  );
  const second = iterator.next();
  await tick();
  assert.equal(f.calls.length, 5);
  f.resolve(1);
  assert.equal((await second).value!.oid, f.ids[1]);
  let drained = false;
  const closing = iterator.return(undefined).then(() => {
    drained = true;
  });
  await tick();
  assert.equal(
    drained,
    false,
    "cancellation waits for the already-started fifth read",
  );
  f.resolve(4);
  await closing;
  assert.equal(f.calls.length, 5, "sixth read never starts");
  assert.ok(observations.every(([b, n]) => b <= 8 * 1024 * 1024 && n <= 4));
});

test("lookahead reserves yielded payloads and respects the byte budget for mixed object sizes", async () => {
  const f = fixture([5 * 1024 * 1024, 3 * 1024 * 1024, 1, 1, 1]);
  const iterator = prefetchObjects(f.ids, f.load, { size: f.size });
  const first = iterator.next();
  await tick();
  assert.equal(f.calls.length, 2);
  f.resolve(0);
  f.resolve(1);
  await first;
  await tick();
  assert.equal(f.calls.length, 2);
  const second = await iterator.next();
  assert.equal(second.value!.oid, f.ids[1]);
  await tick();
  assert.equal(f.calls.length, 5);
  f.resolve(2);
  f.resolve(3);
  f.resolve(4);
  await iterator.return(undefined);
  const fallback = fixture([1, 1]);
  const conservative = prefetchObjects(fallback.ids, fallback.load);
  const result = conservative.next();
  await tick();
  assert.equal(fallback.calls.length, 1);
  fallback.resolve(0);
  await result;
  await conservative.return(undefined);
  assert.equal(fallback.calls.length, 1);
});

test("a failed prefetched read drains siblings and never schedules replacement reads", async () => {
  const f = fixture([1, 1, 1, 1, 1]);
  const iterator = prefetchObjects(f.ids, f.load, { size: f.size });
  const first = iterator.next(),
    rejected = assert.rejects(first, /R2 unavailable/);
  await tick();
  f.pending.get(f.ids[2])!.reject(Error("R2 unavailable"));
  f.resolve(0);
  await tick();
  let finished = false;
  void rejected.then(() => {
    finished = true;
  });
  await tick();
  assert.equal(finished, false);
  f.resolve(1);
  f.resolve(3);
  await rejected;
  assert.equal(f.calls.length, 4);
});

test("verified metadata mismatch and invalid sizes fail without unhandled or undrained reads", async () => {
  const f = fixture([1, 1, 1]);
  const iterator = prefetchObjects(f.ids, f.load, { size: () => 0 });
  const next = iterator.next(),
    rejected = assert.rejects(next, /differs from verified index/);
  await tick();
  f.resolve(0);
  f.resolve(1);
  f.resolve(2);
  await rejected;
  for (const size of [-1, NaN, Infinity, LIMITS.object + 1, 0.5]) {
    let loads = 0;
    await assert.rejects(
      prefetchObjects(
        [f.ids[0]],
        async () => {
          loads++;
          return f.objects[0];
        },
        { size: () => size },
      ).next(),
      /Invalid indexed/,
    );
    assert.equal(loads, 0);
  }
});

test("prefetched packs retain Git checksums and response cancellation drains every pending read", async () => {
  const objects = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      makeObject("blob", bytes("object " + i + "\n")),
    ),
  );
  const parts: Uint8Array[] = [];
  for await (const chunk of packChunks(
    objects.map((o) => o.oid),
    async (oid) => objects.find((o) => o.oid === oid)!,
    { size: (oid) => objects.find((o) => o.oid === oid)!.data.length },
  ))
    parts.push(chunk);
  assert.deepEqual(
    (await parsePack(new Uint8Array(Buffer.concat(parts)))).map((o) => o.oid),
    objects.map((o) => o.oid),
  );
  const f = fixture([1, 1, 1, 1, 1]);
  const response = streamResponse(
      packChunks(f.ids, f.load, { size: f.size }),
      {},
    ),
    reader = response.body!.getReader();
  await reader.read();
  assert.equal(f.calls.length, 0, "pack header precedes object I/O");
  const body = reader.read();
  await tick();
  f.resolve(0);
  await body;
  let completed = false;
  void responseCompletion(response)!.then(() => {
    completed = true;
  });
  const canceled = reader.cancel();
  await tick();
  assert.equal(completed, false);
  f.resolve(1);
  f.resolve(2);
  f.resolve(3);
  await canceled;
  await responseCompletion(response);
  assert.equal(completed, true);
  assert.equal(f.calls.length, 4);
});
