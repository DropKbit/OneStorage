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
