import test from "node:test";
import assert from "node:assert/strict";
import app from "../src/app";
import { ObjectCache } from "../src/git/object-cache";
import { ObjectStore, bytes, canonical, makeObject } from "../src/git/objects";

test("public shell and versioned assets bypass identity storage; API authorization remains uncached", async () => {
  let queries = 0;
  const assetRequests: Request[] = [];
  const env = {
    APP_ORIGIN: "https://git.example.com",
    DB: {
      prepare() {
        queries++;
        return {
          bind() {
            return this;
          },
          async first() {
            return null;
          },
        };
      },
    },
    ASSETS: {
      async fetch(request: Request) {
        assetRequests.push(request);
        return new Response("<public-shell>", { headers: { ETag: '"build"' } });
      },
    },
  } as any;
  for (const path of [
    "/",
    "/owner/private/commits",
    "/app.js?v=0123456789abcdef",
    "/style.css",
  ]) {
    const response = await app.fetch(
      new Request("https://git.example.com" + path, {
        headers: {
          Authorization: "Bearer invalid",
          Cookie: "onestorage_session=invalid",
        },
      }),
      env,
    );
    assert.equal(response.status, 200);
    assert.match(
      response.headers.get("content-security-policy")!,
      /frame-ancestors 'none'/,
    );
    assert.match(
      response.headers.get("cache-control")!,
      path.includes("?v=") ? /immutable/ : /must-revalidate/,
    );
  }
  assert.equal(queries, 0);
  assert.ok(
    assetRequests.every(
      (r) => !r.headers.has("authorization") && !r.headers.has("cookie"),
    ),
  );
  const response = await app.fetch(
    new Request("https://git.example.com/api/repos", {
      headers: { Authorization: "Bearer invalid" },
    }),
    env,
  );
  assert.equal(response.status, 401);
  assert.equal(queries, 1);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const git = await app.fetch(
    new Request(
      "https://git.example.com/owner/private.git/info/refs?service=git-upload-pack",
      { headers: { Authorization: "Bearer invalid" } },
    ),
    env,
  );
  assert.equal(git.status, 401);
  assert.equal(queries, 2);
});
test("immutable object cache eliminates repeated R2 reads without sharing repositories or staged writes", async () => {
  let reads = 0,
    failWrite = false;
  const shared = new ObjectCache(),
    object = await makeObject("blob", bytes("original"));
  const bucket = {
    async get() {
      reads++;
      const data = canonical(object);
      return { size: data.length, arrayBuffer: async () => data.buffer };
    },
    async put() {
      if (failWrite) throw Error("injected failure");
      return {};
    },
  } as any;
  const first = new ObjectStore("repo", bucket, shared);
  await first.get(object.oid);
  const second = new ObjectStore("repo", bucket, shared);
  const read = await second.get(object.oid);
  read.data[0] = 0;
  assert.equal(reads, 1);
  assert.equal(
    new TextDecoder().decode(
      (await new ObjectStore("repo", bucket, shared).get(object.oid)).data,
    ),
    "original",
  );
  await new ObjectStore("other", bucket, shared).get(object.oid);
  assert.equal(reads, 2);
  const staged = new ObjectStore("repo", bucket, shared),
    unpublished = await staged.create("blob", bytes("staged"));
  assert.equal(shared.get("repo", unpublished.oid), undefined);
  failWrite = true;
  await assert.rejects(() => staged.flush());
  assert.equal(shared.get("repo", unpublished.oid), undefined);
});
test("object cache evicts by size/recency and expires without extending TTL on reads", async () => {
  let now = 0;
  const cache = new ObjectCache(8, 10, () => now),
    a = await makeObject("blob", bytes("aaaa")),
    b = await makeObject("blob", bytes("bbbb")),
    c = await makeObject("blob", bytes("cccc"));
  cache.put("r", a);
  cache.put("r", b);
  assert.ok(cache.get("r", a.oid));
  cache.put("r", c);
  assert.equal(cache.get("r", b.oid), undefined);
  now = 11;
  assert.equal(cache.get("r", a.oid), undefined);
  cache.clear();
  assert.equal(cache.get("r", c.oid), undefined);
});
