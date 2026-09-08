import test from "node:test";
import assert from "node:assert/strict";
import { deflate } from "pako";
import {
  ObjectStore,
  makeObject,
  bytes,
  text,
  concat,
  ZERO,
  fromHex,
  sha1,
} from "../src/git/objects";
import { GitRepository } from "../src/git/repository";
import { writePack } from "../src/git/pack";
import { pkt, FLUSH } from "../src/git/pkt";
import { ReceiveReader } from "../src/git/receive-reader";
import { parseReceivePack } from "../src/git/receive-pack";
import { receiveStream } from "../src/git/receive-stream";
import { IncomingBlocks } from "../src/git/incoming-blocks";
import {
  IncomingArea,
  collectIncoming,
  type IncomingSink,
} from "../src/git/incoming-area";

const id = "11111111-1111-4111-8111-111111111111";
function fixture() {
  const values = new Map<string, any>(),
    objects = new Map<string, Uint8Array>();
  let alarm = 0;
  const storage = {
    get: async (k: string) => values.get(k),
    put: async (k: string, v: any) => {
      values.set(k, structuredClone(v));
    },
    delete: async (k: string | string[]) => {
      for (const key of typeof k === "string" ? [k] : k) values.delete(key);
    },
    list: async (o: any) =>
      new Map(
        [...values]
          .filter(([k]) => k.startsWith(o.prefix))
          .slice(0, o.limit || Infinity),
      ),
    setAlarm: async (n: number) => {
      alarm = n;
    },
  } as any;
  const bucket = {
    get: async (k: string) => {
      const b = objects.get(k);
      return b
        ? { size: b.length, arrayBuffer: async () => b.slice().buffer }
        : null;
    },
    put: async (k: string, data: Uint8Array) => {
      if (objects.has(k)) return null;
      objects.set(k, data.slice());
      return {};
    },
    list: async (o: any) => {
      const keys = [...objects.keys()].filter((k) => k.startsWith(o.prefix));
      return {
        objects: keys.slice(0, o.limit).map((key) => ({ key })),
        truncated: keys.length > o.limit,
      };
    },
    delete: async (keys: string | string[]) => {
      for (const k of typeof keys === "string" ? [keys] : keys)
        objects.delete(k);
    },
  } as any;
  const store = new ObjectStore(id, bucket),
    repo = new GitRepository(store, storage, {}, "main");
  return {
    storage,
    bucket,
    store,
    repo,
    values,
    objects,
    get alarm() {
      return alarm;
    },
  };
}
function stream(data: Uint8Array, chunk = 65536) {
  let offset = 0;
  return new ReadableStream({
    type: "bytes",
    pull(c) {
      if (offset === data.length) {
        c.close();
        c.byobRequest?.respond(0);
        return;
      }
      const next = data.slice(offset, offset + chunk);
      offset += next.length;
      c.enqueue(next);
    },
  } as UnderlyingByteSource);
}
function request(data: Uint8Array, chunk = 65536) {
  return new Request("https://git.invalid/receive", {
    method: "POST",
    body: stream(data, chunk),
    duplex: "half",
  } as any);
}
async function simple() {
  const tree = await makeObject("tree", new Uint8Array());
  const commit = await makeObject(
    "commit",
    bytes(
      `tree ${tree.oid}\nauthor T <t@e> 1 +0000\ncommitter T <t@e> 1 +0000\n\nInitial\n`,
    ),
  );
  return {
    tree,
    commit,
    header: concat(
      pkt(`${ZERO} ${commit.oid} refs/heads/main\0report-status\n`),
      FLUSH,
    ),
    pack: await writePack([tree, commit]),
  };
}
test("streamed receive publishes only after the checksum, supports arbitrary byte splits, and cleans quarantine", async () => {
  const data = await simple();
  for (const size of [1, 7, 65536]) {
    const f = fixture();
    const response = await receiveStream(
      f.repo,
      request(concat(data.header, data.pack), size),
      f.bucket,
      f.storage,
    );
    assert.match(await response.text(), /ok refs\/heads\/main/);
    assert.equal(f.repo.refs["refs/heads/main"], data.commit.oid);
    assert.deepEqual(await f.store.get(data.commit.oid), data.commit);
    assert.ok(
      [...f.objects.keys()].every((k) => k.startsWith(`repos/${id}/objects/`)),
    );
    assert.equal(
      [...f.values.keys()].filter((k) => k.startsWith("incoming:")).length,
      0,
    );
  }
});
test("bad checksum, truncated body and trailing input never promote quarantined objects", async () => {
  const data = await simple(),
    bad = data.pack.slice();
  bad[bad.length - 1] ^= 1;
  for (const pack of [
    bad,
    data.pack.slice(0, -1),
    concat(data.pack, bytes("x")),
  ]) {
    const f = fixture(),
      response = await receiveStream(
        f.repo,
        request(concat(data.header, pack), 13),
        f.bucket,
        f.storage,
      );
    assert.match(await response.text(), /ng refs\/heads\/main/);
    assert.deepEqual(f.repo.refs, {});
    assert.equal(f.objects.size, 0);
    assert.equal(f.values.size, 0);
  }
});
test("input backpressure cannot publish objects before the final checksum arrives", async () => {
  const f = fixture(),
    data = await simple(),
    body = concat(data.header, data.pack);
  let allow!: () => void,
    waiting!: () => void,
    phase = 0;
  const gate = new Promise<void>((r) => {
      allow = r;
    }),
    reached = new Promise<void>((r) => {
      waiting = r;
    });
  const source = new ReadableStream({
    type: "bytes",
    async pull(c) {
      if (phase++ === 0) {
        c.enqueue(body.slice(0, -20));
        return;
      }
      if (phase === 2) {
        waiting();
        await gate;
        c.enqueue(body.slice(-20));
        return;
      }
      c.close();
      c.byobRequest?.respond(0);
    },
  } as UnderlyingByteSource);
  const pending = receiveStream(
    f.repo,
    new Request("https://git.invalid", {
      method: "POST",
      body: source,
      duplex: "half",
    } as any),
    f.bucket,
    f.storage,
  );
  await reached;
  assert.equal(f.objects.size, 0);
  assert.equal(
    [...f.values.keys()].filter((k) => k.startsWith("incoming:")).length,
    1,
  );
  assert.equal(f.values.has("refs.v2"), false);
  allow();
  assert.match(await (await pending).text(), /ok refs\/heads\/main/);
});
test("durable incoming markers recover orphaned uploads, cleanup failures, and marker-only interruptions", async () => {
  const f = fixture(),
    area = new IncomingArea(f.bucket, f.storage, f.store);
  await area.begin();
  await area.save(await makeObject("blob", bytes("pending")));
  await area.settle();
  assert.ok(f.alarm > 0);
  const original = f.bucket.delete;
  f.bucket.delete = async () => {
    throw Error("temporary failure");
  };
  await area.close();
  assert.equal(f.objects.size, 1);
  assert.equal(f.values.size, 1);
  f.bucket.delete = original;
  assert.equal(await collectIncoming(f.bucket, f.storage), false);
  assert.equal(f.objects.size, 0);
  assert.equal(f.values.size, 0);
  const interrupted = new IncomingArea(f.bucket, f.storage, f.store);
  f.storage.setAlarm = async () => {
    throw Error("alarm unavailable");
  };
  await assert.rejects(interrupted.begin());
  await interrupted.close();
  assert.equal(f.values.size, 0);
});
test("stale and forbidden receive commands are rejected before persisting upload data", async () => {
  const data = await simple();
  for (const variant of ["stale", "policy"]) {
    const f = fixture();
    if (variant === "stale") f.repo.refs["refs/heads/main"] = "a".repeat(40);
    else f.repo.policy.rules = [["refs/heads/main", ["no-push"]]];
    const response = await receiveStream(
      f.repo,
      request(concat(data.header, data.pack)),
      f.bucket,
      f.storage,
    );
    assert.match(await response.text(), /ng refs\/heads\/main/);
    assert.equal(f.objects.size, 0);
    assert.equal(f.values.size, 0);
  }
});

async function envelope(entries: Uint8Array[]) {
  const header = Uint8Array.from([
    80,
    65,
    67,
    75,
    0,
    0,
    0,
    2,
    0,
    0,
    0,
    entries.length,
  ]);
  new DataView(header.buffer).setUint32(8, entries.length);
  const body = concat(header, ...entries);
  return concat(body, fromHex(await sha1(body)));
}
test("streaming delta resolution supports forward bases, quarantined integrity and original external I/O failures", async () => {
  const base = await makeObject("blob", bytes("abc")),
    delta = Uint8Array.of(3, 4, 0x90, 3, 1, 100);
  const ref = concat(
    Uint8Array.of(0x70 | delta.length),
    fromHex(base.oid),
    deflate(delta),
  );
  const plain = concat(Uint8Array.of(0x33), deflate(base.data));
  const f = fixture(),
    area = new IncomingArea(f.bucket, f.storage, f.store);
  await area.begin();
  const reader = new ReceiveReader(stream(await envelope([ref, plain]), 1));
  const stats = await parseReceivePack(reader, area);
  await reader.close();
  assert.equal(stats.objects, 2);
  const oid = (await makeObject("blob", bytes("abcd"))).oid;
  assert.equal(text((await area.load(oid)).data), "abcd");
  await area.close();
  const error = Error("get: service unavailable (10043)");
  const sink: IncomingSink = {
    save: async () => {},
    load: async () => {
      throw error;
    },
    delta: async () => {},
    loadDelta: async () => delta,
    settle: async () => {},
  };
  const thin = new ReceiveReader(stream(await envelope([ref])));
  await assert.rejects(parseReceivePack(thin, sink), (e) => e === error);
  await thin.close();
  const tampered = fixture(),
    session = new IncomingArea(
      tampered.bucket,
      tampered.storage,
      tampered.store,
    );
  await session.begin();
  const original = session.loadDelta.bind(session);
  session.loadDelta = async (offset) => {
    const data = await original(offset);
    data[0] ^= 1;
    return data;
  };
  const corrupt = new ReceiveReader(stream(await envelope([ref, plain])));
  await assert.rejects(
    parseReceivePack(corrupt, session),
    /integrity mismatch/,
  );
  await corrupt.close();
  await session.close();
});
test("receive reader cancels stalled input and counts input independently of content-length", async () => {
  let canceled = false;
  const reader = new ReceiveReader(
    new ReadableStream({
      pull() {
        return new Promise(() => {});
      },
      cancel() {
        canceled = true;
      },
    }),
    10,
  );
  await assert.rejects(reader.read(1), /idle timeout/);
  await reader.close();
  assert.equal(canceled, true);
});

function objectHeader(type: number, size: number) {
  const result = [(type << 4) | (size & 15)];
  for (size = Math.floor(size / 16); size; size = Math.floor(size / 128)) {
    result[result.length - 1] |= 128;
    result.push(size & 127);
  }
  return Uint8Array.from(result);
}
function discardSink(): IncomingSink {
  return {
    save: async () => {},
    load: async () => {
      throw Error("unexpected base read");
    },
    delta: async () => {},
    loadDelta: async () => {
      throw Error("unexpected delta read");
    },
    settle: async () => {},
  };
}
async function parseFixture(data: Uint8Array, sink = discardSink()) {
  const reader = new ReceiveReader(stream(data));
  try {
    return await parseReceivePack(reader, sink);
  } finally {
    await reader.close();
  }
}
test("one streamed pack crosses previous object and expansion limits with bounded live payload", async () => {
  const large = concat(
      objectHeader(3, 7 * 1024 * 1024),
      deflate(new Uint8Array(7 * 1024 * 1024)),
    ),
    small = concat(objectHeader(3, 1), deflate(Uint8Array.of(1))),
    entries = [...Array(2100).fill(small), ...Array(5).fill(large)];
  const stats = await parseFixture(await envelope(entries));
  assert.equal(stats.objects, 2105);
  assert.ok(stats.expandedBytes > 32 * 1024 * 1024);
  assert.equal(stats.peakPayloadBytes, 7 * 1024 * 1024);
});
test("streamed receive enforces object count, object size, expansion, offsets and wire limits", async () => {
  const header = new Uint8Array(12);
  header.set(bytes("PACK"));
  new DataView(header.buffer).setUint32(4, 2);
  new DataView(header.buffer).setUint32(8, 25001);
  await assert.rejects(parseFixture(header), /25000 objects/);
  await assert.rejects(
    parseFixture(await envelope([objectHeader(3, 8 * 1024 * 1024 + 1)])),
    /8 MiB/,
  );
  await assert.rejects(
    parseFixture(await envelope([Uint8Array.of(0x60, 1)])),
    /earlier object/,
  );
  const large = concat(
    objectHeader(3, 8 * 1024 * 1024),
    deflate(new Uint8Array(8 * 1024 * 1024)),
  );
  await assert.rejects(
    parseFixture(await envelope(Array(33).fill(large))),
    /256 MiB/,
  );
  const reader = new ReceiveReader(
    new ReadableStream({
      pull(c) {
        c.enqueue(new Uint8Array(65536));
      },
    }),
  );
  try {
    await assert.rejects(async () => {
      for (;;) {
        const chunk = await reader.chunk();
        reader.advance(chunk!.length);
      }
    }, /64 MiB/);
  } finally {
    await reader.close();
  }
});
test("R2 failures during quarantine or promotion never publish references", async () => {
  const data = await simple();
  for (const phase of ["quarantine", "promotion"]) {
    const f = fixture(),
      original = f.bucket.put;
    f.bucket.put = async (key: string, value: Uint8Array) => {
      if (key.includes("/incoming/") === (phase === "quarantine"))
        throw Error("injected persistent object write failure");
      return original(key, value);
    };
    const response = await receiveStream(
      f.repo,
      request(concat(data.header, data.pack)),
      f.bucket,
      f.storage,
    );
    assert.match(await response.text(), /ng refs\/heads\/main/);
    assert.deepEqual(f.repo.refs, {});
    assert.equal(f.values.has("refs.v2"), false);
    assert.equal(
      [...f.objects.keys()].some((k) => k.includes("/incoming/")),
      false,
    );
    assert.equal(
      [...f.values.keys()].some((k) => k.startsWith("incoming:")),
      false,
    );
  }
});
test("quarantine cleanup is paged and retains the durable marker until all keys are removed", async () => {
  const f = fixture(),
    area = new IncomingArea(f.bucket, f.storage, f.store);
  await area.begin();
  const marker = [...f.values.values()][0],
    root = `repos/${id}/incoming/${marker.session}/`;
  for (let i = 0; i < 2501; i++)
    f.objects.set(root + "delta/" + i, Uint8Array.of(1));
  f.objects.set(`repos/${id}/objects/kept`, Uint8Array.of(2));
  await area.close();
  assert.equal(f.objects.size, 1502);
  assert.equal(f.values.size, 1);
  assert.equal(await collectIncoming(f.bucket, f.storage), true);
  assert.equal(await collectIncoming(f.bucket, f.storage), false);
  assert.equal(f.values.size, 0);
  assert.deepEqual([...f.objects.keys()], [`repos/${id}/objects/kept`]);
});

test("OFS delta chains retain exact offsets and reject depth 65", async () => {
  const plain = concat(objectHeader(3, 3), deflate(bytes("abc"))),
    delta = Uint8Array.of(3, 3, 0x90, 3);
  for (const depth of [64, 65]) {
    const entries = [plain];
    for (let i = 0; i < depth; i++) {
      const distance = entries.at(-1)!.length;
      assert.ok(distance < 128);
      entries.push(
        concat(
          objectHeader(6, delta.length),
          Uint8Array.of(distance),
          deflate(delta),
        ),
      );
    }
    const objects = new Map<string, any>(),
      deltas = new Map<number, Uint8Array>();
    const sink: IncomingSink = {
      save: async (o) => {
        objects.set(o.oid, o);
      },
      load: async (oid) => objects.get(oid),
      delta: async (offset, data) => {
        deltas.set(offset, data);
      },
      loadDelta: async (offset) => deltas.get(offset)!,
      settle: async () => {},
    };
    if (depth === 65)
      await assert.rejects(
        parseFixture(await envelope(entries), sink),
        /chain exceeds 64/,
      );
    else
      assert.equal(
        (await parseFixture(await envelope(entries), sink)).objects,
        65,
      );
  }
});

test("wire spool drains to bounded R2 chunks and supports cancellation cleanup", async () => {
  const f = fixture(),
    area = new IncomingArea(f.bucket, f.storage, f.store),
    data = new Uint8Array(9 * 1024 * 1024 + 17);
  data[0] = 42;
  data[data.length - 1] = 99;
  await area.begin();
  const input = new ReceiveReader(stream(data)),
    source = await area.spool(input);
  await input.close();
  assert.equal(area.metrics.wireChunks, 3);
  assert.equal(area.metrics.spooledBytes, data.length);
  assert.ok([...f.objects.values()].every((b) => b.length <= 4 * 1024 * 1024));
  const output = new ReceiveReader(source, undefined, 4 * 1024 * 1024);
  assert.equal(await output.byte(), 42);
  await output.close();
  await area.close();
  assert.equal(f.objects.size, 0);
  assert.equal(f.values.size, 0);
});

test("wire spool corruption is caught by pack verification before canonical writes", async () => {
  const f = fixture(),
    data = await simple(),
    original = f.bucket.get;
  f.bucket.get = async (key: string) => {
    const value = await original(key);
    if (!key.includes("/wire/") || !value) return value;
    const corrupt = new Uint8Array(await value.arrayBuffer());
    corrupt[corrupt.length - 1] ^= 1;
    return { size: corrupt.length, arrayBuffer: async () => corrupt.buffer };
  };
  const result = await receiveStream(
    f.repo,
    request(concat(data.header, data.pack)),
    f.bucket,
    f.storage,
  );
  assert.match(await result.text(), /checksum mismatch/);
  assert.deepEqual(f.repo.refs, {});
  assert.equal(f.objects.size, 0);
});

test("quarantine groups tiny entries into bounded immutable blocks and isolates returned slices", async () => {
  const f = fixture(),
    blocks = new IncomingBlocks(f.bucket, "test/incoming/", id);
  for (let i = 0; i < 2500; i++)
    await blocks.put(String(i), bytes("entry " + i));
  await blocks.flush();
  assert.equal(blocks.ioUsage.r2Writes, 3);
  assert.equal(f.objects.size, 3);
  assert.equal(text(await blocks.get("0")), "entry 0");
  const value = await blocks.get("1");
  value[0] = 0;
  assert.equal(text(await blocks.get("1")), "entry 1");
  assert.equal(text(await blocks.get("2499")), "entry 2499");
  await assert.rejects(
    blocks.put("1", bytes("different")),
    /Conflicting incoming entry/,
  );
  assert.ok(blocks.ioUsage.peakStagedBytes <= 4 * 1024 * 1024);
});

test("an uncertain successful block write is verified before locators become available", async () => {
  const f = fixture(),
    original = f.bucket.put;
  let once = true;
  f.bucket.put = async (key: string, value: Uint8Array) => {
    const result = await original(key, value);
    if (once) {
      once = false;
      throw Error("put: service unavailable (10043)");
    }
    return result;
  };
  const blocks = new IncomingBlocks(f.bucket, "test/incoming/", id);
  await blocks.put("one", bytes("intact"));
  await blocks.flush();
  assert.equal(text(await blocks.get("one")), "intact");
  assert.equal(blocks.ioUsage.r2Retries, 1);
  assert.equal(f.objects.size, 1);
});
