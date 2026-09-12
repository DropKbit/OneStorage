import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { pullRepository, consumeSync, scheduleSync } from "../src/sync";
import { dispatchEvent, forgeEvent } from "../src/events";
import { collectDeleted, lifecycle } from "../src/lifecycle";
import { ObjectStore, bytes, canonical, makeObject } from "../src/git/objects";
import { namespaceRepositories } from "../src/git/namespaces";
function fixture() {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(
    new URL("../migrations/", import.meta.url),
  ).sort())
    db.exec(
      readFileSync(new URL("../migrations/" + file, import.meta.url), "utf8"),
    );
  const id = "11111111-1111-4111-8111-111111111111";
  db.exec(
    `INSERT INTO users(id,username,password) VALUES('u','owner','hash');INSERT INTO repositories(id,owner_id,namespace,name,visibility,base_repo) VALUES('${id}','u','owner','repo','private','{"provider":"github","owner":"octocat","name":"Hello-World","mode":"public"}');`,
  );
  const DB = {
    prepare(sql: string) {
      let args: any[] = [];
      return {
        bind(...v: any[]) {
          args = v;
          return this;
        },
        async first() {
          return db.prepare(sql).get(...args) || null;
        },
        async all() {
          return { results: db.prepare(sql).all(...args) };
        },
        async run() {
          return { meta: db.prepare(sql).run(...args) };
        },
      };
    },
  };
  const values = new Map<string, any>(),
    objects = new Map<string, Uint8Array>();
  let alarm = 0;
  const storage = {
    async get(k: string) {
      return structuredClone(values.get(k));
    },
    async put(k: any, v?: any) {
      if (typeof k === "string") values.set(k, structuredClone(v));
      else
        for (const [key, value] of Object.entries(k))
          values.set(key, structuredClone(value));
    },
    async delete(k: string | string[]) {
      for (const key of typeof k === "string" ? [k] : k) values.delete(key);
    },
    async list({ prefix, limit = Infinity }: any) {
      return new Map(
        [...values].filter(([k]) => k.startsWith(prefix)).slice(0, limit),
      );
    },
    async setAlarm(time: number) {
      alarm = time;
    },
  } as any;
  const bucket = {
    async get(k: string) {
      const b = objects.get(k);
      return b
        ? {
            size: b.length,
            arrayBuffer: async () =>
              b.buffer.slice(b.byteOffset, b.byteOffset + b.length),
            body: new Response(b as BodyInit).body,
          }
        : null;
    },
    async put(k: string, v: Uint8Array) {
      objects.set(k, v.slice());
      return {};
    },
    async list({ prefix, limit }: any) {
      return {
        objects: [...objects.keys()]
          .filter((k) => k.startsWith(prefix))
          .slice(0, limit)
          .map((key) => ({ key })),
      };
    },
    async delete(keys: string[]) {
      for (const k of keys) objects.delete(k);
    },
  } as any;
  const env = { DB, OBJECTS: bucket } as any;
  const metadata = () =>
    db.prepare("SELECT * FROM repositories WHERE id=?").get(id) as any;
  return {
    env,
    db,
    id,
    values,
    objects,
    storage,
    metadata,
    bucket,
    get alarm() {
      return alarm;
    },
  };
}
test("sync publishes only after objects persist; failures preserve refs, record status and retain reconciliation marker", async () => {
  const f = fixture();
  const store = new ObjectStore(f.id, f.bucket),
    tree = await store.create("tree", new Uint8Array()),
    commit = await store.create(
      "commit",
      bytes(
        `tree ${tree.oid}\nauthor A <a@b> 1 +0000\ncommitter A <a@b> 1 +0000\n\nInitial\n`,
      ),
    );
  await store.flush();
  const refs = {
    "refs/heads/main": commit.oid,
    "refs/namespaces/ephemeral/refs/heads/task": commit.oid,
  };
  f.values.set("refs.v2", refs);
  f.values.set("sync-reconcile", f.id);
  const broken = async () =>
    ({
      pull: async () => {
        throw Error("connection closed");
      },
    }) as any;
  await assert.rejects(() =>
    pullRepository(
      f.env,
      f.storage,
      f.metadata(),
      new ObjectStore(f.id, f.bucket),
      broken,
    ),
  );
  assert.deepEqual(f.values.get("refs.v2"), refs);
  assert.equal(f.metadata().sync_status, "failed");
  assert.equal(f.values.get("sync-reconcile"), f.id);
  assert.ok(
    [...f.values.values()].some((v) => v?.event === "repo.sync.failed"),
  );
  const working = async () =>
    ({
      pull: async () => ({
        refs: { "refs/heads/recovered": commit.oid },
        defaultBranch: "recovered",
      }),
    }) as any;
  await pullRepository(
    f.env,
    f.storage,
    f.metadata(),
    new ObjectStore(f.id, f.bucket),
    working,
  );
  assert.equal(f.values.get("sync-reconcile"), undefined);
  assert.equal(f.values.get("refs.v2")["refs/heads/main"], undefined);
  assert.equal(f.values.get("refs.v2")["refs/heads/recovered"], commit.oid);
  assert.equal(
    f.values.get("refs.v2")["refs/namespaces/ephemeral/refs/heads/task"],
    commit.oid,
  );
  assert.equal(f.metadata().default_branch, "recovered");
  assert.ok(f.metadata().synced_at);
  const badBucket = {
    ...f.bucket,
    put: async () => {
      throw Error("R2 unavailable");
    },
  };
  const pendingStore = new ObjectStore(f.id, badBucket);
  await pendingStore.create("blob", bytes("not persisted"));
  const before = structuredClone(f.values.get("refs.v2"));
  await assert.rejects(() =>
    pullRepository(f.env, f.storage, f.metadata(), pendingStore, working),
  );
  assert.deepEqual(f.values.get("refs.v2"), before);
});
test("durable event projection is idempotent and honors subscribed event types", async () => {
  const f = fixture();
  f.db
    .prepare(
      "INSERT INTO webhooks(id,repo_id,url,secret,events) VALUES(?,?,?,?,?)",
    )
    .run("h", f.id, "https://hooks.example.com", "secret", '["push"]');
  const event = forgeEvent(f.id, "push", {
    ref: "refs/heads/main",
    before: "0".repeat(40),
    after: "a".repeat(40),
  });
  await dispatchEvent(f.env, event);
  await dispatchEvent(f.env, event);
  await dispatchEvent(f.env, forgeEvent(f.id, "repo.sync.started"));
  assert.equal(
    (f.db.prepare("SELECT COUNT(*) AS n FROM deliveries").get() as any).n,
    1,
  );
  assert.equal(
    JSON.parse(
      (f.db.prepare("SELECT payload FROM deliveries").get() as any).payload,
    ).ref,
    "refs/heads/main",
  );
});
test("deletion tombstone rejects writes and incremental cleanup removes Git, LFS and relational data", async () => {
  const f = fixture();
  for (let i = 0; i < 150; i++)
    f.objects.set(`repos/${f.id}/objects/${i}`, Uint8Array.of(i));
  f.objects.set(`lfs/${f.id}/object`, Uint8Array.of(1));
  f.objects.set("repos/other/objects/keep", Uint8Array.of(2));
  const repo = namespaceRepositories(
    new ObjectStore(f.id, f.bucket),
    f.storage,
    {},
    "main",
    { rules: [] },
  )();
  await lifecycle(
    new Request("http://repo/internal/delete", { method: "POST" }),
    repo,
    f.env,
    f.storage,
  );
  assert.equal(f.values.get("deleted"), f.id);
  assert.ok(f.metadata().deleted_at);
  await assert.rejects(
    () =>
      lifecycle(
        new Request("http://repo/internal/lfs/" + "a".repeat(64), {
          method: "PUT",
          body: "bad",
        }),
        repo,
        f.env,
        f.storage,
      ),
    /deleted/,
  );
  for (const key of [
    "browse-root.v1:ordinary",
    "browse-root.v1:ephemeral",
    "browse-warmed.v1",
  ])
    f.values.set(key, "private cached content");
  for (let i = 0; i < 5; i++) await collectDeleted(f.env, f.storage);
  assert.equal(
    [...f.values.keys()].some((key) => key.startsWith("browse-")),
    false,
  );
  assert.equal(f.metadata(), undefined);
  assert.deepEqual([...f.objects.keys()], ["repos/other/objects/keep"]);
  assert.equal(f.values.get("deleted"), f.id);
});
test("ref policies reject API writes before any upstream forwarding", async () => {
  const f = fixture();
  let calls = 0;
  const repo = namespaceRepositories(
    new ObjectStore(f.id, f.bucket),
    f.storage,
    {},
    "main",
    {
      rules: [["*", ["no-push"]]],
      beforePublish: async (_a, b) => {
        calls++;
        return b;
      },
    },
  )();
  await assert.rejects(
    () =>
      repo.commitFiles({
        target_branch: "main",
        commit_message: "Denied",
        author: { name: "A", email: "a@b" },
        files: [{ path: "README", content: "x" }],
      }),
    /forbids/,
  );
  assert.equal(calls, 0);
  assert.equal(f.objects.size, 0);
});
