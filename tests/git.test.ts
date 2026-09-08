import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  readFileSync,
  symlinkSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflate } from "pako";
import {
  bytes,
  text,
  concat,
  makeObject,
  readCanonical,
  canonical,
  fromHex,
  sha1,
  ObjectStore,
  Refs,
  ZERO,
  parseTree,
  treeBytes,
  parseCommit,
  LIMITS,
} from "../src/git/objects.ts";
import {
  parsePack,
  writePack,
  inflateMember,
  applyDelta,
} from "../src/git/pack.ts";
import { GitRepository, publishRefs } from "../src/git/repository.ts";
import { receive, upload, advertise } from "../src/git/protocol.ts";
import { pkt, FLUSH, readPackets, band } from "../src/git/pkt.ts";
import { importSnapshot } from "../src/git/legacy.ts";
function git(args: string[], cwd: string, input?: Uint8Array | string) {
  const r = spawnSync("git", args, {
    cwd,
    input,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr.toString()}`);
  return new Uint8Array(r.stdout);
}
function memory() {
  const objects = new Map<string, Uint8Array>(),
    values = new Map<string, unknown>();
  const calls: string[] = [];
  const bucket = {
    async get(k: string) {
      const b = objects.get(k);
      return b
        ? {
            size: b.length,
            arrayBuffer: async () =>
              b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
          }
        : null;
    },
    async put(k: string, b: Uint8Array) {
      calls.push("object");
      if (objects.has(k)) return null;
      objects.set(k, new Uint8Array(b));
      return {};
    },
  };
  const storage = {
    async get<T>(k: string) {
      return values.get(k) as T | undefined;
    },
    async put<T>(k: string, v: T) {
      calls.push("refs");
      values.set(k, structuredClone(v));
    },
  };
  const fresh = async () =>
    new GitRepository(
      new ObjectStore("test", bucket as unknown as R2Bucket),
      storage,
      (await storage.get<Refs>("refs.v2")) || {},
      "main",
    );
  return { bucket, storage, objects, values, calls, fresh };
}
async function initial(f: ReturnType<typeof memory>) {
  return (await f.fresh()).commit({
    branch: "main",
    expected_sha: null,
    message: "Initial",
    files: [{ path: "README.md", content: "# Hello\n" }],
    author: "Test",
    email: "test@example.invalid",
  });
}
async function packEnvelope(entries: Uint8Array[], count = entries.length) {
  const h = new Uint8Array(12);
  h.set(bytes("PACK"));
  const v = new DataView(h.buffer);
  v.setUint32(4, 2);
  v.setUint32(8, count);
  const body = concat(h, ...entries);
  return concat(body, fromHex(await sha1(body)));
}
function objectHeader(type: number, size: number) {
  let b = (type << 4) | (size & 15);
  size = Math.floor(size / 16);
  const out = [];
  if (size) b |= 128;
  out.push(b);
  while (size) {
    let n = size & 127;
    size = Math.floor(size / 128);
    out.push(n | (size ? 128 : 0));
  }
  return Uint8Array.from(out);
}
test("canonical objects and trees match native Git hashes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "os-object-"));
  try {
    const o = await makeObject("blob", bytes("hello\n"));
    assert.equal(
      o.oid,
      text(git(["hash-object", "--stdin"], dir, o.data)).trim(),
    );
    assert.equal(
      (await makeObject("tree", new Uint8Array())).oid,
      "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
    );
    assert.deepEqual((await readCanonical(canonical(o))).data, o.data);
    assert.throws(
      () => parseTree(concat(bytes("100644 ../unsafe\0"), fromHex(o.oid))),
      /Unsafe/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("zlib member boundaries and decompression budgets reject corrupt/oversized input", () => {
  const z = deflate(bytes("hello"));
  const value = inflateMember(concat(z, Uint8Array.of(0xff, 0xff)));
  assert.equal(value.consumed, z.length);
  assert.equal(text(value.data), "hello");
  assert.throws(() => inflateMember(z.subarray(0, -1)), /Truncated/);
  const corrupt = z.slice();
  corrupt[corrupt.length - 1] ^= 1;
  assert.throws(() => inflateMember(corrupt), /Invalid/);
  assert.throws(
    () => inflateMember(deflate(new Uint8Array(1024 * 1024)), 16),
    /exceeds/,
  );
});
test("delta instruction decoder enforces base size, zero op and copy boundaries", () => {
  assert.equal(
    text(applyDelta(bytes("abc"), Uint8Array.of(3, 4, 0x90, 3, 1, 100))),
    "abcd",
  );
  assert.throws(
    () => applyDelta(bytes("abc"), Uint8Array.of(2, 3, 0x90, 3)),
    /base size/,
  );
  assert.throws(
    () => applyDelta(bytes("abc"), Uint8Array.of(3, 3, 0)),
    /insert/,
  );
  assert.throws(
    () => applyDelta(bytes("abc"), Uint8Array.of(3, 2, 0x91, 2, 2)),
    /bounds/,
  );
});
test("pack checksum, size mismatch, truncation, invalid type and trailing data fail closed", async () => {
  const o = await makeObject("blob", bytes("payload")),
    pack = await writePack([o]);
  assert.equal((await parsePack(pack))[0].oid, o.oid);
  const corrupt = pack.slice();
  corrupt[15] ^= 1;
  await assert.rejects(() => parsePack(corrupt), /checksum/);
  await assert.rejects(() => parsePack(pack.subarray(0, -1)), /checksum/);
  await assert.rejects(
    async () =>
      parsePack(
        await packEnvelope([
          concat(objectHeader(3, 1), deflate(bytes("longer"))),
        ]),
      ),
    /exceeds|size/,
  );
  await assert.rejects(
    async () =>
      parsePack(
        await packEnvelope([
          concat(objectHeader(5, 0), deflate(new Uint8Array())),
        ]),
      ),
    /type/,
  );
  await assert.rejects(
    async () =>
      parsePack(
        await packEnvelope([
          concat(objectHeader(3, 1), deflate(bytes("a")), bytes("x")),
        ]),
      ),
    /Trailing/,
  );
});
test("forward REF_DELTA bases resolve, cycles/missing bases and >64-depth chains are rejected", async () => {
  const base = await makeObject("blob", bytes("abc"));
  const delta = Uint8Array.of(3, 4, 0x90, 3, 1, 100);
  const ref = concat(
    objectHeader(7, delta.length),
    fromHex(base.oid),
    deflate(delta),
  );
  const pack = await packEnvelope([
    ref,
    concat(objectHeader(3, 3), deflate(base.data)),
  ]);
  assert.equal(text((await parsePack(pack))[0].data), "abcd");
  await assert.rejects(
    async () => parsePack(await packEnvelope([ref])),
    /Unresolved/,
  );
  let prev = base,
    entries = [concat(objectHeader(3, 3), deflate(base.data))];
  for (let i = 0; i < 65; i++) {
    const next = concat(prev.data, bytes("x"));
    const d = Uint8Array.of(
      prev.data.length,
      next.length,
      0x90,
      prev.data.length,
      1,
      120,
    );
    entries.push(
      concat(objectHeader(7, d.length), fromHex(prev.oid), deflate(d)),
    );
    prev = await makeObject("blob", next);
  }
  await assert.rejects(
    async () => parsePack(await packEnvelope(entries)),
    /chain/,
  );
});
test("native Git OFS_DELTA, REF_DELTA and thin packs round-trip; generated packs pass git index-pack", async () => {
  const dir = mkdtempSync(join(tmpdir(), "os-pack-"));
  try {
    git(["init", "-b", "main"], dir);
    git(["config", "user.name", "Test"], dir);
    git(["config", "user.email", "test@example.invalid"], dir);
    const base = Array.from(
      { length: 1200 },
      (_, i) => `line ${i}: ${"abcdefghij".repeat(10)}`,
    );
    for (let i = 0; i < 12; i++) {
      const rows = [...base];
      rows[i * 37] = "changed revision " + i;
      writeFileSync(join(dir, "large.txt"), rows.join("\n") + "\n");
      git(["add", "."], dir);
      git(["commit", "-m", "Revision " + i], dir);
    }
    symlinkSync("large.txt", join(dir, "link"));
    writeFileSync(join(dir, "run.sh"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(dir, "run.sh"), 0o755);
    git(["add", "."], dir);
    git(["commit", "-m", "Modes"], dir);
    git(["tag", "-a", "v1", "-m", "Release"], dir);
    const expected = text(git(["rev-list", "--objects", "--all"], dir))
      .trim()
      .split("\n")
      .map((l) => l.split(" ")[0])
      .sort();
    for (const option of [[], ["--delta-base-offset"]]) {
      const native = git(["pack-objects", "--all", "--stdout", ...option], dir);
      const objects = await parsePack(native);
      assert.deepEqual(objects.map((o) => o.oid).sort(), expected);
      const generated = await writePack(objects);
      git(["index-pack", "--strict", "--stdin"], dir, generated);
    }
    const tip = text(git(["rev-parse", "main~1"], dir)).trim(),
      parent = text(git(["rev-parse", "main~2"], dir)).trim();
    const thin = git(
      ["pack-objects", "--thin", "--stdout", "--revs"],
      dir,
      `${tip}\n^${parent}\n`,
    );
    let loads = 0;
    const parsed = await parsePack(thin, async (oid) => {
      loads++;
      const type = text(git(["cat-file", "-t", oid], dir)).trim() as
        "blob" | "commit" | "tree" | "tag";
      return makeObject(type, git(["cat-file", type, oid], dir));
    });
    assert.ok(loads > 0, "fixture must contain an external delta base");
    assert.ok(parsed.some((o) => o.oid === tip));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("R2 failure cannot advance refs; failed ref commit leaves only unreachable immutable objects", async () => {
  const f = memory();
  const { sha } = await initial(f);
  const old = await f.storage.get<Refs>("refs.v2");
  const repo = await f.fresh();
  const original = f.bucket.put;
  f.bucket.put = async () => {
    throw Error("R2 failed");
  };
  await assert.rejects(
    () =>
      repo.commit({
        branch: "main",
        expected_sha: sha,
        message: "Fail",
        files: [{ path: "README.md", content: "new" }],
        author: "Test",
        email: "x",
      }),
    /R2 failed/,
  );
  assert.deepEqual(await f.storage.get("refs.v2"), old);
  f.bucket.put = original;
  const originalPut = f.storage.put;
  f.storage.put = async () => {
    throw Error("DO failed");
  };
  const retry = await f.fresh();
  await assert.rejects(
    () =>
      retry.commit({
        branch: "main",
        expected_sha: sha,
        message: "Fail2",
        files: [{ path: "README.md", content: "new2" }],
        author: "Test",
        email: "x",
      }),
    /DO failed/,
  );
  f.storage.put = originalPut;
  assert.deepEqual(await f.storage.get("refs.v2"), old);
  assert.equal(
    (await (await f.fresh()).blob("HEAD", "README.md")).content,
    "# Hello\n",
  );
});
test("ref updates are all-or-nothing and graph connectivity is validated", async () => {
  const f = memory(),
    { sha } = await initial(f),
    repo = await f.fresh();
  await assert.rejects(
    () =>
      repo.updates([
        { old: ZERO, next: sha, ref: "refs/heads/good" },
        { old: "1".repeat(40), next: sha, ref: "refs/heads/main" },
      ]),
    /concurrently/,
  );
  assert.equal(
    (await f.storage.get<Refs>("refs.v2"))!["refs/heads/good"],
    undefined,
  );
  const bad = await repo.store.create(
    "commit",
    bytes(
      `tree ${"1".repeat(40)}\nauthor Test <x> 1 +0000\ncommitter Test <x> 1 +0000\n\nbad\n`,
    ),
  );
  await assert.rejects(
    () => repo.updates([{ old: ZERO, next: bad.oid, ref: "refs/heads/bad" }]),
    /Missing Git object/,
  );
  await assert.rejects(
    () => repo.updates([{ old: sha, next: ZERO, ref: "refs/heads/main" }]),
    /default branch/,
  );
});
test("unreachable and cross-repository wants are rejected", async () => {
  const f = memory(),
    { sha } = await initial(f);
  const repo = await f.fresh();
  const orphan = await repo.store.create("blob", bytes("orphan"));
  await repo.store.flush();
  await assert.rejects(() => repo.validateFetch([orphan.oid]), /not reachable/);
  await assert.rejects(
    () => new ObjectStore("other", f.bucket as unknown as R2Bucket).get(sha),
    /Missing/,
  );
});
test("pkt-line framing rejects malformed lengths and push reports failures to native clients", async () => {
  assert.throws(() => readPackets(bytes("0003")), /length/);
  assert.throws(() => readPackets(bytes("0008abc")), /Truncated/);
  const f = memory(),
    { sha } = await initial(f);
  const response = await receive(
    await f.fresh(),
    concat(
      pkt(`${"1".repeat(40)} ${sha} refs/heads/main\0report-status atomic\n`),
      FLUSH,
    ),
  );
  const body = new Uint8Array(await response.arrayBuffer());
  assert.match(text(body), /ng refs\/heads\/main Reference changed/);
  assert.equal((await f.storage.get<Refs>("refs.v2"))!["refs/heads/main"], sha);
});
test("legacy tar snapshot migrates entirely in JS and retains native Git object IDs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "os-legacy-"));
  try {
    git(["init", "-b", "main"], dir);
    git(["config", "user.name", "Test"], dir);
    git(["config", "user.email", "test@example.invalid"], dir);
    writeFileSync(join(dir, "README.md"), "legacy\n");
    git(["add", "."], dir);
    git(["commit", "-m", "Legacy"], dir);
    git(["gc", "--prune=now"], dir);
    writeFileSync(
      join(dir, ".git/refs/heads/._main"),
      Uint8Array.of(0, 5, 22, 7, 0, 0, 0, 0),
    );
    const sha = text(git(["rev-parse", "HEAD"], dir)).trim();
    const tar = spawnSync(
      "tar",
      [
        "-cf",
        "-",
        "-C",
        join(dir, ".git"),
        "./HEAD",
        "./objects",
        "./refs",
        "./packed-refs",
      ],
      { maxBuffer: 32 * 1024 * 1024 },
    );
    assert.equal(tar.status, 0);
    const f = memory(),
      store = new ObjectStore("test", f.bucket as unknown as R2Bucket);
    const refs = await importSnapshot(
      new Uint8Array(tar.stdout),
      store,
      f.storage,
    );
    assert.equal(refs["refs/heads/main"], sha);
    assert.equal(
      (await (await f.fresh()).blob("HEAD", "README.md")).content,
      "legacy\n",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
import { randomBytes } from "node:crypto";
test("multi-chunk incompressible objects preserve exact bytes and zlib boundaries", async () => {
  const data = new Uint8Array(randomBytes(768 * 1024)),
    o = await makeObject("blob", data);
  const pack = await writePack([o, await makeObject("blob", bytes("next"))]);
  const parsed = await parsePack(pack);
  assert.deepEqual(parsed[0].data, data);
  assert.equal(text(parsed[1].data), "next");
});
test("Git HTTP authentication probe accepts a flush-only receive without modifying refs", async () => {
  const f = memory();
  await initial(f);
  const before = await f.storage.get("refs.v2");
  const r = await receive(await f.fresh(), FLUSH);
  assert.equal(r.status, 200);
  assert.equal((await r.arrayBuffer()).byteLength, 0);
  assert.deepEqual(await f.storage.get("refs.v2"), before);
});

test("immutable R2 objects cannot be silently replaced under the same object ID", async () => {
  const f = memory(),
    store = new ObjectStore("test", f.bucket as unknown as R2Bucket);
  const o = await store.create("blob", bytes("original"));
  await store.flush();
  await store.flush();
  f.objects.set(
    `repos/test/objects/${o.oid}`,
    canonical({ ...o, data: bytes("conflict") }),
  );
  store.add(o);
  await assert.rejects(() => store.flush(), /Conflicting stored/);
  assert.throws(
    () => store.add({ ...o, data: bytes("conflict") }),
    /Conflicting (content|staged)/,
  );
});
test("unsorted trees and duplicate commit headers are rejected before publication", async () => {
  const o = await makeObject("blob", bytes("x"));
  assert.throws(
    () =>
      parseTree(
        concat(
          bytes("100644 z\0"),
          fromHex(o.oid),
          bytes("100644 a\0"),
          fromHex(o.oid),
        ),
      ),
    /Unsorted/,
  );
  const c = await makeObject(
    "commit",
    bytes(
      `tree ${o.oid}\nauthor Test <x> 1 +0000\nauthor Other <x> 1 +0000\ncommitter Test <x> 1 +0000\n\nbad`,
    ),
  );
  assert.throws(() => parseCommit(c), /Invalid commit/);
});
test("protocol v2 include-tag emits annotated tags attached to fetched commits", async () => {
  const f = memory(),
    { sha } = await initial(f),
    repo = await f.fresh();
  const tag = await repo.store.create(
    "tag",
    bytes(
      `object ${sha}\ntype commit\ntag v1\ntagger Test <x> 1 +0000\n\nRelease\n`,
    ),
  );
  await repo.updates([{ old: ZERO, next: tag.oid, ref: "refs/tags/v1" }]);
  const response = await upload(
    repo,
    concat(
      pkt("command=fetch\n"),
      bytes("0001"),
      pkt("want " + sha + "\n"),
      pkt("include-tag\n"),
      pkt("done\n"),
      FLUSH,
    ),
  );
  const packets = readPackets(
    new Uint8Array(await response.arrayBuffer()),
  ).packets.filter((p): p is Uint8Array => p instanceof Uint8Array);
  assert.equal(text(packets.shift()!), "packfile\n");
  const pack = concat(
    ...packets.map((p) => {
      assert.equal(p[0], 1);
      return p.subarray(1);
    }),
  );
  assert.ok((await parsePack(pack)).some((o) => o.oid === tag.oid));
});
