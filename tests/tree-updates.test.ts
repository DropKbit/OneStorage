import test from "node:test";
import assert from "node:assert/strict";
import { updatesAt } from "../src/git/tree-updates";
import { relativeTime } from "../src/i18n/relative";
import { ForgeRepository } from "../src/git/forge";
import {
  ObjectStore,
  makeObject,
  canonical,
  bytes,
  treeBytes,
} from "../src/git/objects";
async function fixture() {
  const objects = new Map(),
    values = new Map();
  let reads = 0;
  const storage = {
    get: async <T>(k: string) =>
      structuredClone(values.get(k)) as T | undefined,
    put: async <T>(k: string, v: T) => {
      values.set(k, structuredClone(v));
    },
  };
  const save = async (type: any, data: Uint8Array) => {
    const o = await makeObject(type, data);
    objects.set(o.oid, canonical(o));
    return o.oid;
  };
  const commit = async (
    files: Record<string, string>,
    parents: string[] = [],
    time = 1000,
    mode = "100644",
  ) => {
    const entries = [];
    for (const [name, content] of Object.entries(files))
      entries.push({
        name,
        sha: await save("blob", bytes(content)),
        type: "blob" as const,
        mode,
      });
    const tree = await save("tree", treeBytes(entries));
    return save(
      "commit",
      bytes(
        `tree ${tree}\n${parents.map((p) => "parent " + p + "\n").join("")}author A <a@b.c> ${time} +0000\ncommitter A <a@b.c> ${time} +0000\n\nUpdate\n`,
      ),
    );
  };
  const repo = (sha: string) =>
    new ForgeRepository(
      new ObjectStore("repo", {
        get: async (k: string) => {
          reads++;
          const b = objects.get(k.split("/").at(-1));
          return b
            ? { size: b.length, arrayBuffer: async () => b.slice().buffer }
            : null;
        },
      } as any),
      storage,
      { "refs/heads/main": sha },
      "main",
    );
  return { save, commit, repo, storage, values, reads: () => reads };
}
test("timestamps follow the latest first-parent path change, not the latest repository commit", async () => {
  const f = await fixture(),
    a = await f.commit({ old: "old", changed: "a" }, [], 1000),
    b = await f.commit({ old: "old", changed: "b" }, [a], 2000),
    c = await f.commit({ old: "old", changed: "b", new: "new" }, [b], 3000);
  const r = await updatesAt(f.repo(c), c, "", f.storage);
  assert.equal(r.complete, true);
  assert.deepEqual(Object.fromEntries(r.updates.map((u) => [u.name, u.date])), {
    old: new Date(1000000).toISOString(),
    changed: new Date(2000000).toISOString(),
    new: new Date(3000000).toISOString(),
  });
  const before = f.reads();
  await updatesAt(f.repo(c), c, "", f.storage);
  assert.equal(f.reads() - before, 1);
});
test("mode changes and merges record when content entered the selected branch", async () => {
  const f = await fixture(),
    a = await f.commit({ file: "a" }, [], 1000),
    feature = await f.commit({ file: "b" }, [a], 2000),
    merged = await f.commit({ file: "b" }, [a, feature], 3000);
  assert.equal(
    (await updatesAt(f.repo(merged), merged, "", f.storage)).updates[0].commit,
    merged,
  );
  const mode = await f.commit({ file: "b" }, [merged], 4000, "100755");
  assert.equal(
    (await updatesAt(f.repo(mode), mode, "", f.storage)).updates[0].commit,
    mode,
  );
});
test("long histories advance in bounded batches across fresh instances and invalidate on ref changes", async () => {
  const f = await fixture();
  let head = await f.commit({ file: "a" });
  const first = head;
  for (let i = 0; i < 35; i++)
    head = await f.commit({ file: "a" }, [head], 2000 + i);
  let result = await updatesAt(f.repo(head), head, "", f.storage);
  assert.equal(result.complete, false);
  assert.equal(result.updates[0].date, null);
  result = await updatesAt(f.repo(head), head, "", f.storage);
  assert.equal(result.complete, false);
  result = await updatesAt(f.repo(head), head, "", f.storage);
  assert.equal(result.complete, true);
  assert.equal(result.updates[0].commit, first);
  const next = await f.commit({ file: "new" }, [head], 3000);
  result = await updatesAt(f.repo(next), next, "", f.storage);
  assert.equal(result.updates[0].commit, next);
  await assert.rejects(
    updatesAt(f.repo(next), next, "../secret", f.storage),
    /Invalid file path/,
  );
});
test("relative times support Chinese and English, exact instants and future commit clocks", () => {
  const now = Date.UTC(2026, 8, 19, 12);
  assert.equal(
    relativeTime(new Date(now - 3 * 86400000).toISOString(), "en", now),
    "3 days ago",
  );
  assert.equal(
    relativeTime(new Date(now - 3 * 86400000).toISOString(), "zh-CN", now),
    "3天前",
  );
  assert.equal(
    relativeTime(new Date(now + 2 * 3600000).toISOString(), "en", now),
    "in 2 hours",
  );
  assert.equal(relativeTime("invalid", "en", now), "—");
});

test("subdirectories and folder rows follow changes beneath the selected path", async () => {
  const f = await fixture();
  const build = async (content: string, parents: string[], time: number) => {
    const blob = await f.save("blob", bytes(content));
    const subtree = await f.save(
      "tree",
      treeBytes([
        { name: "file.txt", sha: blob, mode: "100644", type: "blob" },
      ]),
    );
    const tree = await f.save(
      "tree",
      treeBytes([{ name: "src", sha: subtree, mode: "40000", type: "tree" }]),
    );
    return f.save(
      "commit",
      bytes(
        `tree ${tree}\n${parents.map((p) => "parent " + p + "\n").join("")}author A <a@b.c> ${time} +0000\ncommitter A <a@b.c> ${time} +0000\n\nFolder\n`,
      ),
    );
  };
  const a = await build("a", [], 1000),
    b = await build("b", [a], 2000);
  assert.equal(
    (await updatesAt(f.repo(b), b, "", f.storage)).updates[0].commit,
    b,
  );
  const nested = await updatesAt(f.repo(b), b, "src", f.storage);
  assert.equal(nested.path, "src");
  assert.equal(nested.updates[0].name, "file.txt");
  assert.equal(nested.updates[0].commit, b);
  const old = await updatesAt(f.repo(a), a, "src", f.storage);
  assert.equal(old.updates[0].commit, a);
});
