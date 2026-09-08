import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  renameSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { generateKey, readPrivateKey, createMessage, sign } from "openpgp";
import {
  ObjectStore,
  Refs,
  bytes,
  text,
  ZERO,
  makeObject,
  checkRefs,
  concat,
} from "../src/git/objects";
import { namespaceRepositories, EPHEMERAL } from "../src/git/namespaces";
import { WritePolicy } from "../src/git/policy";
import { parsePack, writePack } from "../src/git/pack";
import { applyGitPatch } from "../src/git/patch";
import {
  base64,
  signingKeyInfo,
  verifyCommitSignature,
  commitSignature,
} from "../src/git/signatures";
import { parseCommitStream } from "../src/git/commit-stream";
import { normalizePolicies, refOperations } from "../src/delegation";
function memory(policy: WritePolicy = { rules: [] }) {
  const objects = new Map<string, Uint8Array>(),
    values = new Map<string, any>();
  const bucket = {
    async get(k: string) {
      const b = objects.get(k);
      return b
        ? {
            size: b.length,
            arrayBuffer: async () =>
              b.buffer.slice(b.byteOffset, b.byteOffset + b.length),
          }
        : null;
    },
    async put(k: string, b: Uint8Array) {
      if (objects.has(k)) return null;
      objects.set(k, b.slice());
      return {};
    },
  };
  const storage = {
    async get<T>(k: string) {
      return values.get(k) as T;
    },
    async put<T>(k: string, v: T) {
      values.set(k, structuredClone(v));
    },
  };
  const fresh = () =>
    namespaceRepositories(
      new ObjectStore("test", bucket as any),
      storage,
      values.get("refs.v2") || {},
      "main",
      policy,
    );
  return { objects, values, storage, bucket, fresh };
}
const author = { name: "Test", email: "test@example.invalid" };
async function initial(
  f: ReturnType<typeof memory>,
  content = "one\ntwo\nthree\n",
) {
  return f
    .fresh()()
    .commitFiles({
      target_branch: "main",
      expected_target_sha: null,
      commit_message: "Initial",
      author,
      files: [{ path: "README.md", content }],
    });
}
function git(args: string[], cwd: string, input?: Uint8Array) {
  return execFileSync("git", args, {
    cwd,
    input,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
    maxBuffer: 64 * 1024 * 1024,
  });
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "onestorage-forge-"));
  git(["init", "-b", "main"], dir);
  git(["config", "user.name", "Test"], dir);
  git(["config", "user.email", author.email], dir);
  return dir;
}
test("namespace refs isolate same-named branches, support promotion and protect all path prefixes", async () => {
  const f = memory(),
    a = await initial(f);
  await f
    .fresh()(true)
    .commitFiles({
      target_branch: "main",
      base_branch: "main",
      commit_message: "Experiment",
      author,
      files: [{ path: "scratch", content: "yes" }],
    });
  assert.equal(f.values.get("refs.v2")["refs/heads/main"], a.sha);
  assert.ok(f.values.get("refs.v2")[EPHEMERAL + "refs/heads/main"]);
  const normal = f.fresh()();
  assert.equal(normal.listBranches().branches.length, 1);
  await normal.createBranch({
    target_branch: "promoted",
    base_ref: "main",
    base_is_ephemeral: true,
  });
  assert.equal((await f.fresh()().blob("promoted", "scratch")).content, "yes");
  await f.fresh()(true).deleteBranch("main");
  assert.ok(f.values.get("refs.v2")["refs/heads/main"]);
  assert.throws(
    () =>
      checkRefs({
        "refs/heads/a": a.sha,
        "refs/heads/a.b": a.sha,
        "refs/heads/a/c": a.sha,
      }),
    /Conflicting/,
  );
  await assert.rejects(
    () =>
      f
        .fresh()()
        .updates([
          { ref: EPHEMERAL + "refs/heads/bypass", old: ZERO, next: a.sha },
        ]),
    /Invalid/,
  );
});
test("ordered ref policy is enforced for API commits, notes and namespaced writes", async () => {
  const rules = normalizePolicies([
    ["agents/*", []],
    ["*", ["no-push"]],
  ]);
  assert.deepEqual(refOperations("refs/heads/agents/a", rules), []);
  assert.deepEqual(refOperations("refs/heads/main", rules), ["no-push"]);
  const f = memory();
  const a = await initial(f);
  const restricted = namespaceRepositories(
    new ObjectStore("test", f.bucket as any),
    f.storage,
    f.values.get("refs.v2"),
    "main",
    { rules },
  );
  await assert.rejects(
    () =>
      restricted().commitFiles({
        target_branch: "main",
        expected_target_sha: a.sha,
        commit_message: "Denied",
        author,
        files: [{ path: "x", content: "x" }],
      }),
    /policy forbids/,
  );
  await restricted().createBranch({
    target_branch: "agents/a",
    base_ref: "main",
  });
  await assert.rejects(
    () =>
      restricted(true).createBranch({
        target_branch: "agents/a",
        base_ref: "main",
      }),
    /policy forbids/,
  );
  assert.equal(f.values.get("refs.v2")["refs/heads/main"], a.sha);
});
test("Git notes create, append, delete and native git notes compatibility", async () => {
  const f = memory(),
    a = await initial(f),
    repo = f.fresh()();
  await repo.writeNote({ sha: a.sha, note: "reviewed", author });
  await assert.rejects(
    () => repo.writeNote({ sha: a.sha, note: "again", author }),
    /already exists/,
  );
  await repo.writeNote({
    sha: a.sha,
    note: "approved",
    operation: "append",
    author,
  });
  assert.equal((await repo.getNote(a.sha)).note, "reviewed\n\napproved\n");
  const dir = fixture();
  try {
    const all = await repo.store.walk(Object.values(repo.refs)),
      pack = await writePack(
        await Promise.all([...all].map((id) => repo.store.get(id))),
      );
    git(["index-pack", "--strict", "--stdin"], dir, pack);
    for (const [ref, sha] of Object.entries(repo.refs))
      git(["update-ref", ref, sha], dir);
    assert.equal(
      text(git(["notes", "show", a.sha], dir)),
      "reviewed\n\napproved\n",
    );
    await repo.writeNote({ sha: a.sha, operation: "delete", author });
    await assert.rejects(() => repo.getNote(a.sha), /not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("streamed binary commits require EOF and preserve exact data and mode", async () => {
  const f = memory(),
    repo = f.fresh()(),
    payload = new Uint8Array(randomBytes(40000));
  const meta = {
    target_branch: "main",
    commit_message: "Stream",
    author,
    files: [
      {
        path: "data.bin",
        operation: "upsert",
        content_id: "1",
        mode: "100755",
      },
    ],
  };
  const source =
    JSON.stringify({ metadata: meta }) +
    "\n" +
    JSON.stringify({
      blob_chunk: { content_id: "1", data: base64(payload), eof: true },
    }) +
    "\n";
  const parsed = await parseCommitStream(
    new Request("http://test", { method: "POST", body: source }),
    repo.store,
    "files",
  );
  await repo.commitFiles(parsed.metadata);
  const e = (await repo.entry("main", "data.bin")).entry;
  assert.equal(e.mode, "100755");
  assert.deepEqual((await repo.store.get(e.sha)).data, payload);
  const before = structuredClone(f.values.get("refs.v2"));
  await assert.rejects(
    () =>
      parseCommitStream(
        new Request("http://test", {
          method: "POST",
          body: source.replace('"eof":true', '"eof":false'),
        }),
        repo.store,
        "files",
      ),
    /EOF/,
  );
  assert.deepEqual(f.values.get("refs.v2"), before);
});
test("native Git binary/text/rename patches produce the identical native tree", async () => {
  const dir = fixture();
  try {
    writeFileSync(join(dir, "README.md"), "hello\nworld\n");
    writeFileSync(join(dir, "old.txt"), "rename me\n");
    writeFileSync(join(dir, "random.bin"), randomBytes(30000));
    git(["add", "."], dir);
    git(["commit", "-m", "Initial"], dir);
    const sha = text(git(["rev-parse", "HEAD"], dir)).trim(),
      f = memory(),
      repo = f.fresh()();
    for (const o of await parsePack(
      git(["pack-objects", "--stdout", "--all"], dir),
    ))
      repo.store.add(o);
    await repo.updates([{ ref: "refs/heads/main", old: ZERO, next: sha }]);
    writeFileSync(join(dir, "README.md"), "hello\nchanged\nworld\n");
    renameSync(join(dir, "old.txt"), join(dir, "new.txt"));
    writeFileSync(join(dir, "random.bin"), randomBytes(35000));
    writeFileSync(join(dir, "added"), "new\n");
    git(["add", "-A"], dir);
    const patch = git(["diff", "--cached", "--binary", "-M"], dir),
      tree = text(git(["write-tree"], dir)).trim();
    const result = await applyGitPatch(
      repo,
      {
        target_branch: "main",
        expected_target_sha: sha,
        commit_message: "Apply patch",
        author,
      },
      patch,
    );
    assert.equal(result.tree_sha, tree);
    const roots = await repo.store.walk([result.sha]);
    git(
      ["index-pack", "--strict", "--stdin"],
      dir,
      await writePack(
        await Promise.all([...roots].map((id) => repo.store.get(id))),
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("three-way merge previews are read-only; disjoint edits merge and overlaps conflict", async () => {
  const f = memory(),
    base = await initial(f);
  await f
    .fresh()()
    .createBranch({ target_branch: "feature", base_ref: "main" });
  await f
    .fresh()()
    .commitFiles({
      target_branch: "main",
      expected_target_sha: base.sha,
      commit_message: "Ours",
      author,
      files: [{ path: "README.md", content: "ONE\ntwo\nthree\n" }],
    });
  await f
    .fresh()()
    .commitFiles({
      target_branch: "feature",
      expected_target_sha: base.sha,
      commit_message: "Theirs",
      author,
      files: [{ path: "README.md", content: "one\ntwo\nTHREE\n" }],
    });
  const before = structuredClone(f.values.get("refs.v2")),
    count = f.objects.size;
  const preview = await f.fresh()().previewMerge({
    source_ref: "feature",
    target_branch: "main",
    include_content: true,
  });
  assert.equal(preview.status, "clean");
  assert.deepEqual(f.values.get("refs.v2"), before);
  assert.equal(f.objects.size, count);
  const merged = await f.fresh()().mergeBranches({
    source_ref: "feature",
    target_branch: "main",
    strategy: "merge",
    commit_message: "Merge",
    author,
  });
  assert.equal(
    (await f.fresh()().blob("main", "README.md")).content,
    "ONE\ntwo\nTHREE\n",
  );
  assert.equal((await f.fresh()().metadata(merged.sha)).parent_shas.length, 2);
  await f
    .fresh()()
    .commitFiles({
      target_branch: "feature",
      commit_message: "Conflict",
      author,
      files: [{ path: "README.md", content: "one\nOTHER\nTHREE\n" }],
    });
  await f
    .fresh()()
    .commitFiles({
      target_branch: "main",
      commit_message: "Conflict2",
      author,
      files: [{ path: "README.md", content: "ONE\nDIFFERENT\nTHREE\n" }],
    });
  assert.equal(
    (
      await f
        .fresh()()
        .previewMerge({ source_ref: "feature", target_branch: "main" })
    ).status,
    "conflicted",
  );
  await assert.rejects(
    () =>
      f.fresh()().mergeBranches({
        source_ref: "feature",
        target_branch: "main",
        strategy: "merge",
        commit_message: "Fail",
        author,
      }),
    /conflicts/,
  );
});
test("raw file supports HEAD, byte ranges and cache validators", async () => {
  const f = memory();
  await initial(f, "abcdef");
  const repo = f.fresh()(),
    get = await repo.rawFile(new Request("http://test"), "main", "README.md"),
    etag = get.headers.get("etag")!;
  assert.equal(await get.text(), "abcdef");
  const range = await repo.rawFile(
    new Request("http://test", { headers: { Range: "bytes=1-3" } }),
    "main",
    "README.md",
  );
  assert.equal(range.status, 206);
  assert.equal(await range.text(), "bcd");
  const head = await repo.rawFile(
    new Request("http://test", { method: "HEAD" }),
    "main",
    "README.md",
  );
  assert.equal(head.headers.get("content-length"), "6");
  assert.equal(await head.text(), "");
  assert.equal(
    (
      await repo.rawFile(
        new Request("http://test", { headers: { "If-None-Match": etag } }),
        "main",
        "README.md",
      )
    ).status,
    304,
  );
  assert.equal(
    (
      await repo.rawFile(
        new Request("http://test", { headers: { Range: "bytes=99-" } }),
        "main",
        "README.md",
      )
    ).status,
    416,
  );
});
test("filtered streaming archive and RE2 grep work; cursors bind immutable revision", async () => {
  const f = memory();
  await initial(f);
  const repo = f.fresh()();
  await repo.commitFiles({
    target_branch: "main",
    commit_message: "Files",
    author,
    files: [
      {
        path: "src/long-name-" + "x".repeat(130) + ".txt",
        content: "hello42\n",
      },
      { path: "ignore.txt", content: "secret\n" },
    ],
  });
  const archive = await repo.archive({
      ref: "main",
      archive: { prefix: "snapshot/" },
      include_globs: ["src/**"],
    }),
    dir = mkdtempSync(join(tmpdir(), "onestorage-archive-"));
  try {
    const p = join(dir, "snapshot.tar.gz");
    writeFileSync(p, Buffer.from(await archive.arrayBuffer()));
    const names = execFileSync("tar", ["-tzf", p], { encoding: "utf8" });
    assert.match(names, /snapshot\/src\/long-name/);
    assert.ok(!names.includes("ignore"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const matches = await repo.grep({
    query: { pattern: "hello[0-9]+" },
    file_filters: { include_globs: ["src/**"] },
  });
  assert.equal(matches.matches.length, 1);
  assert.equal(matches.matches[0].match, "hello42");
  const page = await repo.listFiles({ ref: "main", limit: 1 });
  assert.ok(page.next_cursor);
  await repo.commitFiles({
    target_branch: "main",
    commit_message: "Advance",
    author,
    files: [{ path: "z", content: "z" }],
  });
  await assert.rejects(
    () => repo.listFiles({ ref: "main", limit: 1, cursor: page.next_cursor! }),
    /different revision/,
  );
});
test("blame and history preserve original line authors, and restore preserves history", async () => {
  const f = memory(),
    a = await initial(f);
  const repo = f.fresh()();
  const b = await repo.commitFiles({
    target_branch: "main",
    commit_message: "Second",
    author: { name: "Second", email: "second@example.invalid" },
    files: [{ path: "README.md", content: "one\nTWO\nthree\n" }],
  });
  const blame = await repo.blame({ path: "README.md" });
  assert.deepEqual(
    blame.lines.map((l) => l.sha),
    [a.sha, b.sha, a.sha],
  );
  const restored = await repo.restore({
    target_branch: "main",
    base_ref: a.sha,
    expected_target_sha: b.sha,
    commit_message: "Restore",
    author,
  });
  assert.equal(
    (await repo.blob("main", "README.md")).content,
    "one\ntwo\nthree\n",
  );
  assert.deepEqual((await repo.metadata(restored.sha)).parent_shas, [b.sha]);
});
test("native SSH signed commits verify; tampering and unregistered keys fail", async () => {
  const dir = fixture();
  try {
    const key = join(dir, "key");
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
    git(["config", "gpg.format", "ssh"], dir);
    git(["config", "user.signingkey", key], dir);
    writeFileSync(join(dir, "README.md"), "signed\n");
    git(["add", "README.md"], dir);
    git(["commit", "-S", "-m", "Signed"], dir);
    const sha = text(git(["rev-parse", "HEAD"], dir)).trim(),
      o = await makeObject(
        "commit",
        new Uint8Array(git(["cat-file", "commit", sha], dir)),
      ),
      public_key = readFileSync(key + ".pub", "utf8");
    assert.equal((await signingKeyInfo(public_key)).format, "ssh");
    assert.equal(
      await verifyCommitSignature(o, [{ format: "ssh", public_key }]),
      true,
    );
    assert.equal(await verifyCommitSignature(o, []), false);
    assert.equal(
      await verifyCommitSignature(
        { ...o, data: concat(o.data, bytes("tampered")) },
        [{ format: "ssh", public_key }],
      ),
      false,
    );
    const sig = commitSignature(o);
    assert.ok(sig.signature?.startsWith("-----BEGIN SSH SIGNATURE-----"));
    assert.ok(!text(sig.payload).includes("gpgsig"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("OpenPGP signed commit verification rejects tampered payloads", async () => {
  const generated = await generateKey({
    type: "ecc",
    curve: "curve25519Legacy",
    userIDs: [author],
    format: "armored",
  });
  const payload = bytes(
    "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nauthor Test <x> 1 +0000\ncommitter Test <x> 1 +0000\n\nmessage\n",
  );
  const signature = await sign({
    message: await createMessage({ binary: payload }),
    signingKeys: await readPrivateKey({ armoredKey: generated.privateKey }),
    detached: true,
    format: "armored",
  });
  const raw = text(payload),
    split = raw.indexOf("\n\n"),
    signed = bytes(
      raw.slice(0, split) +
        "\ngpgsig " +
        signature.trimEnd().split("\n").join("\n ") +
        "\n" +
        raw.slice(split + 1),
    );
  const o = await makeObject("commit", signed),
    keys = [{ format: "openpgp", public_key: generated.publicKey }];
  assert.equal(await verifyCommitSignature(o, keys), true);
  assert.equal(
    await verifyCommitSignature(
      { ...o, data: concat(o.data, bytes("bad")) },
      keys,
    ),
    false,
  );
});
test("rename/edit merge follows the renamed path", async () => {
  const f = memory(),
    base = await initial(f, "first line\nsecond line\nthird line\n");
  await f
    .fresh()()
    .createBranch({ target_branch: "feature", base_ref: base.sha });
  await f
    .fresh()()
    .commitFiles({
      target_branch: "feature",
      commit_message: "Rename",
      author,
      files: [
        { path: "README.md", operation: "delete" },
        {
          path: "renamed.md",
          content: "first line\nsecond line\nthird line\n",
        },
      ],
    });
  await f
    .fresh()()
    .commitFiles({
      target_branch: "main",
      commit_message: "Edit",
      author,
      files: [
        {
          path: "README.md",
          content: "first line\nchanged second line\nthird line\n",
        },
      ],
    });
  const p = await f
    .fresh()()
    .previewMerge({ source_ref: "feature", target_branch: "main" });
  assert.equal(p.status, "clean");
  await f.fresh()().mergeBranches({
    source_ref: "feature",
    target_branch: "main",
    commit_message: "Merge rename",
    author,
  });
  assert.equal(
    (await f.fresh()().blob("main", "renamed.md")).content,
    "first line\nchanged second line\nthird line\n",
  );
  await assert.rejects(
    () => f.fresh()().blob("main", "README.md"),
    /not found/,
  );
});
test("binary diff output applies with native git and unicode/copy patches retain paths", async () => {
  const f = memory(),
    repo = f.fresh()();
  const first = await repo.commitFiles({
    target_branch: "main",
    commit_message: "Initial",
    author,
    files: [
      { path: "中文.bin", data: base64(Uint8Array.of(0, 1, 2)) },
      { path: "original.txt", content: "one\ntwo\nthree\nfour\n" },
    ],
  });
  const second = await repo.commitFiles({
    target_branch: "main",
    commit_message: "Binary",
    author,
    files: [{ path: "中文.bin", data: base64(Uint8Array.of(0, 255, 2, 3)) }],
  });
  const dir = fixture();
  try {
    const ids = await repo.store.walk([first.sha]);
    git(
      ["index-pack", "--strict", "--stdin"],
      dir,
      await writePack(
        await Promise.all([...ids].map((id) => repo.store.get(id))),
      ),
    );
    git(["reset", "--hard", first.sha], dir);
    const diff = await repo.diff(second.sha, first.sha);
    git(["apply", "--binary", "--index", "-"], dir, bytes(diff.patch));
    assert.equal(text(git(["write-tree"], dir)).trim(), second.tree_sha);
    git(["reset", "--hard", first.sha], dir);
    writeFileSync(join(dir, "中文.bin"), Uint8Array.of(0, 4, 5));
    writeFileSync(join(dir, "copy.txt"), "one\ntwo\nthree\nfour\n");
    git(["add", "."], dir);
    const patch = git(
      ["diff", "--cached", "--binary", "--find-copies-harder"],
      dir,
    );
    const applied = await applyGitPatch(
      repo,
      {
        target_branch: "from_native",
        base_ref: first.sha,
        commit_message: "Copy unicode",
        author,
      },
      patch,
    );
    assert.equal(applied.tree_sha, text(git(["write-tree"], dir)).trim());
    assert.equal(
      (await repo.blob("from_native", "original.txt")).content,
      "one\ntwo\nthree\nfour\n",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("blame tracks moved/copied blocks and resolves regex, relative and function ranges", async () => {
  const f = memory(),
    repo = f.fresh()();
  const content =
    'function importantFunction() {\n  return "long identifiable original code for movement";\n}\n\nfunction nextFunction() {\n  return "another sufficiently lengthy original statement";\n}\n';
  const a = await repo.commitFiles({
    target_branch: "main",
    commit_message: "Original",
    author,
    files: [{ path: "code.ts", content }],
  });
  await repo.commitFiles({
    target_branch: "main",
    commit_message: "Copy and edit",
    author: { name: "Other", email: "other@example.com" },
    files: [{ path: "copy.ts", content: content + "// new line\n" }],
  });
  const blamed = await repo.blame({ path: "copy.ts", detect_moves: true });
  assert.equal(blamed.lines[0].sha, a.sha);
  assert.equal(blamed.lines[0].path, "code.ts");
  const range = await repo.blame({
    path: "copy.ts",
    range: ["/importantFunction/,+3"],
  });
  assert.deepEqual(
    range.lines.map((l) => l.line),
    [1, 2, 3],
  );
  const fn = await repo.blame({
    path: "copy.ts",
    range: [":importantFunction"],
  });
  assert.deepEqual(
    fn.lines.map((l) => l.line),
    [1, 2, 3, 4],
  );
  await assert.rejects(
    () => repo.blame({ path: "copy.ts", range: ["1,100"] }),
    /out of bounds/,
  );
});
test("grep pagination advances at root or nested options and rejects changed filters", async () => {
  const f = memory();
  await initial(f);
  const repo = f.fresh()();
  const query = { pattern: "." };
  const first = await repo.grep({ query, limit: 1 });
  assert.equal(first.matches.length, 1);
  assert.ok(first.next_cursor);
  const second = await repo.grep({
    query,
    limit: 1,
    cursor: first.next_cursor,
  });
  assert.equal(second.matches.length, 1);
  assert.notEqual(first.matches[0].line, second.matches[0].line);
  const third = await repo.grep({
    query,
    pagination: { limit: 1, cursor: second.next_cursor },
  });
  assert.equal(third.matches.length, 1);
  assert.equal(third.has_more, false);
  await assert.rejects(
    () =>
      repo.grep({
        query: { pattern: "one" },
        limit: 1,
        cursor: first.next_cursor,
      }),
    /different revision|query/,
  );
});
