import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { registerCacheRoutes } from "../src/ci-cache-routes";
import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support/review-fixture";
import { enqueueRun, claimRun } from "../src/ci";
import { pipelineSchema } from "../src/ci-config";
import {
  prepareCache,
  readCache,
  writeCache,
  collectCICaches,
  cloudCacheInputs,
  saveCloudCaches,
} from "../src/ci-cache";
import { cacheSchema, CACHE_LIMIT } from "../src/ci-cache-schema";
import { digest } from "../src/security";
import type { CIRun } from "../src/ci";
const sha = "a".repeat(40),
  spec = { id: "deps", key: "dependencies", paths: [".cache"] };
function setup() {
  const f = fixture();
  let contents = "lock-one",
    tip = sha;
  f.env.REPOSITORIES = {
    idFromName: (s: string) => s,
    get: () => ({
      fetch: async (r: Request) =>
        new URL(r.url).pathname === "/branch"
          ? Response.json({ sha: tip })
          : new Response(contents),
    }),
  } as any;
  f.env.OBJECTS = {
    get: async (key: string) => {
      const bytes = f.objects.get(key);
      return bytes
        ? { size: bytes.length, body: new Response(bytes as BodyInit).body }
        : null;
    },
    put: async (key: string, v: Uint8Array) => {
      f.objects.set(key, v);
      return {};
    },
    delete: async (key: string) => {
      f.objects.delete(key);
    },
  } as any;
  async function run(options: any = {}, trigger = "manual", ref = "main") {
    const config = pipelineSchema.parse({
      runner: "worker",
      steps: [{ type: "file", path: "lock" }],
      caches: [spec],
      ...options,
    });
    const made = await enqueueRun(
      f.env,
      f.repo,
      ref,
      sha,
      config,
      trigger,
      "o",
    );
    assert.ok(made);
    return (await claimRun(
      f.env,
      "r",
      "runner",
      (config as any).runner,
      made.id,
    ))!.run;
  }
  const finish = (run: CIRun, status = "succeeded") =>
    f.db
      .prepare(
        "UPDATE ci_runs SET status=?,lease_hash=NULL,finished_at=datetime('now') WHERE id=?",
      )
      .run(status, run.id);
  const data = new TextEncoder().encode(
    JSON.stringify({ ".cache/result": { content: "cached" } }),
  );
  const save = async (run: CIRun) =>
    writeCache(f.env, run, "deps", data.length, await digest(data), (key) =>
      f.env.OBJECTS.put(key, data),
    );
  return {
    ...f,
    run,
    finish,
    save,
    data,
    setContents: (s: string) => (contents = s),
    setTip: (s: string) => (tip = s),
  };
}
test("cache configuration rejects traversal, git control paths, overlap and duplicate slots", () => {
  for (const paths of [
    ["../bad"],
    ["/absolute"],
    [".git/objects"],
    ["a/.GIT/x"],
    ["a", "a/b"],
  ])
    assert.equal(cacheSchema.safeParse({ ...spec, paths }).success, false);
  assert.equal(
    pipelineSchema.safeParse({
      runner: "worker",
      steps: [{ type: "file", path: "x" }],
      caches: [spec, spec],
    }).success,
    false,
  );
});
test("immutable cache becomes readable only after successful run; key files, branches, policies and format isolate it", async () => {
  const f = setup(),
    config = { caches: [{ ...spec, key_files: ["package-lock.json"] }] };
  const source = await f.run(config);
  await f.save(source);
  assert.equal(await readCache(f.env, await f.run(config), "deps"), null);
  f.finish(source);
  const consumer = await f.run(config),
    hit = await readCache(f.env, consumer, "deps");
  assert.ok(hit);
  await hit.object.body?.cancel();
  f.setContents("changed-lock");
  assert.equal(await readCache(f.env, await f.run(config), "deps"), null);
  // First resolution freezes key-file hashes for a run.
  assert.ok(await readCache(f.env, consumer, "deps"));
  assert.equal(
    await readCache(f.env, await f.run(config, "manual", "other"), "deps"),
    null,
  );
  assert.equal(
    await readCache(
      f.env,
      await f.run({ ...config, runner: "external" }),
      "deps",
    ),
    null,
  );
  assert.equal(
    await readCache(
      f.env,
      await f.run({ caches: [{ ...spec, policy: "push" }] }),
      "deps",
    ),
    null,
  );
  await assert.rejects(
    f.save(await f.run({ caches: [{ ...spec, policy: "pull" }] })),
    /Read-only/,
  );
});
test("protected sharing excludes MR and unprotected branches; branch caches distinguish MR origin even for same ref", async () => {
  const f = setup(),
    config = { caches: [{ ...spec, scope: "protected" }] };
  f.db.exec(
    "INSERT INTO branch_protections(repo_id,branch,require_mr) VALUES('r','release',1)",
  );
  const source = await f.run(config);
  await f.save(source);
  f.finish(source);
  assert.ok(
    await readCache(f.env, await f.run(config, "manual", "release"), "deps"),
  );
  await assert.rejects(
    prepareCache(f.env, await f.run(config, "merge_request"), "deps"),
    /Protected cache/,
  );
  await assert.rejects(
    prepareCache(f.env, await f.run(config, "manual", "feature"), "deps"),
    /Protected cache/,
  );
  const branch = await f.run();
  await f.save(branch);
  f.finish(branch);
  assert.equal(
    await readCache(f.env, await f.run({}, "merge_request"), "deps"),
    null,
  );
});
test("failed parent hides successful child caches until whole workflow succeeds", async () => {
  const f = setup(),
    parent = await f.run(),
    child = await f.run();
  f.db
    .prepare("UPDATE ci_runs SET parent_id=?,job_key=? WHERE id=?")
    .run(parent.id, "child", child.id);
  await f.save(child);
  f.finish(child);
  assert.equal(await readCache(f.env, await f.run(), "deps"), null);
  f.finish(parent);
  assert.ok(await readCache(f.env, await f.run(), "deps"));
});
test("clear, cancel and lifecycle races cannot publish a late upload; failure records remain collectable", async () => {
  for (const change of [
    "UPDATE ci_cache_state SET generation=generation+1",
    "UPDATE ci_runs SET status='canceled',lease_hash=NULL",
    "UPDATE repositories SET archived_at=datetime('now') WHERE id='r'",
  ]) {
    const f = setup(),
      run = await f.run();
    await assert.rejects(
      writeCache(
        f.env,
        run,
        "deps",
        f.data.length,
        await digest(f.data),
        async (key) => {
          await f.env.OBJECTS.put(key, f.data);
          f.db.exec(change);
        },
      ),
    );
    assert.equal(f.objects.size, 0);
    assert.equal(
      f.db.prepare("SELECT COUNT(*) n FROM ci_cache_entries").get()!.n,
      0,
    );
  }
});
test("generation changes during key resolution reject stale bindings and restored repos start with empty caches", async () => {
  const f = setup(),
    source = await f.run();
  await f.save(source);
  f.finish(source);
  const stale = await f.run();
  await prepareCache(f.env, stale, "deps");
  f.db.exec("UPDATE ci_cache_state SET generation=generation+1");
  await assert.rejects(readCache(f.env, stale, "deps"), /generation/);
  assert.equal(await readCache(f.env, await f.run(), "deps"), null);
  f.db.exec(
    "UPDATE repositories SET archived_at=datetime('now') WHERE id='r';UPDATE repositories SET archived_at=NULL WHERE id='r'",
  );
  assert.equal(await readCache(f.env, await f.run(), "deps"), null);
  assert.equal(await collectCICaches(f.env), 1);
  assert.equal(f.objects.size, 0);
});
test("quota reservations are atomic and failed/expired/superseded caches are collected", async () => {
  const f = setup();
  for (let i = 0; i < 8; i++)
    await writeCache(
      f.env,
      await f.run({ runner: "external" }),
      "deps",
      CACHE_LIMIT,
      "0".repeat(64),
      async () => {},
    );
  await assert.rejects(
    writeCache(
      f.env,
      await f.run({ runner: "external" }),
      "deps",
      1,
      "0".repeat(64),
      async () => {},
    ),
    /quota/,
  );
  f.db.exec("UPDATE ci_runs SET status='failed',lease_hash=NULL");
  assert.equal(await collectCICaches(f.env), 8);
  const source = await f.run();
  await f.save(source);
  f.finish(source);
  f.db.exec("UPDATE ci_cache_entries SET expires_at=0");
  assert.equal(await readCache(f.env, await f.run(), "deps"), null);
  assert.equal(await collectCICaches(f.env), 1);
});
test("cloud files support hit/miss, checksum failure and output path validation without leaking across slots", async () => {
  const f = setup(),
    source = await f.run();
  await saveCloudCaches(f.env, source, {
    deps: { ".cache/a": { content: "ok" } },
  });
  f.finish(source);
  const read = await cloudCacheInputs(f.env, await f.run());
  assert.equal(read.files.deps[".cache/a"].content, "ok");
  assert.match(read.events.join(""), /HIT/);
  const entry = f.db.prepare("SELECT object_key FROM ci_cache_entries").get()!;
  f.objects.set(entry.object_key as string, new Uint8Array([1, 2]));
  assert.deepEqual(
    (await cloudCacheInputs(f.env, await f.run())).files.deps,
    {},
  );
  await assert.rejects(
    saveCloudCaches(f.env, await f.run(), {
      deps: { outside: { content: "bad" } },
    }),
    /outside/,
  );
});
test("failed R2 upload retains no usable index; a frozen upload slot is idempotent but cannot replace bytes", async () => {
  const f = setup(),
    source = await f.run();
  await assert.rejects(
    writeCache(f.env, source, "deps", 1, "0".repeat(64), async () => {
      throw Error("R2 unavailable");
    }),
    /R2 unavailable/,
  );
  await f.save(source);
  await f.save(source);
  await assert.rejects(
    writeCache(f.env, source, "deps", 1, "0".repeat(64), async () => {}),
    /slot/,
  );
  assert.equal(
    f.db.prepare("SELECT COUNT(*) n FROM ci_cache_entries").get()!.n,
    1,
  );
});

test("fallback keys retain trust boundaries and missing objects become misses", async () => {
  const f = setup(),
    source = await f.run({ caches: [{ ...spec, key: "base" }] });
  await f.save(source);
  f.finish(source);
  const consumer = await f.run({
    caches: [
      { ...spec, key: "new", key_files: ["lock"], fallback_keys: ["base"] },
    ],
  });
  const hit = await readCache(f.env, consumer, "deps");
  assert.ok(hit);
  await hit.object.body?.cancel();
  f.objects.clear();
  assert.equal(await readCache(f.env, consumer, "deps"), null);
});
test("cache clear rechecks permissions and generation atomically with audit; metadata contains no storage keys or values", async () => {
  const f = setup(),
    source = await f.run();
  await f.save(source);
  f.finish(source);
  const app = new Hono<any>();
  let actor = "o";
  app.use("*", async (c, next) => {
    c.set("user", { id: actor, username: actor, admin: 0 });
    await next();
  });
  app.onError((e, c) =>
    c.json({ error: e.message }, e instanceof HTTPException ? e.status : 400),
  );
  registerCacheRoutes(app, {
    access: async () => f.repo,
    lease: async () => ({ run: source }),
  });
  const request = (generation: number) =>
    app.request(
      "http://test/api/repos/owner/repo/ci/caches/clear",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ generation }),
      },
      f.env,
    );
  const meta = (await (
    await app.request("http://test/api/repos/owner/repo/ci/caches", {}, f.env)
  ).json()) as any;
  assert.equal(meta.entries.length, 1);
  assert.equal(meta.entries[0].object_key, undefined);
  assert.equal(meta.entries[0].checksum, undefined);
  assert.equal((await request(0)).status, 200);
  assert.equal((await request(0)).status, 409);
  actor = "a";
  assert.equal((await request(1)).status, 409);
  f.db.exec("UPDATE members SET role='maintainer' WHERE user_id='a'");
  assert.equal((await request(1)).status, 200);
  f.db.exec("UPDATE users SET disabled=1 WHERE id='a'");
  assert.equal((await request(2)).status, 409);
  assert.equal(
    f.db
      .prepare("SELECT COUNT(*) n FROM audit WHERE action='ci.cache.clear'")
      .get()!.n,
    2,
  );
});
