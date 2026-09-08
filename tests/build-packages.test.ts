import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { tarHeader } from "../src/git/forge-utils";
import {
  lockPackages,
  normalizePath,
  unpackPackage,
  BuildFileSystem,
} from "../src/build-packages";
import { pipelineSchema } from "../src/ci-config";
import {
  R2PublicPackageCache,
  packageCacheKey,
  NPM_CACHE_TTL,
  type PublicPackageCache,
} from "../src/build-package-cache";

function archive(files: Record<string, string>, type = "0") {
  const chunks: Uint8Array[] = [];
  for (const [p, text] of Object.entries(files)) {
    const b = Buffer.from(text);
    chunks.push(
      tarHeader(p, b.length, 0o644, type),
      b,
      new Uint8Array((512 - (b.length % 512)) % 512),
    );
  }
  return gzipSync(Buffer.concat([...chunks, new Uint8Array(1024)]));
}
const tar = archive({
  "package/package.json": JSON.stringify({
    name: "example",
    version: "1.0.0",
    exports: {
      ".": { import: "./esm.js", require: "./cjs.js" },
      "./feature": "./feature.js",
    },
  }),
  "package/esm.js": "export default 42",
  "package/cjs.js": "module.exports=42",
  "package/feature.js": "export default 1",
});
const entry = {
  version: "1.0.0",
  resolved: "https://registry.npmjs.org/example/-/example-1.0.0.tgz",
  integrity: "sha512-" + createHash("sha512").update(tar).digest("base64"),
};
function files(extra: Record<string, unknown> = {}) {
  const root = { dependencies: { example: "1.0.0" } };
  return {
    "src/main.ts": "import x from 'example'",
    "package.json": JSON.stringify(root),
    "package-lock.json": JSON.stringify({
      lockfileVersion: 3,
      packages: { "": root, "node_modules/example": entry, ...extra },
    }),
  };
}
test("build configuration is Worker-only and validates source/output paths", () => {
  assert.equal(
    pipelineSchema.parse({
      runner: "worker",
      steps: [{ type: "build", entry: "src/main.ts" }],
    }).runner,
    "worker",
  );
  for (const runner of ["external"])
    assert.throws(() =>
      pipelineSchema.parse({
        runner,
        steps: [{ type: "build", entry: "src/main.ts" }],
      }),
    );
  for (const p of [
    "../secret",
    "/etc/passwd",
    "src/../key",
    "node_modules/a.js",
    ".git/config",
  ])
    assert.throws(() =>
      pipelineSchema.parse({
        runner: "worker",
        steps: [{ type: "build", entry: p }],
      }),
    );
});
test("lockfile requires exact root declaration agreement and v2/v3", () => {
  assert.equal(Object.keys(lockPackages(files())).length, 1);
  const f = files();
  f["package.json"] = '{"dependencies":{"example":"^1.0.0"}}';
  assert.throws(() => lockPackages(f), /differ/);
  assert.throws(
    () => lockPackages({ "package.json": f["package.json"] }),
    /require package-lock/,
  );
  assert.throws(
    () => lockPackages({ "package-lock.json": '{"lockfileVersion":1}' }),
    /v2\/v3/,
  );
  assert.deepEqual(lockPackages({}), {});
});
test("lockfile rejects network destinations, non-integrity sources and workspace links", () => {
  for (const resolved of [
    "https://evil.invalid/pkg.tgz",
    "http://registry.npmjs.org/a.tgz",
    "https://x:y@registry.npmjs.org/a.tgz",
    "https://registry.npmjs.org/a.tgz?token=x",
    "file:///tmp/pkg.tgz",
  ])
    assert.throws(() =>
      lockPackages(files({ "node_modules/example": { ...entry, resolved } })),
    );
  for (const override of [
    { integrity: "sha1-no" },
    { version: "latest" },
    { link: true },
  ])
    assert.throws(() =>
      lockPackages(
        files({ "node_modules/example": { ...entry, ...override } }),
      ),
    );
  for (const path of [
    "packages/local",
    "node_modules/..",
    "node_modules/a/node_modules/../x",
  ])
    assert.throws(() => lockPackages(files({ [path]: entry })));
});
test("bounded npm tar parser rejects traversal, links, malformed checksum and gzip bombs", () => {
  assert.match(unpackPackage(tar).files["esm.js"], /42/);
  for (const path of [
    "package/../x.js",
    "package/.git/config",
    "package/a\\b.js",
    "package//a.js",
    "outside/a.js",
  ])
    assert.throws(() => unpackPackage(archive({ [path]: "x" })), /path/);
  for (const type of ["1", "2", "3", "x"])
    assert.throws(
      () => unpackPackage(archive({ "package/a.js": "x" }, type)),
      /unsupported/,
    );
  assert.throws(() => unpackPackage(tar, 1024), /expanded/);
  assert.throws(() => unpackPackage(tar.subarray(0, 30)), /gzip/);
  const corrupt = Buffer.concat([
    tarHeader("package/a.js", 1, 0o644),
    Buffer.alloc(1536),
  ]);
  corrupt[1] ^= 1;
  assert.throws(() => unpackPackage(gzipSync(corrupt)), /checksum/);
});
test("locked resolver loads each package once, applies exports and honors nested versions", async () => {
  let fetched = 0;
  const fs = new BuildFileSystem(
    files({ "node_modules/parent/node_modules/example": entry }),
    "browser",
    (async () => {
      fetched++;
      return new Response(tar);
    }) as typeof fetch,
  );
  assert.equal(await fs.resolve("./main", "src/other.ts"), "src/main.ts");
  assert.deepEqual(
    await Promise.all([
      fs.resolve("example", "src/main.ts"),
      fs.resolve("example/feature", "src/main.ts"),
    ]),
    ["node_modules/example/esm.js", "node_modules/example/feature.js"],
  );
  assert.equal(fetched, 1);
  assert.equal(
    await fs.resolve("example", "src/main.ts", true),
    "node_modules/example/cjs.js",
  );
  assert.equal(
    await fs.resolve("example", "node_modules/parent/lib.js"),
    "node_modules/parent/node_modules/example/esm.js",
  );
  assert.equal(fetched, 2);
  await assert.rejects(fs.resolve("example/private", "src/main.ts"));
  for (const name of [
    "missing",
    "node:fs",
    "https://evil.invalid/a.js",
    "../../private",
  ])
    await assert.rejects(fs.resolve(name, "src/main.ts"));
});
test("integrity, redirects and version mismatches fail before compilation", async () => {
  const mismatch = files({
    "node_modules/example": {
      ...entry,
      integrity: "sha512-" + "A".repeat(86) + "==",
    },
  });
  await assert.rejects(
    new BuildFileSystem(
      mismatch,
      "worker",
      (async () => new Response(tar)) as typeof fetch,
    ).resolve("example", "src/main.ts"),
    /integrity/,
  );
  await assert.rejects(
    new BuildFileSystem(
      files(),
      "worker",
      (async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1" },
        })) as typeof fetch,
    ).resolve("example", "src/main.ts"),
    /download/,
  );
  await assert.rejects(
    new BuildFileSystem(
      files({ "node_modules/example": { ...entry, version: "2.0.0" } }),
      "worker",
      (async () => new Response(tar)) as typeof fetch,
    ).resolve("example", "src/main.ts"),
    /version mismatch/,
  );
});
test("virtual source normalization stays inside the project", () => {
  assert.equal(normalizePath("src/a/../b.ts"), "src/b.ts");
  for (const p of ["../x", "a/../../x", "/x", "a\\x", "a\0x"])
    assert.throws(() => normalizePath(p));
});

test("public package cache survives fresh compiler instances and verifies every hit", async () => {
  const data = new Map<string, Uint8Array>();
  let downloads = 0;
  const cache: PublicPackageCache = {
    async get(url, integrity) {
      const b = data.get(await packageCacheKey(url, integrity));
      return b ? new Response(new Uint8Array(b)) : null;
    },
    async put(url, integrity, bytes) {
      data.set(await packageCacheKey(url, integrity), bytes.slice());
    },
  };
  const create = () =>
    new BuildFileSystem(
      files(),
      "worker",
      (async () => {
        downloads++;
        return new Response(tar);
      }) as typeof fetch,
      undefined,
      {},
      cache,
    );
  const cold = create();
  await cold.resolve("example", "src/main.ts");
  assert.equal(cold.cacheStats.misses, 1);
  assert.equal(cold.cacheStats.writes, 1);
  const warm = create();
  await warm.resolve("example", "src/main.ts");
  assert.equal(downloads, 1);
  assert.equal(warm.cacheStats.hits, 1);
  assert.equal(warm.cacheStats.downloaded_bytes, 0);
  assert.equal(warm.compressed, tar.length);
  assert.equal(
    warm.files["node_modules/example/esm.js"],
    cold.files["node_modules/example/esm.js"],
  );
  data.set(
    await packageCacheKey(entry.resolved, entry.integrity),
    new Uint8Array([1, 2]),
  );
  const corrupt = create();
  await corrupt.resolve("example", "src/main.ts");
  assert.equal(downloads, 2);
  assert.equal(corrupt.cacheStats.errors, 1);
  assert.equal(corrupt.cacheStats.writes, 1);
  assert.equal(corrupt.compressed, tar.length);
});

test("cache outages fall back, invalid registry bytes are never cached, and private packages bypass cache", async () => {
  const broken: PublicPackageCache = {
    async get() {
      throw Error("unavailable");
    },
    async put() {
      throw Error("unavailable");
    },
  };
  const fs = new BuildFileSystem(
    files(),
    "worker",
    (async () => new Response(tar)) as typeof fetch,
    undefined,
    {},
    broken,
  );
  await fs.resolve("example", "src/main.ts");
  assert.equal(fs.cacheStats.errors, 2);
  let reads = 0,
    writes = 0;
  const cache: PublicPackageCache = {
    async get() {
      reads++;
      return null;
    },
    async put() {
      writes++;
    },
  };
  const bad = new BuildFileSystem(
    files(),
    "worker",
    (async () => new Response("tampered")) as typeof fetch,
    undefined,
    {},
    cache,
  );
  await assert.rejects(bad.resolve("example", "src/main.ts"), /integrity/);
  assert.equal(writes, 0);
  const privateURL = "https://git.1s.hk/api/packages/private/pkg.tgz";
  const privateFS = new BuildFileSystem(
    files({ "node_modules/example": { ...entry, resolved: privateURL } }),
    "worker",
    (async () => {
      throw Error("must not fetch");
    }) as typeof fetch,
    undefined,
    { [privateURL]: Buffer.from(tar).toString("base64") },
    cache,
  );
  await privateFS.resolve("example", "src/main.ts");
  assert.equal(reads, 1);
  assert.equal(writes, 0);
  assert.equal(privateFS.cacheStats.hits, 0);
  assert.equal(privateFS.cacheStats.downloaded_bytes, 0);
});

test("cached bytes still count toward limits and cancellation interrupts cached body reads", async () => {
  const cache: PublicPackageCache = {
    async get() {
      return new Response(tar);
    },
    async put() {},
  };
  const fs = new BuildFileSystem(
    files(),
    "worker",
    (async () => new Response(tar)) as typeof fetch,
    undefined,
    {},
    cache,
  );
  fs.compressed = 4 * 1024 * 1024;
  await assert.rejects(fs.resolve("example", "src/main.ts"), /compressed/);
  let canceled = false,
    downloads = 0;
  const controller = new AbortController();
  const blocked: PublicPackageCache = {
    async get() {
      return new Response(
        new ReadableStream({
          cancel() {
            canceled = true;
          },
        }),
      );
    },
    async put() {},
  };
  const active = new BuildFileSystem(
    files(),
    "worker",
    (async () => {
      downloads++;
      return new Response(tar);
    }) as typeof fetch,
    controller.signal,
    {},
    blocked,
  );
  const pending = active.resolve("example", "src/main.ts");
  await new Promise((r) => setTimeout(r, 20));
  controller.abort();
  await assert.rejects(pending, /abort/i);
  assert.equal(canceled, true);
  assert.equal(downloads, 0);
});

test("R2 cache identity, expiry and bounded unavailable operations protect reusable public content", async () => {
  assert.notEqual(
    await packageCacheKey(entry.resolved, entry.integrity),
    await packageCacheKey(entry.resolved, "sha512-" + "A".repeat(86) + "=="),
  );
  await assert.rejects(
    packageCacheKey("https://private.invalid/pkg.tgz", entry.integrity),
  );
  let now = 1000,
    stored: any,
    canceled = 0;
  const bucket = {
    async put(key: string, bytes: Uint8Array, options: any) {
      stored = { key, bytes, ...options };
    },
    async get() {
      return stored
        ? {
            ...stored,
            size: stored.bytes.length,
            body: new ReadableStream({
              start(c) {
                c.enqueue(stored.bytes);
              },
              cancel() {
                canceled++;
              },
            }),
          }
        : null;
    },
  } as unknown as R2Bucket;
  const cache = new R2PublicPackageCache(bucket, () => now);
  assert.equal(await cache.get(entry.resolved, entry.integrity), null);
  await cache.put(entry.resolved, entry.integrity, tar);
  const hit = await cache.get(entry.resolved, entry.integrity);
  assert.ok(hit);
  await hit.body!.cancel();
  now += NPM_CACHE_TTL;
  assert.equal(await cache.get(entry.resolved, entry.integrity), null);
  assert.equal(canceled, 2);
  const unavailable = new R2PublicPackageCache(
    {
      get() {
        return new Promise(() => {});
      },
      put() {
        return new Promise(() => {});
      },
    } as unknown as R2Bucket,
    Date.now,
    10,
  );
  await assert.rejects(
    unavailable.get(entry.resolved, entry.integrity),
    /timeout/,
  );
  await assert.rejects(
    unavailable.put(entry.resolved, entry.integrity, tar),
    /timeout/,
  );
});
