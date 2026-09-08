import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support/review-fixture";
import {
  projectVersion,
  withProjectTransition,
  checkProjectVersion,
} from "../src/project-version";
import { changeProjectState } from "../src/project-state";
function setup() {
  const f = fixture(),
    values = new Map<string, unknown>();
  let failPut = false;
  const storage = {
    get: async (key: string) => values.get(key),
    put: async (key: string, value: unknown) => {
      if (failPut && key === "project-version")
        throw Error("durable storage failure");
      values.set(key, value);
    },
    delete: async (key: string) => values.delete(key),
  } as unknown as DurableObjectStorage;
  return {
    ...f,
    storage,
    values,
    failPut: (value: boolean) => {
      failPut = value;
    },
  };
}
test("DO version cache rejects queued GET and HEAD requests from before a lifecycle change", async () => {
  const f = setup();
  assert.equal(await projectVersion(f.env, f.storage, "r"), 0);
  await withProjectTransition(f.env, f.storage, "r", () =>
    changeProjectState(f.env, "r", "o", true, 0),
  );
  for (const method of ["GET", "HEAD", "POST"])
    await assert.rejects(
      checkProjectVersion(
        f.env,
        f.storage,
        "r",
        new Request("https://repo/file?ref=HEAD", {
          method,
          headers: { "x-lifecycle-revision": "0" },
        }),
      ),
      /reload before reading or writing/,
    );
  await checkProjectVersion(
    f.env,
    f.storage,
    "r",
    new Request("https://repo/file", {
      headers: { "x-lifecycle-revision": "1" },
    }),
  );
  const original = f.env.DB.prepare;
  f.env.DB.prepare = () => {
    throw Error("Warm cache must not query D1");
  };
  assert.equal(await projectVersion(f.env, f.storage, "r"), 1);
  f.env.DB.prepare = original;
});
test("D1 commit followed by failed durable cache update retains a recovery marker and never serves a stale version", async () => {
  const f = setup();
  assert.equal(await projectVersion(f.env, f.storage, "r"), 0);
  f.failPut(true);
  await assert.rejects(
    withProjectTransition(f.env, f.storage, "r", () =>
      changeProjectState(f.env, "r", "o", true, 0),
    ),
    /storage failure/,
  );
  assert.equal(f.values.get("project-version"), 0);
  assert.equal(f.values.get("project-transition"), true);
  assert.equal(
    (
      await f.env.DB.prepare(
        "SELECT lifecycle_revision FROM repositories WHERE id='r'",
      ).first<any>()
    ).lifecycle_revision,
    1,
  );
  await assert.rejects(
    projectVersion(f.env, f.storage, "r"),
    /storage failure/,
  );
  f.failPut(false);
  assert.equal(await projectVersion(f.env, f.storage, "r"), 1);
  assert.equal(f.values.has("project-transition"), false);
  await assert.rejects(
    checkProjectVersion(
      f.env,
      f.storage,
      "r",
      new Request("https://repo/file", {
        headers: { "x-lifecycle-revision": "0" },
      }),
    ),
    /reload before reading or writing/,
  );
});
test("a rejected lifecycle mutation restores the current cache and a fresh DO boot loads the persisted D1 version", async () => {
  const f = setup();
  await assert.rejects(
    withProjectTransition(f.env, f.storage, "r", () =>
      changeProjectState(f.env, "r", "d", true, 0),
    ),
    /ownership changed/,
  );
  assert.equal(await projectVersion(f.env, f.storage, "r"), 0);
  assert.equal(f.values.has("project-transition"), false);
  await withProjectTransition(f.env, f.storage, "r", () =>
    changeProjectState(f.env, "r", "o", true, 0),
  );
  f.values.clear();
  assert.equal(await projectVersion(f.env, f.storage, "r"), 1);
});
