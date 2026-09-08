import test from "node:test";
import assert from "node:assert/strict";
import {
  GitIO,
  gitStage,
  gitFailureDetails,
  reportGitFailure,
} from "../src/git/diagnostics";
import { ObjectStore, bytes, canonical, makeObject } from "../src/git/objects";
import { GitRepository, publishRefs } from "../src/git/repository";
import { receive } from "../src/git/protocol";
import { parsePack, writePack } from "../src/git/pack";
import { deflate } from "pako";
import { pkt, FLUSH } from "../src/git/pkt";
import { concat, fromHex, sha1, ZERO, text } from "../src/git/objects";
import { HTTPException } from "hono/http-exception";

test("R2 recovery handles writes committed before a transient response failure without overwriting objects", async () => {
  const objects = new Map<string, Uint8Array>(),
    delays: number[] = [];
  const observed: unknown[] = [];
  const io = new GitIO(
    async (ms) => {
      delays.push(ms);
    },
    (detail) => {
      observed.push(detail);
    },
  );
  let writes = 0,
    reads = 0,
    publications = 0;
  const bucket = {
    async put(k: string, data: Uint8Array, options: any) {
      writes++;
      assert.equal(options.onlyIf.etagDoesNotMatch, "*");
      if (objects.has(k)) return null;
      objects.set(k, data.slice());
      throw Error("put: Service unavailable (10043)");
    },
    async get(k: string) {
      reads++;
      const data = objects.get(k)!;
      return {
        size: data.length,
        arrayBuffer: async () => data.slice().buffer,
      };
    },
  };
  const store = new ObjectStore("r", bucket as any, undefined, undefined, io);
  const o = await store.create("blob", bytes("durable"));
  await publishRefs(
    store,
    {
      get: async () => undefined,
      put: async () => {
        publications++;
      },
    },
    { "refs/heads/main": o.oid },
  );
  assert.equal(writes, 2);
  assert.equal(reads, 1);
  assert.equal(publications, 1);
  assert.equal(io.retries, 1);
  assert.deepEqual(observed, [
    { stage: "object-write", code: 10043, retry: 1 },
  ]);
  assert.ok(delays[0] >= 150 && delays[0] < 250);
  assert.deepEqual(objects.get("repos/r/objects/" + o.oid), canonical(o));
  assert.equal(store.memoryUsage.stagedBytes, 0);
});

test("conditional retry still rejects a conflicting stored object and never publishes", async () => {
  const io = new GitIO(async () => {});
  let attempts = 0,
    published = false;
  const store = new ObjectStore(
    "r",
    {
      put: async () => {
        if (++attempts === 1) throw Error("put: Internal error (10001)");
        return null;
      },
      get: async () => ({
        size: 7,
        arrayBuffer: async () => bytes("corrupt").buffer,
      }),
    } as any,
    undefined,
    undefined,
    io,
  );
  const o = await store.create("blob", bytes("one"));
  await assert.rejects(
    publishRefs(
      store,
      {
        get: async () => undefined,
        put: async () => {
          published = true;
        },
      },
      { "refs/heads/main": o.oid },
    ),
    /Conflicting/,
  );
  assert.equal(attempts, 2);
  assert.equal(published, false);
  assert.ok(store.staged.has(o.oid));
});

test("R2 retries have per-operation and shared request bounds, honor rate backoff, and drain both lanes", async () => {
  const delays: number[] = [],
    io = new GitIO(async (ms) => {
      delays.push(ms);
    });
  let active = 0,
    peak = 0,
    writes = 0,
    published = false;
  const store = new ObjectStore(
    "r",
    {
      put: async () => {
        writes++;
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 2));
        active--;
        throw Error("put: Too many requests (10058)");
      },
    } as any,
    undefined,
    undefined,
    io,
  );
  const a = await store.create("blob", bytes("a"));
  await store.create("blob", bytes("b"));
  await assert.rejects(
    publishRefs(
      store,
      {
        get: async () => undefined,
        put: async () => {
          published = true;
        },
      },
      { "refs/heads/main": a.oid },
    ),
    /10058/,
  );
  assert.equal(writes, 6);
  assert.equal(io.retries, 4);
  assert.equal(active, 0);
  assert.equal(peak, 2);
  assert.equal(published, false);
  assert.ok(delays.every((x) => x >= 1100));
  assert.equal(store.staged.size, 2);
  await assert.rejects(store.flush());
  assert.equal(writes, 8);
  assert.equal(io.retries, 4);
});

test("read retry deduplicates concurrent readers; unknown, permission and validation errors never retry", async () => {
  const io = new GitIO(async () => {}),
    o = await makeObject("blob", bytes("value"));
  let reads = 0;
  const store = new ObjectStore(
    "r",
    {
      get: async () => {
        if (++reads === 1) throw Error("get: Internal error (10001)");
        const d = canonical(o);
        return { size: d.length, arrayBuffer: async () => d.buffer };
      },
    } as any,
    undefined,
    undefined,
    io,
  );
  const result = await Promise.all([store.get(o.oid), store.get(o.oid)]);
  assert.equal(reads, 2);
  assert.equal(result[0], result[1]);
  for (const e of [
    Error("put: Permission denied (10003)"),
    Error("get: unknown"),
    new HTTPException(409, { message: "put: Service unavailable (10043)" }),
  ]) {
    let calls = 0;
    await assert.rejects(
      io.run("object-write", async () => {
        calls++;
        throw e;
      }),
      (error) => error === e,
    );
    assert.equal(calls, 1);
  }
});

test("uncertain reference publication is never retried and preserves its diagnostic stage", async () => {
  const object = await makeObject("blob", bytes("already durable"));
  let writes = 0;
  const store = new ObjectStore("r", {
    get: async () => {
      const d = canonical(object);
      return { size: d.length, arrayBuffer: async () => d.buffer };
    },
  } as any);
  const error = Object.assign(
    Error("Durable object reset secret=not-for-logs"),
    { retryable: true },
  );
  await assert.rejects(
    publishRefs(
      store,
      {
        get: async () => undefined,
        put: async () => {
          writes++;
          throw error;
        },
      },
      { "refs/heads/main": object.oid },
    ),
    (e) => e === error,
  );
  assert.equal(writes, 1);
  assert.equal(gitFailureDetails(error).stage, "ref-publish");
  assert.equal(gitFailureDetails(error).retryable, true);
});

test("diagnostics expose only generated incident IDs, safe codes and locations, never exception content", async () => {
  const secret = "private credential and source content",
    error = Error("put: " + secret + " (10043)");
  error.stack = `Error: ${secret}\n    at ${secret} (index.js:123:45)\n    at private (/Users/${secret}/file.ts:1:2)`;
  try {
    await gitStage("object-index", () =>
      gitStage("object-write", async () => {
        throw error;
      }),
    );
  } catch {}
  const details = gitFailureDetails(error);
  assert.equal(details.stage, "object-write");
  assert.equal(details.r2Code, 10043);
  assert.deepEqual(details.frames, ["123:45"]);
  const logs: unknown[][] = [],
    original = console.error;
  console.error = (...args) => {
    logs.push(args);
  };
  let incident: string;
  try {
    incident = reportGitFailure(
      error,
      "11111111-1111-4111-8111-111111111111",
      "receive-pack",
    );
  } finally {
    console.error = original;
  }
  assert.match(incident!, /^[0-9a-f-]{36}$/);
  assert.ok(JSON.stringify(logs).includes(incident!));
  assert.ok(!JSON.stringify(logs).includes(secret));
  const d1 = Error("D1_ERROR: " + secret);
  try {
    await gitStage("metadata", async () => {
      throw d1;
    });
  } catch {}
  assert.equal(gitFailureDetails(d1).d1, true);
  assert.ok(!JSON.stringify(gitFailureDetails(d1)).includes(secret));
});

test("native receive-pack returns a correlated incident without leaking the storage exception or publishing refs", async () => {
  const tree = await makeObject("tree", new Uint8Array());
  const commit = await makeObject(
    "commit",
    bytes(
      `tree ${tree.oid}\nauthor A <a@b> 1 +0000\ncommitter A <a@b> 1 +0000\n\nInitial\n`,
    ),
  );
  let published = false;
  const store = new ObjectStore("11111111-1111-4111-8111-111111111111", {
    put: async () => {
      throw Error("put: private credential (10003)");
    },
  } as any);
  const repo = new GitRepository(
    store,
    {
      get: async () => undefined,
      put: async () => {
        published = true;
      },
    },
    {},
    "main",
  );
  const logs: unknown[][] = [],
    original = console.error;
  console.error = (...args) => {
    logs.push(args);
  };
  let response: Response;
  try {
    response = await receive(
      repo,
      concat(
        pkt(`${ZERO} ${commit.oid} refs/heads/main\0report-status\n`),
        FLUSH,
        await writePack([tree, commit]),
      ),
    );
  } finally {
    console.error = original;
  }
  const body = await response!.text();
  assert.equal(response!.status, 200);
  assert.match(
    body,
    /ng refs\/heads\/main Object persistence or reference update failed; incident [0-9a-f-]{36}/,
  );
  assert.equal(published, false);
  assert.deepEqual(repo.refs, {});
  assert.equal(logs.length, 1);
  const record = logs[0][1] as any;
  assert.equal(record.r2Code, 10003);
  assert.equal(record.stage, "object-write");
  assert.ok(body.includes(record.incident));
  assert.ok(!body.includes("private credential"));
  assert.ok(!JSON.stringify(logs).includes("private credential"));
});

async function deltaPack(entries: Uint8Array[]) {
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
  const body = concat(header, ...entries);
  return concat(body, fromHex(await sha1(body)));
}
test("thin-pack storage failures remain identifiable; later in-pack bases can still resolve without external storage", async () => {
  const base = await makeObject("blob", bytes("base")),
    next = await makeObject("blob", bytes("next"));
  const reference = concat(
    Uint8Array.of(0x76),
    fromHex(next.oid),
    deflate(Uint8Array.of(4, 5, 0x90, 4, 1, 33)),
  );
  const error = Error("get: private data (10043)");
  const thin = await deltaPack([reference]);
  await assert.rejects(
    parsePack(thin, async () => {
      throw error;
    }),
    (e) => e === error,
  );
  const later = concat(
    Uint8Array.of(0x77),
    fromHex(base.oid),
    deflate(Uint8Array.of(4, 4, 4, 110, 101, 120, 116)),
  );
  const complete = await deltaPack([
    reference,
    later,
    concat(Uint8Array.of(0x34), deflate(base.data)),
  ]);
  assert.equal(
    text(
      (
        await parsePack(complete, async () => {
          throw error;
        })
      )[0].data,
    ),
    "next!",
  );
  await assert.rejects(
    parsePack(thin, async (oid) => {
      throw new HTTPException(409, { message: "Missing Git object " + oid });
    }),
    /Unresolved or cyclic/,
  );
  const store = new ObjectStore(
    "11111111-1111-4111-8111-111111111111",
    {
      get: async () => {
        throw error;
      },
    } as any,
    undefined,
    undefined,
    new GitIO(async () => {}),
  );
  let published = false;
  const repo = new GitRepository(
    store,
    {
      get: async () => undefined,
      put: async () => {
        published = true;
      },
    },
    {},
    "main",
  );
  const logs: unknown[][] = [],
    original = console.error;
  console.error = (...args) => {
    logs.push(args);
  };
  let response: Response;
  try {
    response = await receive(
      repo,
      concat(
        pkt(`${ZERO} ${"a".repeat(40)} refs/heads/main\0report-status\n`),
        FLUSH,
        thin,
      ),
    );
  } finally {
    console.error = original;
  }
  const body = await response!.text(),
    record = logs[0][1] as any;
  assert.match(body, /unpack processing failed; incident/);
  assert.equal(record.stage, "object-read");
  assert.equal(record.r2Code, 10043);
  assert.ok(body.includes(record.incident));
  assert.ok(!body.includes("private data"));
  assert.equal(published, false);
  assert.equal(store.ioUsage.r2Retries, 2);
});
