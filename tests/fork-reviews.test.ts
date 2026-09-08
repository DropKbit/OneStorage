import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import {
  sameForkFamily,
  contributionSource,
  importContribution,
} from "../src/fork-reviews";
import { reviewMutation } from "../src/review-mutations";
import {
  ObjectStore,
  makeObject,
  canonical,
  bytes,
  treeBytes,
} from "../src/git/objects";
import { namespaceRepositories } from "../src/git/namespaces";
import type { Env, Repo, User } from "../src/types";
async function fixture() {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync("migrations").sort())
    db.exec(readFileSync("migrations/" + f, "utf8"));
  db.exec(
    "INSERT INTO users(id,username,password) VALUES('owner','owner','x'),('author','author','x'),('guest','guest','x');INSERT INTO repositories(id,owner_id,namespace,name,visibility,fork_source) VALUES('target','owner','owner','upstream','public',NULL),('source','author','author','fork','private','target'),('sibling','guest','guest','fork','private','target'),('other','author','author','other','private',NULL)",
  );
  const DB = {
    prepare(sql: string) {
      let values: any[] = [];
      return {
        bind(...v: any[]) {
          values = v;
          return this;
        },
        async first() {
          return db.prepare(sql).get(...values) || null;
        },
        async all() {
          return { results: db.prepare(sql).all(...values) };
        },
        async run() {
          return { meta: db.prepare(sql).run(...values) };
        },
      };
    },
    async batch(statements: any[]) {
      db.exec("BEGIN");
      try {
        const r = [];
        for (const s of statements) r.push(await s.run());
        db.exec("COMMIT");
        return r;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
  const objects = new Map<string, Uint8Array>();
  const bucket = {
    async get(key: string) {
      const data = objects.get(key);
      return data
        ? {
            size: data.length,
            arrayBuffer: async () =>
              data.buffer.slice(data.byteOffset, data.byteOffset + data.length),
            body: new Response(data as BodyInit).body,
          }
        : null;
    },
    async put(key: string, value: any) {
      if (objects.has(key)) return null;
      const data =
        value instanceof Uint8Array
          ? value
          : new Uint8Array(await new Response(value).arrayBuffer());
      objects.set(key, data);
      return { key };
    },
  };
  const env = { DB, OBJECTS: bucket } as unknown as Env,
    target = db
      .prepare("SELECT * FROM repositories WHERE id='target'")
      .get() as unknown as Repo,
    source = db
      .prepare("SELECT * FROM repositories WHERE id='source'")
      .get() as unknown as Repo,
    user = { id: "author", username: "author", admin: 0 } as User;
  const blob = await makeObject("blob", bytes("line one\nline two\n")),
    tree = await makeObject(
      "tree",
      treeBytes([
        { mode: "100644", name: "code.txt", sha: blob.oid, type: "blob" },
      ]),
    ),
    commit = await makeObject(
      "commit",
      bytes(
        `tree ${tree.oid}\nauthor A <a@b> 1 +0000\ncommitter A <a@b> 1 +0000\n\nSource`,
      ),
    );
  for (const o of [blob, tree, commit])
    objects.set("repos/source/objects/" + o.oid, canonical(o));
  const storage = { get: async () => undefined, put: async () => {} },
    repo = namespaceRepositories(
      new ObjectStore("target", bucket as any),
      storage as any,
      {},
      "main",
      { rules: [] },
    )(false);
  return { db, env, target, source, user, objects, repo, commit, tree, blob };
}
test("fork families include siblings and surviving children of deleted ancestors without accepting unrelated repositories", async () => {
  const f = await fixture();
  assert.equal(await sameForkFamily(f.env, "target", "source"), true);
  assert.equal(await sameForkFamily(f.env, "source", "sibling"), true);
  assert.equal(await sameForkFamily(f.env, "source", "other"), false);
  f.db.exec("DELETE FROM repositories WHERE id='target'");
  assert.equal(await sameForkFamily(f.env, "source", "sibling"), true);
});
test("cross-fork publication requires source write access and target read access; only public sources permit maintainer refresh", async () => {
  const f = await fixture();
  await contributionSource(f.env, f.target, f.source, f.user);
  await assert.rejects(
    () =>
      contributionSource(f.env, f.target, f.source, {
        id: "guest",
        username: "guest",
        admin: 0,
      }),
    /Write access|not found/,
  );
  await assert.rejects(
    () =>
      contributionSource(
        f.env,
        f.target,
        f.source,
        { id: "owner", username: "owner", admin: 0 },
        true,
      ),
    /Write access|not found/,
  );
  await contributionSource(
    f.env,
    f.target,
    { ...f.source, visibility: "public" },
    { id: "owner", username: "owner", admin: 0 },
    true,
  );
  await assert.rejects(
    () =>
      contributionSource(
        f.env,
        { ...f.target, visibility: "private" },
        f.source,
        f.user,
      ),
    /not found/,
  );
});
test("a published source snapshot remains readable after its fork disappears and excludes unreachable uploads", async () => {
  const f = await fixture();
  f.objects.set(
    "repos/source/objects/" + "a".repeat(40),
    bytes("not part of this snapshot"),
  );
  const result = await importContribution(f.env, f.repo, f.target, {
    actor_id: "author",
    source_id: "source",
    source_sha: f.commit.oid,
  });
  assert.equal(result.objects, 3);
  assert.deepEqual(f.repo.refs, {});
  for (const key of f.objects.keys())
    if (key.startsWith("repos/source/")) f.objects.delete(key);
  const store = new ObjectStore("target", f.env.OBJECTS);
  assert.equal((await store.get(f.commit.oid)).type, "commit");
  assert.equal(f.objects.has("repos/target/objects/" + "a".repeat(40)), false);
});
test("missing source objects fail before any target objects are published", async () => {
  const f = await fixture();
  f.objects.delete("repos/source/objects/" + f.blob.oid);
  await assert.rejects(() =>
    importContribution(f.env, f.repo, f.target, {
      actor_id: "author",
      source_id: "source",
      source_sha: f.commit.oid,
    }),
  );
  assert.equal(
    [...f.objects.keys()].some((x) => x.startsWith("repos/target/")),
    false,
  );
});
test("line discussions bind real file positions and review versions; refresh compare-and-swap rejects stale updates", async () => {
  const f = await fixture();
  await importContribution(f.env, f.repo, f.target, {
    actor_id: "author",
    source_id: "source",
    source_sha: f.commit.oid,
  });
  f.db
    .prepare(
      "INSERT INTO merge_requests(id,repo_id,author_id,title,source,target,source_sha,target_sha,source_repo_id) VALUES(1,'target','author','MR','main','main',?,?,'source')",
    )
    .run(f.commit.oid, f.commit.oid);
  const b = {
    id: 1,
    actor_id: "owner",
    source_sha: f.commit.oid,
    target_sha: f.commit.oid,
    body: "Review",
    path: "code.txt",
    side: "new",
    line: 2,
  };
  const discussion = (await reviewMutation(
    f.env,
    f.repo,
    f.target,
    "/review-discussion",
    b,
  )) as any;
  assert.ok(discussion.id);
  await assert.rejects(
    () =>
      reviewMutation(f.env, f.repo, f.target, "/review-discussion", {
        ...b,
        line: 3,
      }),
    /outside/,
  );
  await assert.rejects(
    () =>
      reviewMutation(f.env, f.repo, f.target, "/review-discussion", {
        ...b,
        source_sha: "a".repeat(40),
      }),
    /version changed/,
  );
  await assert.rejects(
    () =>
      reviewMutation(f.env, f.repo, f.target, "/review-resolve", {
        id: 1,
        actor_id: "guest",
        discussion: discussion.id,
        resolved: true,
      }),
    /required/,
  );
  await reviewMutation(f.env, f.repo, f.target, "/review-update", {
    id: 1,
    actor_id: "author",
    revision: 0,
    title: "New title",
  });
  await assert.rejects(
    () =>
      reviewMutation(f.env, f.repo, f.target, "/review-update", {
        id: 1,
        actor_id: "author",
        revision: 0,
        title: "Stale",
      }),
    /changed/,
  );
  assert.equal(
    f.db.prepare("SELECT title FROM merge_requests").get()!.title,
    "New title",
  );
});
test("snapshot import copies only LFS payloads referenced by its reachable Git history", async () => {
  const f = await fixture(),
    oid = "a".repeat(64),
    unrelated = "b".repeat(64),
    payload = bytes("LFS content");
  f.objects.set("lfs/source/" + oid, payload);
  f.objects.set("lfs/source/" + unrelated, bytes("private unrelated upload"));
  const pointer = await makeObject(
      "blob",
      bytes(
        `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${payload.length}\n`,
      ),
    ),
    tree = await makeObject(
      "tree",
      treeBytes([
        { name: "asset.bin", mode: "100644", type: "blob", sha: pointer.oid },
      ]),
    ),
    commit = await makeObject(
      "commit",
      bytes(
        `tree ${tree.oid}\nparent ${f.commit.oid}\nauthor A <a@b> 1 +0000\ncommitter A <a@b> 1 +0000\n\nLFS contribution`,
      ),
    );
  for (const object of [pointer, tree, commit])
    f.objects.set("repos/source/objects/" + object.oid, canonical(object));
  await importContribution(f.env, f.repo, f.target, {
    source_id: "source",
    source_sha: commit.oid,
    actor_id: "author",
  });
  assert.deepEqual(f.objects.get("lfs/target/" + oid), payload);
  assert.equal(f.objects.has("lfs/target/" + unrelated), false);
});
test("discussion and reply HTTP cursors reach entries past the first page and enforce target privacy", async () => {
  const { default: app } = await import("../src/app"),
    f = await fixture();
  f.db
    .prepare(
      "INSERT INTO merge_requests(id,repo_id,author_id,title,source,target,source_sha,target_sha) VALUES(1,'target','author','MR','main','topic',?,?)",
    )
    .run(f.commit.oid, f.commit.oid);
  let first = "";
  for (let i = 0; i < 102; i++) {
    const id = crypto.randomUUID();
    if (!i) first = id;
    f.db
      .prepare(
        "INSERT INTO merge_discussions(id,mr_id,author_id,source_sha,target_sha) VALUES(?,1,'owner',?,?)",
      )
      .run(id, f.commit.oid, f.commit.oid);
  }
  for (let i = 0; i < 103; i++)
    f.db
      .prepare(
        "INSERT INTO merge_discussion_comments(discussion_id,author_id,body) VALUES(?,'owner',?)",
      )
      .run(first, "comment " + i);
  async function get(path: string, status = 200) {
    const response = await app.fetch(
      new Request(
        "http://localhost/api/repos/owner/upstream/merges/1/discussions" + path,
      ),
      f.env,
      { waitUntil() {}, passThroughOnException() {} } as any,
    );
    assert.equal(response.status, status);
    return (await response.json()) as any;
  }
  const initial = await get("");
  assert.equal(initial.discussions.length, 100);
  assert.equal(initial.next, 100);
  assert.equal(initial.discussions[0].comments_count, 103);
  const next = await get("?after=" + initial.next);
  assert.equal(next.discussions.length, 2);
  assert.equal(next.next, null);
  assert.notEqual(initial.discussions[0].id, next.discussions[0].id);
  const replies = await get("/" + first);
  assert.equal(replies.comments.length, 100);
  const more = await get("/" + first + "?after=" + replies.next);
  assert.equal(more.comments.length, 3);
  assert.equal(more.comments[2].body, "comment 102");
  await get("?after=-1", 400);
  await get("/" + crypto.randomUUID(), 404);
  f.db.exec("UPDATE repositories SET visibility='private' WHERE id='target'");
  await get("", 401);
});
