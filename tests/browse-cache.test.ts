import test from "node:test";
import assert from "node:assert/strict";
import { BrowseCache, BROWSE_CACHE_TTL } from "../src/git/browse-cache";
import { repositoryRead } from "../src/git/snapshot-read";
import { ForgeRepository } from "../src/git/forge";
import {
  ObjectStore,
  bytes,
  canonical,
  makeObject,
  treeBytes,
} from "../src/git/objects";

async function fixture(readme = "# Original\n") {
  const objects = new Map<string, Uint8Array>(),
    state = new Map<string, any>();
  let reads = 0;
  const save = async (type: "blob" | "tree" | "commit", value: Uint8Array) => {
    const object = await makeObject(type, value);
    objects.set(object.oid, canonical(object));
    return object.oid;
  };
  const commit = async (value: string) => {
    const blob = await save("blob", bytes(value));
    const tree = await save(
      "tree",
      treeBytes([
        { name: "README.md", mode: "100644", type: "blob", sha: blob },
      ]),
    );
    return save(
      "commit",
      bytes(
        `tree ${tree}\nauthor Test <test@example.com> 1 +0000\ncommitter Test <test@example.com> 1 +0000\n\nTest\n`,
      ),
    );
  };
  const sha = await commit(readme);
  const storage = {
    get: async <T>(key: string) =>
      structuredClone(state.get(key)) as T | undefined,
    put: async <T>(key: string, value: T) => {
      state.set(key, structuredClone(value));
    },
  };
  const bucket = {
    get: async (key: string) => {
      reads++;
      const raw = objects.get(key.split("/").at(-1)!);
      return (
        raw && { size: raw.length, arrayBuffer: async () => raw.slice().buffer }
      );
    },
  } as unknown as R2Bucket;
  const repo = (
    refs: Record<string, string> = { "refs/heads/main": sha },
    id = "repo",
    ephemeral = false,
  ) =>
    new ForgeRepository(new ObjectStore(id, bucket), storage, refs, "main", {
      rules: [],
      ...(ephemeral ? { namespace: "ephemeral" as const } : {}),
    });
  const browse = (
    r: ForgeRepository,
    cache = new BrowseCache(storage),
    query = "",
  ) =>
    repositoryRead(
      r,
      new Request("https://repository/browse" + query),
      r.defaultBranch,
      cache,
    ) as Promise<Response>;
  return { repo, browse, storage, state, commit, sha, reads: () => reads };
}

test("a cold repository instance reuses durable root content with zero R2 reads", async () => {
  const f = await fixture();
  const first = await f.browse(f.repo());
  const expected = await first.json();
  assert.equal(f.reads(), 3);
  assert.match(first.headers.get("server-timing")!, /persistent-miss/);
  const next = await f.browse(f.repo());
  assert.deepEqual(await next.json(), expected);
  assert.equal(f.reads(), 3);
  assert.match(next.headers.get("server-timing")!, /persistent-hit/);
});

test("changed refs miss, branch lists remain live, and removed refs cannot reuse cache", async () => {
  const f = await fixture();
  await f.browse(f.repo());
  const extra = await f.browse(
    f.repo({ "refs/heads/main": f.sha, "refs/heads/topic": f.sha }),
  );
  assert.equal(((await extra.json()) as any).branches.length, 2);
  assert.equal(f.reads(), 3);
  const next = await f.commit("# Changed\n");
  const response = await f.browse(f.repo({ "refs/heads/main": next }));
  assert.equal(((await response.json()) as any).readme.content, "# Changed\n");
  assert.equal(f.reads(), 6);
  await assert.rejects(
    f.browse(f.repo({ "refs/heads/topic": next })),
    /Revision not found/,
  );
  const empty = await f.browse(f.repo({}));
  assert.equal(((await empty.json()) as any).data, null);
});

test("repository and ephemeral namespaces do not share cache entries", async () => {
  const f = await fixture();
  await f.browse(f.repo());
  await f.browse(f.repo(undefined, "another"));
  assert.equal(f.reads(), 6);
  await f.browse(f.repo(undefined, "repo", true));
  assert.equal(f.reads(), 9);
  assert.equal(f.state.size, 2);
  await f.browse(f.repo(undefined, "repo", true));
  assert.equal(f.reads(), 9);
});

test("expired, oversized and failed caches fall back without changing browser limits", async () => {
  const f = await fixture();
  await f.browse(f.repo(), new BrowseCache(f.storage, true, () => 0));
  await f.browse(
    f.repo(),
    new BrowseCache(f.storage, true, () => BROWSE_CACHE_TTL),
  );
  assert.equal(f.reads(), 6);
  const broken = new BrowseCache({
    get: async () => {
      throw Error("unavailable");
    },
    put: async () => {
      throw Error("unavailable");
    },
  });
  assert.equal((await f.browse(f.repo(), broken)).status, 200);
  const large = await fixture("a".repeat(100 * 1024));
  await large.browse(large.repo());
  assert.equal(large.state.size, 0);
  const huge = await fixture("a".repeat(1024 * 1024 + 1));
  assert.equal(
    ((await (await huge.browse(huge.repo())).json()) as any).readme,
    null,
  );
});

test("snapshot reads can consume a durable cache but never write one", async () => {
  const f = await fixture();
  await f.browse(f.repo(), new BrowseCache(f.storage, false));
  assert.equal(f.state.size, 0);
  await f.browse(f.repo());
  const before = f.reads();
  const response = await f.browse(f.repo(), new BrowseCache(f.storage, false));
  assert.match(response.headers.get("server-timing")!, /persistent-hit/);
  assert.equal(f.reads(), before);
});

test("cache retains revision semantics and never handles file paths or blob views", async () => {
  const f = await fixture();
  await f.browse(f.repo());
  const cache = new BrowseCache(f.storage);
  assert.equal(cache.target(f.repo(), "deadbeef"), undefined);
  assert.equal(cache.target(f.repo(), "HEAD~1"), undefined);
  const response = await f.browse(f.repo(), cache, "?view=blob&path=README.md");
  assert.equal(((await response.json()) as any).data.content, "# Original\n");
  assert.match(response.headers.get("server-timing")!, /uncached/);
  await assert.rejects(
    f.browse(f.repo(), cache, "?path=../secret"),
    /Invalid file path/,
  );
});
