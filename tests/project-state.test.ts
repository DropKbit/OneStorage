import { saveCloudOutput } from "../src/cloud-ci";
import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support/review-fixture";
import {
  changeProjectState,
  assertRepositoryWritable,
  archivedApiWrite,
} from "../src/project-state";
import { enqueueRun, claimRun, triggerPush } from "../src/ci";
import { scheduleSync, consumeSync } from "../src/sync";
import { pipelineSchema } from "../src/ci";
function setup() {
  const f = fixture();
  f.db
    .exec(`INSERT INTO issues(id,repo_id,author_id,title) VALUES(1,'r','a','Existing');
  INSERT INTO labels VALUES('label','r','One','abcdef');
  INSERT INTO issue_labels VALUES(1,'label');
  INSERT INTO comments(issue_id,author_id,body) VALUES(1,'a','Existing comment');
  INSERT INTO ci_runs(id,repo_id,ref,sha,config,trigger,status,lease_hash,lease_until) VALUES('running','r','main','sha','{}','manual','running','lease',9999999999999),('queued','r','main','sha','{}','manual','queued',NULL,NULL),('done','r','main','sha','{}','manual','succeeded',NULL,NULL);
  INSERT INTO ci_artifacts(id,run_id,name,size,object_key) VALUES('artifact','done','result',2,'key');
  INSERT INTO deployments(id,repo_id,run_id,environment,sha,object_key) VALUES('deployment','r','done','production','sha','bundle');
  INSERT INTO environments VALUES('r','production','deployment',1,datetime('now'));
  INSERT INTO sync_jobs(id,repo_id,direction) VALUES('sync','r','pull');`);
  const current = () =>
    f.db.prepare("SELECT * FROM repositories WHERE id='r'").get() as any;
  return { ...f, current };
}
test("archive atomically freezes a project and cancels leases, preserves history/application, and restoring does not resurrect canceled jobs", async () => {
  const f = setup();
  const archived: any = await changeProjectState(f.env, "r", "o", true, 0);
  assert.ok(archived.archived_at);
  assert.equal(archived.lifecycle_revision, 1);
  for (const id of ["running", "queued"]) {
    const row = f.db.prepare("SELECT * FROM ci_runs WHERE id=?").get(id)!;
    assert.equal(row.status, "canceled");
    assert.equal(row.lease_hash, null);
  }
  assert.equal(
    f.db.prepare("SELECT status FROM ci_runs WHERE id='done'").get()!.status,
    "succeeded",
  );
  assert.equal(
    f.db.prepare("SELECT status FROM sync_jobs WHERE id='sync'").get()!.status,
    "cancelled",
  );
  assert.equal(
    f.db
      .prepare("SELECT deployment_id FROM environments WHERE repo_id='r'")
      .get()!.deployment_id,
    "deployment",
  );
  assert.equal(
    f.db.prepare("SELECT COUNT(*) AS n FROM ci_artifacts").get()!.n,
    1,
  );
  await assert.rejects(
    changeProjectState(f.env, "r", "o", false, 0),
    /state or ownership changed/,
  );
  assert.ok(f.current().archived_at);
  await changeProjectState(f.env, "r", "o", false, 1);
  assert.equal(f.current().archived_at, null);
  assert.equal(f.current().lifecycle_revision, 2);
  assert.equal(
    f.db.prepare("SELECT status FROM ci_runs WHERE id='running'").get()!.status,
    "canceled",
  );
  f.db.prepare("UPDATE issues SET title='Restored' WHERE id=1").run();
  assert.equal(
    f.db.prepare("SELECT COUNT(*) AS n FROM mutation_guards").get()!.n,
    0,
  );
  assert.equal(
    f.db
      .prepare("SELECT COUNT(*) AS n FROM audit WHERE action LIKE 'repo.%'")
      .get()!.n,
    2,
  );
});
test("current namespace ownership and disabled status are revalidated inside the archive transaction", async () => {
  const f = setup();
  await assert.rejects(
    changeProjectState(f.env, "r", "d", true, 0),
    /ownership changed/,
  );
  f.db.exec(
    "INSERT INTO workspaces(id,slug,name) VALUES('space','space','Space');INSERT INTO workspace_members VALUES('space','d','owner');UPDATE repositories SET workspace_id='space',namespace='space' WHERE id='r'",
  );
  await assert.rejects(
    changeProjectState(f.env, "r", "o", true, 0),
    /ownership changed/,
  );
  await changeProjectState(f.env, "r", "d", true, 0);
  f.db.exec("UPDATE users SET disabled=1 WHERE id='d'");
  await assert.rejects(
    changeProjectState(f.env, "r", "d", false, 1),
    /ownership changed/,
  );
  assert.ok(f.current().archived_at);
});
test("D1 archive guards reject stale collaboration, policy, environment and CI writes with full rollback; delete GC can still cascade", async () => {
  const f = setup();
  await changeProjectState(f.env, "r", "o", true, 0);
  const blocked = [
    "UPDATE issues SET title='Late' WHERE id=1",
    "INSERT INTO issues(repo_id,author_id,title) VALUES('r','a','Late')",
    "INSERT INTO comments(issue_id,author_id,body) VALUES(1,'a','Late')",
    "DELETE FROM comments WHERE issue_id=1",
    "DELETE FROM labels WHERE id='label'",
    "DELETE FROM issue_labels WHERE issue_id=1",
    "UPDATE merge_requests SET state='closed' WHERE id=1",
    "INSERT INTO merge_reviews(mr_id,user_id,source_sha,target_sha,verdict) VALUES(1,'d','src','dst','approve')",
    "DELETE FROM branch_protections WHERE repo_id='r'",
    "INSERT INTO wiki_pages(repo_id,slug,title,body,author_id) VALUES('r','home','Wiki','','a')",
    "UPDATE repositories SET visibility='public' WHERE id='r'",
    "UPDATE environments SET deployment_id=NULL WHERE repo_id='r'",
    "INSERT INTO ci_logs VALUES('running',0,'Late')",
    "INSERT INTO ci_artifacts VALUES('late','running','late',1,'late')",
    "UPDATE ci_runs SET status='succeeded' WHERE id='running'",
    "UPDATE sync_jobs SET status='pending' WHERE id='sync'",
  ];
  for (const sql of blocked)
    assert.throws(() => f.db.prepare(sql).run(), /Repository archived/, sql);
  await assert.rejects(
    f.env.DB.batch([
      f.env.DB.prepare(
        "INSERT INTO audit(repo_id,action) VALUES('r','should.rollback')",
      ),
      f.env.DB.prepare("UPDATE issues SET title='Late' WHERE id=1"),
    ]),
    /Repository archived/,
  );
  assert.equal(
    f.db
      .prepare("SELECT COUNT(*) AS n FROM audit WHERE action='should.rollback'")
      .get()!.n,
    0,
  );
  f.db.prepare("UPDATE issues SET title='Other' WHERE repo_id='other'").run();
  // Security access revocation and personal subscriptions are allowed while archived.
  f.db.prepare("DELETE FROM members WHERE repo_id='r' AND user_id='a'").run();
  f.db.prepare("INSERT INTO repository_stars VALUES('r','o')").run();
  f.db
    .prepare("UPDATE repositories SET deleted_at=datetime('now') WHERE id='r'")
    .run();
  f.db.prepare("DELETE FROM repositories WHERE id='r'").run();
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM issues").get()!.n, 0);
  assert.equal(
    f.db.prepare("SELECT COUNT(*) AS n FROM ci_artifacts").get()!.n,
    0,
  );
});
test("a writer authorized immediately before archival is stopped at the database boundary", async () => {
  const f = setup();
  const statement = f.env.DB.prepare(
    "INSERT INTO comments(issue_id,author_id,body) VALUES(1,'a','In flight')",
  );
  await changeProjectState(f.env, "r", "o", true, 0);
  await assert.rejects(statement.run(), /Repository archived/);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM comments").get()!.n, 1);
});
test("serialized Git archive barrier blocks every mutation family while allowing clone, search, archive export and fork export", () => {
  const f = setup();
  const repo = { ...f.repo, archived_at: "now" };
  for (const path of [
    "/git/git-receive-pack",
    "/commit-files",
    "/commit-pack",
    "/diff-commit",
    "/restore-commit",
    "/reset-commits",
    "/branches/create",
    "/tags/create",
    "/notes/write",
    "/merge",
    "/merge-advanced",
    "/review-merge",
    "/review-update",
    "/internal/merge-import",
    "/internal/sync",
    "/internal/default-branch",
    "/internal/configure-upstream",
    "/internal/fork-install",
  ])
    assert.throws(
      () =>
        assertRepositoryWritable(
          repo,
          new Request("https://repo" + path, { method: "POST" }),
        ),
      /Repository archived/,
      path,
    );
  assert.throws(
    () =>
      assertRepositoryWritable(
        repo,
        new Request("https://repo/internal/lfs/oid", { method: "PUT" }),
      ),
    /Repository archived/,
  );
  assert.throws(
    () =>
      assertRepositoryWritable(
        repo,
        new Request("https://repo/git/info/refs?service=git-receive-pack"),
      ),
    /Repository archived/,
  );
  for (const path of [
    "/git/git-upload-pack",
    "/grep",
    "/archive",
    "/internal/fork-export",
    "/internal/lifecycle",
    "/internal/delete",
  ])
    assert.doesNotThrow(() =>
      assertRepositoryWritable(
        repo,
        new Request("https://repo" + path, { method: "POST" }),
      ),
    );
  assert.doesNotThrow(() =>
    assertRepositoryWritable(repo, new Request("https://repo/file")),
  );
  assert.equal(archivedApiWrite("POST", "issues/1/comments"), true);
  assert.equal(archivedApiWrite("POST", "archive"), false);
  assert.equal(archivedApiWrite("PUT", "lifecycle"), false);
});
test("archived projects cannot start or claim pipelines or sync jobs, and delayed push events do not create CI runs", async () => {
  const f = setup();
  await changeProjectState(f.env, "r", "o", true, 0);
  const config = pipelineSchema.parse({
    name: "Build",
    runner: "external",
    steps: [{ type: "run", name: "Build", command: "echo test" }],
  });
  await assert.rejects(
    enqueueRun(f.env, f.repo, "main", "a".repeat(40), config, "manual", "o"),
    /archived/,
  );
  assert.equal(
    await enqueueRun(
      f.env,
      f.repo,
      "main",
      "a".repeat(40),
      config,
      "push",
      null,
      "old-event",
    ),
    null,
  );
  assert.equal(await claimRun(f.env, "r", "runner", "external"), null);
  await assert.rejects(
    scheduleSync(f.env, { ...f.repo, base_repo: "{}" }),
    /archived/,
  );
  await triggerPush(f.env, {
    id: "old-event",
    event: "push",
    repository_id: "r",
    ref: "refs/heads/main",
    after: "a".repeat(40),
  });
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM ci_runs").get()!.n, 3);
});

test("archiving during an R2 artifact upload revokes publication and cleans the unpublished object", async () => {
  const f = setup();
  const data = new Map<string, unknown>();
  f.env.OBJECTS = {
    put: async (key: string, value: unknown) => {
      data.set(key, value);
      await changeProjectState(f.env, "r", "o", true, 0);
      return {};
    },
    delete: async (key: string) => {
      data.delete(key);
    },
  } as any;
  const run = f.db
    .prepare("SELECT * FROM ci_runs WHERE id='running'")
    .get() as any;
  await saveCloudOutput(f.env, f.repo, run, {
    "test.txt": { content: "unpublished" },
  });
  assert.equal(data.size, 0);
  assert.equal(
    f.db
      .prepare("SELECT COUNT(*) AS n FROM ci_artifacts WHERE run_id='running'")
      .get()!.n,
    0,
  );
  assert.equal(
    f.db.prepare("SELECT status FROM ci_runs WHERE id='running'").get()!.status,
    "canceled",
  );
});

test("an upstream result arriving after archive and restore cannot resurrect a canceled synchronization", async () => {
  const f = setup();
  f.env.REPOSITORIES = {
    idFromName: (id: string) => id,
    get: () => ({
      fetch: async () => {
        await changeProjectState(f.env, "r", "o", true, 0);
        await changeProjectState(f.env, "r", "o", false, 1);
        return Response.json({ ok: true });
      },
    }),
  } as any;
  f.db.prepare("UPDATE sync_jobs SET lease_until=0 WHERE id='sync'").run();
  assert.equal(await consumeSync(f.env, "sync"), true);
  assert.equal(
    f.db.prepare("SELECT status FROM sync_jobs WHERE id='sync'").get()!.status,
    "cancelled",
  );
});
