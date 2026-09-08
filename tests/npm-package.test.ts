import { Buffer } from "node:buffer";
import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { npmManifest, parseNpmPublish } from "../src/npm-package";
function tar(
  entries: { path: string; body: string | Buffer; kind?: string }[],
) {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.body),
      h = Buffer.alloc(512);
    h.write(entry.path, 0, 100);
    h.write("0000644\0", 100);
    h.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
    h[156] = (entry.kind || "0").charCodeAt(0);
    h.fill(32, 148, 156);
    h.write(
      h
        .reduce((n: number, b: number) => n + b, 0)
        .toString(8)
        .padStart(6, "0") + "\0 ",
      148,
    );
    parts.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return Buffer.concat([...parts, Buffer.alloc(1024)]);
}
const manifest = {
  name: "@team/demo",
  version: "1.0.0",
  dependencies: { foo: "^1.0.0" },
  exports: { ".": "./index.js" },
};
const entry = { path: "package/package.json", body: JSON.stringify(manifest) };
function publication(
  bytes: Buffer,
  name = manifest.name,
  version = manifest.version,
) {
  return {
    name,
    "dist-tags": { latest: version },
    versions: {
      [version]: {
        name,
        version,
        dist: {
          integrity:
            "sha512-" + createHash("sha512").update(bytes).digest("base64"),
          shasum: createHash("sha1").update(bytes).digest("hex"),
          tarball: "http://untrusted.invalid/never-fetch",
        },
        dependencies: { injected: "*" },
      },
    },
    _attachments: {
      [`${name}-${version}.tgz`]: {
        data: Buffer.from(bytes).toString("base64"),
        length: bytes.length,
      },
    },
  };
}
test("npm publish derives authoritative metadata from tarball, supports scoped packages, binary and bundled files, and computes immutable hashes", async () => {
  const bytes = gzipSync(
    tar([
      entry,
      {
        path: "package/node_modules/foo/binary.node",
        body: Buffer.from([0, 255, 1]),
      },
    ]),
  );
  const { spec } = await parseNpmPublish(manifest.name, publication(bytes));
  assert.equal(spec.filename, "demo-1.0.0.tgz");
  assert.deepEqual(spec.metadata, manifest);
  assert.equal(spec.sha256, createHash("sha256").update(bytes).digest("hex"));
});
test("npm tar reader handles PAX and GNU long names without retaining file payloads", () => {
  const path = "package/" + "a".repeat(200),
    pair = "path=" + path + "\n";
  let length = pair.length + 2;
  while (String(length).length + 1 + pair.length !== length)
    length = String(length).length + 1 + pair.length;
  for (const extension of [
    { path: "PaxHeader", kind: "x", body: `${length} ${pair}` },
    { path: "././@LongLink", kind: "L", body: path + "\0" },
  ]) {
    assert.deepEqual(
      npmManifest(
        gzipSync(
          tar([
            entry,
            extension,
            { path: "short", body: Buffer.alloc(1024 * 1024, 42) },
          ]),
        ),
      ),
      manifest,
    );
  }
});
test("npm parser rejects traversal, duplicates, links, missing and ambiguous manifests, corruption and truncated gzip/tar", () => {
  const cases = [
    tar([entry, { path: "package/../escape", body: "x" }]),
    tar([entry, entry]),
    tar([entry, { path: "package/link", body: "", kind: "2" }]),
    tar([{ path: "package/no.json", body: "{}" }]),
    tar([{ ...entry, body: "null" }]),
    tar([entry]).subarray(0, 600),
    Buffer.from(tar([entry])),
  ];
  cases.at(-1)![0] ^= 1;
  for (const bytes of cases) assert.throws(() => npmManifest(gzipSync(bytes)));
  const compressed = gzipSync(tar([entry]));
  assert.throws(() =>
    npmManifest(compressed.subarray(0, compressed.length - 2)),
  );
  compressed[compressed.length - 5] ^= 1;
  assert.throws(() => npmManifest(compressed));
});
test("npm expanded-data limit rejects compression bombs while allowing normal package files", () => {
  assert.throws(() =>
    npmManifest(
      gzipSync(
        tar([
          entry,
          { path: "package/huge", body: Buffer.alloc(65 * 1024 * 1024) },
        ]),
      ),
    ),
  );
});
test("npm publication rejects mismatched identities, attachments, lengths, integrity, tags and private manifests", async () => {
  const bytes = gzipSync(tar([entry]));
  for (const mutate of [
    (b: any) => (b.versions["1.0.0"].name = "other"),
    (b: any) => b._attachments["@team/demo-1.0.0.tgz"].length++,
    (b: any) => (b._attachments["@team/demo-1.0.0.tgz"].data = "==!!"),
    (b: any) => (b.versions["1.0.0"].dist.integrity = "sha512-nope"),
    (b: any) => (b["dist-tags"] = { latest: "2.0.0" }),
    (b: any) => (b["dist-tags"] = { v1: "1.0.0" }),
    (b: any) => (b._attachments.extra = {}),
  ]) {
    const b = publication(bytes);
    mutate(b);
    await assert.rejects(parseNpmPublish(manifest.name, b));
  }
  for (const replacement of [
    { ...manifest, version: "2.0.0" },
    { ...manifest, private: true },
  ]) {
    const b = gzipSync(tar([{ ...entry, body: JSON.stringify(replacement) }]));
    await assert.rejects(parseNpmPublish(manifest.name, publication(b)));
  }
});
