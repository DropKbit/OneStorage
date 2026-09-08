import test from "node:test";
import assert from "node:assert/strict";
import {
  acquireSnapshot,
  SnapshotBudget,
  SnapshotStore,
  SNAPSHOT_LIMITS,
  snapshotRead,
  shareableOperation,
  repositoryRead,
  snapshotResponse,
} from "../src/git/snapshot-read";
import {
  ObjectStore,
  bytes,
  canonical,
  makeObject,
  treeBytes,
} from "../src/git/objects";
import { ObjectCache } from "../src/git/object-cache";
import { ForgeRepository } from "../src/git/forge";
import { responseCompletion } from "../src/git/pack-stream";

test("the additional reader slot is isolate-wide and release is idempotent", () => {
  const first = acquireSnapshot();
  assert.ok(first);
  assert.equal(acquireSnapshot(), undefined);
  first();
  first();
  const second = acquireSnapshot();
  assert.ok(second);
  second();
});

test("only reviewed read routes can bypass; lifecycle, writes and complex reads remain exclusive", () => {
  const req = (path: string, method = "GET") =>
    new Request("https://repository" + path, { method });
  for (const path of ["/browse", "/blob", "/branches", "/commits", "/file"])
    assert.equal(snapshotRead(req(path)), true);
  for (const path of [
    "/internal/delete",
    "/internal/transfer",
    "/internal/lifecycle",
    "/internal/fork-export",
    "/archive",
    "/grep",
    "/commit",
  ])
    assert.equal(shareableOperation(req(path, "POST")), false);
  assert.equal(snapshotRead(req("/file", "POST")), false);
  assert.equal(snapshotRead(req("/browse", "HEAD")), false);
  assert.equal(snapshotRead(req("/file", "HEAD")), true);
  assert.equal(shareableOperation(req("/git/git-receive-pack", "POST")), true);
  assert.equal(shareableOperation(req("/git/git-upload-pack", "POST")), true);
});

test("large cached and R2 objects are rejected before copying or consuming their body", async () => {
  const object = await makeObject(
    "blob",
    new Uint8Array(SNAPSHOT_LIMITS.object + 1),
  );
  const cache = new ObjectCache();
  cache.put("r", object);
  assert.equal(cache.get("r", object.oid, SNAPSHOT_LIMITS.object), undefined);
  let consumed = false,
    canceled = false;
  const bucket = {
    get: async () => ({
      size: object.data.length + 64,
      body: {
        cancel: async () => {
          canceled = true;
        },
      },
      arrayBuffer: async () => {
        consumed = true;
        return canonical(object).buffer;
      },
    }),
  } as unknown as R2Bucket;
  const store = new SnapshotStore("r", bucket, cache);
  await assert.rejects(store.get(object.oid), SnapshotBudget);
  await store.close();
  assert.equal(consumed, false);
  assert.equal(canceled, true);
});

test("served byte and request budgets include cache hits and bound parallel reservations", async () => {
  const object = await makeObject(
    "blob",
    new Uint8Array(SNAPSHOT_LIMITS.object),
  );
  const raw = canonical(object);
  const bucket = {
    get: async () => ({
      size: raw.length,
      arrayBuffer: async () => raw.slice().buffer,
    }),
  } as unknown as R2Bucket;
  const store = new SnapshotStore("r", bucket);
  for (let i = 0; i < 4; i++) await store.get(object.oid);
  await assert.rejects(store.get(object.oid), SnapshotBudget);
  await store.close();
  const empty = await makeObject("blob", bytes("")),
    cache = new ObjectCache();
  cache.put("r", empty);
  const tiny = new SnapshotStore("r", bucket, cache);
  for (let i = 0; i < SNAPSHOT_LIMITS.calls; i++) await tiny.get(empty.oid);
  await assert.rejects(tiny.get(empty.oid), SnapshotBudget);
  await tiny.close();
});

test("closing a failed parallel read drains started R2 operations and prohibits later reads", async () => {
  let finish!: () => void,
    started = 0;
  const gate = new Promise<void>((r) => {
    finish = r;
  });
  const object = await makeObject("blob", bytes("small")),
    raw = canonical(object);
  const store = new SnapshotStore("r", {
    get: async () => {
      started++;
      await gate;
      return { size: raw.length, arrayBuffer: async () => raw.slice().buffer };
    },
  } as unknown as R2Bucket);
  const reads = Array.from({ length: 5 }, () => store.get(object.oid));
  await assert.rejects(Promise.all(reads), SnapshotBudget);
  let closed = false;
  const closing = store.close().then(() => {
    closed = true;
  });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(started, 1);
  assert.equal(closed, false);
  await assert.rejects(store.get(object.oid), SnapshotBudget);
  finish();
  await closing;
  assert.equal(closed, true);
});

test("shared route implementation preserves snapshot content, conditional files and response completion", async () => {
  const blob = await makeObject("blob", bytes("# Hello\n"));
  const tree = await makeObject(
    "tree",
    treeBytes([
      { name: "README.md", type: "blob", mode: "100644", sha: blob.oid },
    ]),
  );
  const commit = await makeObject(
    "commit",
    bytes(
      `tree ${tree.oid}\nauthor A <a@b> 1 +0000\ncommitter A <a@b> 1 +0000\n\nInitial\n`,
    ),
  );
  const objects = new Map(
    [blob, tree, commit].map((o) => [o.oid, canonical(o)]),
  );
  const bucket = {
    get: async (key: string) => {
      const data = objects.get(key.split("/").at(-1)!);
      return data
        ? { size: data.length, arrayBuffer: async () => data.slice().buffer }
        : null;
    },
  } as unknown as R2Bucket;
  const refs = { "refs/heads/main": commit.oid };
  const repository = (store: ObjectStore) =>
    new ForgeRepository(
      store,
      {
        get: async () => undefined,
        put: async () => {
          throw Error("unexpected write");
        },
      },
      { ...refs },
      "main",
    );
  for (const path of [
    "/browse",
    "/tree",
    "/branches",
    "/commits",
    "/commit-detail",
    "/blob?path=README.md",
    "/file?path=README.md",
    "/file?path=README.md&ref=" + commit.oid,
  ]) {
    const request = new Request("https://repository" + path);
    const serial = await repositoryRead(
      repository(new ObjectStore("r", bucket)),
      request,
      "main",
    );
    const store = new SnapshotStore("r", bucket);
    const snapshot = await snapshotResponse(
      (await repositoryRead(repository(store), request, "main"))!,
    );
    await store.close();
    assert.equal(snapshot.status, serial!.status);
    assert.equal(await snapshot.text(), await serial!.text());
    await responseCompletion(snapshot);
  }
  const request = new Request("https://repository/file?path=README.md", {
    headers: { "if-none-match": '"' + blob.oid + '"' },
  });
  const response = await snapshotResponse(
    (await repositoryRead(
      repository(new SnapshotStore("r", bucket)),
      request,
      "main",
    ))!,
  );
  assert.equal(response.status, 304);
  assert.equal(response.body, null);
  const partial = await snapshotResponse(
    new Response(bytes("part"), {
      status: 206,
      headers: { "content-range": "bytes 0-3/9" },
    }),
  );
  assert.equal(partial.status, 206);
  assert.equal(await partial.text(), "part");
  assert.equal(partial.headers.get("content-range"), "bytes 0-3/9");
  await assert.rejects(
    snapshotResponse(
      new Response(new Uint8Array(SNAPSHOT_LIMITS.response + 1)),
    ),
    SnapshotBudget,
  );
});
