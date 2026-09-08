import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support/review-fixture";
import { publishPackage, collectPackages } from "../src/packages";
import { digest } from "../src/security";
import type { PackageSpec } from "../src/package-schema";
async function setup() {
  const f = fixture(),
    bytes = new TextEncoder().encode("package content");
  f.db
    .prepare(
      "INSERT INTO credentials(hash,id,user_id,name,kind,expires_at) VALUES('pub','pub','o','package publisher','pat',?)",
    )
    .run(Date.now() + 600000);
  const actor = { id: "o", credential: "pub", revision: 0 },
    spec: PackageSpec = {
      kind: "generic",
      name: "tool",
      version: "1.0.0",
      filename: "tool.zip",
      size: bytes.length,
      sha256: await digest(bytes),
    };
  const objects = new Map<string, Uint8Array>();
  f.env.OBJECTS = {
    put: async (key: string, data: Uint8Array) => {
      objects.set(key, data);
      return {};
    },
    delete: async (key: string) => {
      objects.delete(key);
    },
  } as any;
  const put = async (key: string) => {
    objects.set(key, bytes);
  };
  return { ...f, actor, spec, objects, put, bytes };
}
test("package data precedes immutable metadata, multiple generic files share a version, and duplicate addresses cannot overwrite", async () => {
  const f = await setup();
  let invisible = false;
  const first = (await publishPackage(
    f.env,
    f.repo,
    f.actor,
    f.spec,
    async (key) => {
      invisible =
        f.db.prepare("SELECT count(*) n FROM package_files").get()!.n === 0;
      await f.put(key);
    },
  )) as any;
  assert.ok(invisible);
  assert.equal(first.sha256, f.spec.sha256);
  assert.equal(first.object_key, undefined);
  await publishPackage(
    f.env,
    f.repo,
    f.actor,
    { ...f.spec, filename: "symbols.zip" },
    f.put,
  );
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM package_versions").get()!.n,
    1,
  );
  assert.equal(f.objects.size, 2);
  await assert.rejects(
    publishPackage(f.env, f.repo, f.actor, f.spec, f.put),
    /exists|reserved/,
  );
  assert.equal(f.objects.size, 2);
});
test("npm versions are immutable and publication atomically creates distribution tags", async () => {
  const f = await setup();
  const spec = {
    ...f.spec,
    kind: "npm" as const,
    name: "@team/demo",
    filename: "demo-1.0.0.tgz",
    metadata: { name: "@team/demo", version: "1.0.0" },
    tags: ["latest", "stable"],
  };
  await publishPackage(f.env, f.repo, f.actor, spec, f.put);
  assert.equal(f.db.prepare("SELECT count(*) n FROM package_tags").get()!.n, 2);
  await assert.rejects(
    publishPackage(
      f.env,
      f.repo,
      f.actor,
      { ...spec, filename: "different.tgz" },
      f.put,
    ),
    /exists|Noncanonical/,
  );
  f.db.prepare("UPDATE package_versions SET deleted_at=?").run(Date.now());
  assert.equal(f.db.prepare("SELECT count(*) n FROM package_tags").get()!.n, 0);
  await assert.rejects(
    publishPackage(f.env, f.repo, f.actor, spec, f.put),
    /exists/,
  );
  await collectPackages(f.env);
  assert.equal(f.objects.size, 0);
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM package_versions").get()!.n,
    1,
  );
});
test("upload failure and permissions changing during R2 I/O never expose a package", async () => {
  for (const mode of [
    "io",
    "credential",
    "disabled",
    "member",
    "transfer",
    "archive",
  ]) {
    const f = await setup();
    if (mode === "member") {
      f.db.prepare("UPDATE repositories SET owner_id='a' WHERE id='r'").run();
      f.db.prepare("INSERT INTO members VALUES('r','o','developer')").run();
    }
    await assert.rejects(
      publishPackage(f.env, f.repo, f.actor, f.spec, async (key) => {
        await f.put(key);
        if (mode === "io") throw Error("storage failure");
        if (mode === "credential")
          f.db.prepare("DELETE FROM credentials WHERE hash='pub'").run();
        if (mode === "disabled")
          f.db.prepare("UPDATE users SET disabled=1 WHERE id='o'").run();
        if (mode === "member")
          f.db.prepare("DELETE FROM members WHERE user_id='o'").run();
        if (mode === "transfer")
          f.db
            .prepare(
              "UPDATE repositories SET namespace='changed',lifecycle_revision=lifecycle_revision+1 WHERE id='r'",
            )
            .run();
        if (mode === "archive")
          f.db
            .prepare(
              "UPDATE repositories SET archived_at=datetime('now'),lifecycle_revision=lifecycle_revision+1 WHERE id='r'",
            )
            .run();
      }),
      /storage failure|authorization/,
    );
    assert.equal(
      f.db.prepare("SELECT count(*) n FROM package_files").get()!.n,
      0,
    );
    assert.equal(f.objects.size, 0);
  }
});
test("expired upload reservation is retired before deletion and retains a replay cleanup record for late R2 completion", async () => {
  const f = await setup();
  await assert.rejects(
    publishPackage(f.env, f.repo, f.actor, f.spec, async (key) => {
      f.db.prepare("UPDATE package_uploads SET expires_at=0").run();
      await collectPackages(f.env);
      assert.equal(
        f.db.prepare("SELECT state FROM package_uploads").get()!.state,
        "retired",
      );
      await f.put(key);
    }),
    /authorization/,
  );
  assert.equal(f.objects.size, 0);
  const now = Date.now(),
    key = "packages/r/late";
  f.db
    .prepare(
      "INSERT INTO package_uploads(id,repo_id,kind,name,version,filename,object_key,size,state,created_at,expires_at) VALUES('late','r','generic','x','1','x',?,1,'uploading',0,0)",
    )
    .run(key);
  await collectPackages(f.env);
  f.objects.set(key, new Uint8Array([1]));
  await collectPackages(f.env);
  assert.equal(f.objects.size, 0);
  assert.ok(
    Number(
      f.db
        .prepare("SELECT retire_after FROM package_uploads WHERE id='late'")
        .get()!.retire_after,
    ) > now,
  );
});
test("ambiguous committed publication response preserves the published object", async () => {
  const f = await setup(),
    original = f.env.DB.batch.bind(f.env.DB);
  let lost = false;
  f.env.DB.batch = async <T>(statements: D1PreparedStatement[]) => {
    const result = await original<T>(statements);
    if (!lost) {
      lost = true;
      throw Error("lost response after commit");
    }
    return result;
  };
  const result = (await publishPackage(
    f.env,
    f.repo,
    f.actor,
    f.spec,
    f.put,
  )) as any;
  assert.ok(result.id);
  assert.equal(f.objects.size, 1);
  await collectPackages(f.env);
  assert.equal(f.objects.size, 1);
});
test("repository deletion keeps an independent object cleanup inventory", async () => {
  const f = await setup();
  await publishPackage(f.env, f.repo, f.actor, f.spec, f.put);
  f.db.prepare("DELETE FROM repositories WHERE id='r'").run();
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM package_files").get()!.n,
    0,
  );
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM package_uploads").get()!.n,
    1,
  );
  await collectPackages(f.env);
  assert.equal(f.objects.size, 0);
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM package_uploads").get()!.n,
    0,
  );
});
test("package publish requires current developer authority and a live write session or PAT", async () => {
  for (const mode of ["guest", "read", "expired", "jwt"]) {
    const f = await setup();
    if (mode === "guest")
      f.db.prepare("UPDATE repositories SET owner_id='a' WHERE id='r'").run();
    if (mode === "read")
      f.db
        .prepare("UPDATE credentials SET scope='read' WHERE hash='pub'")
        .run();
    if (mode === "expired")
      f.db
        .prepare("UPDATE credentials SET expires_at=0 WHERE hash='pub'")
        .run();
    if (mode === "jwt") f.actor.credential = "not-a-credential";
    let wrote = false;
    await assert.rejects(
      publishPackage(f.env, f.repo, f.actor, f.spec, async () => {
        wrote = true;
      }),
    );
    assert.equal(wrote, false);
    assert.equal(f.objects.size, 0);
  }
});
test("npm tag cap rolls back publication and cleanup cannot delete live published objects", async () => {
  const f = await setup(),
    spec = {
      ...f.spec,
      kind: "npm" as const,
      name: "demo",
      filename: "demo-1.0.0.tgz",
      metadata: { name: "demo", version: "1.0.0" },
      tags: Array.from({ length: 32 }, (_, n) => "tag-" + n),
    };
  await publishPackage(f.env, f.repo, f.actor, spec, f.put);
  await assert.rejects(
    publishPackage(
      f.env,
      f.repo,
      f.actor,
      {
        ...spec,
        version: "2.0.0",
        filename: "demo-2.0.0.tgz",
        tags: ["extra"],
      },
      f.put,
    ),
  );
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM package_versions").get()!.n,
    1,
  );
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM package_tags").get()!.n,
    32,
  );
  assert.equal(f.objects.size, 1);
  f.db
    .prepare("UPDATE package_uploads SET state='retired',retire_after=0")
    .run();
  await collectPackages(f.env);
  assert.equal(f.objects.size, 1);
});
