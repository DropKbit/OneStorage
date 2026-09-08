import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support/review-fixture";
import { transferProject, repositoryAt } from "../src/project-transfer";
import { projectDatabase, unguardDatabase } from "../src/project-db";
import { assertProjectRevision } from "../src/project-state";
import { repositoryRole } from "../src/access";
function setup() {
  const f = fixture();
  f.db
    .exec(`INSERT INTO workspaces(id,slug,name) VALUES('source','source','Source'),('target','target','Target');
 INSERT INTO workspace_members VALUES('source','o','owner'),('source','a','developer'),('target','o','owner'),('target','g','reader');
 UPDATE repositories SET namespace='source',workspace_id='source' WHERE id='r';
 DELETE FROM members WHERE repo_id='r' AND user_id='a';
 INSERT INTO issues(id,repo_id,author_id,title) VALUES(1,'r','a','Preserved');
 INSERT INTO ci_pipelines VALUES('r','{}',1,datetime('now'));
 INSERT INTO ci_runs(id,repo_id,ref,sha,config,trigger,status,lease_hash,lease_until) VALUES('running','r','main','sha','{}','manual','running','lease',9999999999999),('done','r','main','sha','{}','manual','succeeded',NULL,NULL);
 INSERT INTO ci_runners(id,repo_id,name,token_hash) VALUES('runner','r','Runner','hash');
 INSERT INTO git_credentials(id,repo_id,encrypted) VALUES('credential','r','cipher');
 INSERT INTO webhooks(id,repo_id,url,secret) VALUES('hook','r','https://example.invalid','secret');
 INSERT INTO deliveries(id,webhook_id,payload) VALUES('event','hook','{}');
 INSERT INTO sync_jobs(id,repo_id,direction) VALUES('sync','r','pull');
 INSERT INTO deployments(id,repo_id,run_id,environment,sha,object_key) VALUES('deploy','r','done','production','sha','bundle');
 INSERT INTO environments VALUES('r','production','deploy',1,datetime('now'));`);
  const current = () =>
    f.db.prepare("SELECT * FROM repositories WHERE id='r'").get() as any;
  return { ...f, current };
}
test("transfer preserves UUID and collaboration/history while changing inherited access and retiring previous integrations", async () => {
  const f = setup();
  const before = f.current();
  const result = await transferProject(
    f.env,
    before,
    "o",
    "target",
    "renamed",
    0,
  );
  assert.equal(result!.id, "r");
  assert.equal(result!.namespace, "target");
  assert.equal(result!.workspace_id, "target");
  assert.equal(result!.lifecycle_revision, 1);
  assert.equal(
    await repositoryRole(f.env, result!, {
      id: "a",
      username: "author",
      admin: 0,
    }),
    "guest",
  );
  assert.equal(
    await repositoryRole(f.env, result!, {
      id: "g",
      username: "guest",
      admin: 0,
    }),
    "reader",
  );
  assert.equal(
    await repositoryRole(f.env, result!, {
      id: "d",
      username: "dev",
      admin: 0,
    }),
    "developer",
  );
  assert.equal(
    f.db.prepare("SELECT title FROM issues WHERE id=1").get()!.title,
    "Preserved",
  );
  assert.equal(
    f.db
      .prepare("SELECT COUNT(*) AS n FROM merge_requests WHERE repo_id='r'")
      .get()!.n,
    1,
  );
  for (const table of [
    "ci_runners",
    "git_credentials",
    "webhooks",
    "deliveries",
  ])
    assert.equal(
      f.db.prepare("SELECT COUNT(*) AS n FROM " + table).get()!.n,
      0,
      table,
    );
  assert.equal(
    f.db.prepare("SELECT status FROM ci_runs WHERE id='running'").get()!.status,
    "canceled",
  );
  assert.equal(
    f.db.prepare("SELECT status FROM ci_runs WHERE id='done'").get()!.status,
    "succeeded",
  );
  assert.equal(
    f.db.prepare("SELECT enabled FROM ci_pipelines WHERE repo_id='r'").get()!
      .enabled,
    0,
  );
  assert.equal(
    f.db.prepare("SELECT public FROM environments WHERE repo_id='r'").get()!
      .public,
    0,
  );
  assert.equal(
    f.db
      .prepare("SELECT deployment_id FROM environments WHERE repo_id='r'")
      .get()!.deployment_id,
    "deploy",
  );
  assert.equal((await repositoryAt(f.env, "source", "repo"))!.repo.id, "r");
  assert.equal((await repositoryAt(f.env, "source", "repo"))!.moved, true);
  await assert.rejects(
    transferProject(f.env, before, "o", "owner", "repo", 0),
    /ownership changed/,
  );
  assert.throws(
    () =>
      f.db
        .prepare(
          "INSERT INTO repositories(id,owner_id,namespace,name,visibility) VALUES('hijack','o','source','repo','private')",
        )
        .run(),
    /address reserved/,
  );
});
test("name conflicts roll back archive state, credentials, leases and aliases; transferring an archived repository preserves the freeze", async () => {
  const f = setup();
  f.db.exec(
    "UPDATE repositories SET archived_at='2026-09-01' WHERE id='r';INSERT INTO repositories(id,owner_id,namespace,name,visibility) VALUES('conflict','o','target','taken','private')",
  );
  await assert.rejects(
    transferProject(f.env, f.current(), "o", "target", "taken", 0),
    /already in use/,
  );
  assert.equal(f.current().archived_at, "2026-09-01");
  assert.equal(f.current().namespace, "source");
  assert.equal(
    f.db.prepare("SELECT COUNT(*) AS n FROM git_credentials").get()!.n,
    1,
  );
  assert.equal(
    f.db.prepare("SELECT COUNT(*) AS n FROM repository_aliases").get()!.n,
    0,
  );
  const result = await transferProject(
    f.env,
    f.current(),
    "o",
    "target",
    "renamed",
    0,
  );
  assert.equal(result!.archived_at, "2026-09-01");
  await transferProject(f.env, f.current(), "o", "source", "repo", 1);
  assert.equal(
    (await repositoryAt(f.env, "target", "renamed"))!.repo.namespace,
    "source",
  );
  assert.equal((await repositoryAt(f.env, "source", "repo"))!.moved, false);
});
test("source and target ownership are both required and checked inside the transfer transaction", async () => {
  const f = setup();
  await assert.rejects(
    transferProject(f.env, f.current(), "a", "target", "renamed", 0),
    /Destination/,
  );
  f.db.exec("INSERT INTO workspace_members VALUES('target','a','owner')");
  await assert.rejects(
    transferProject(f.env, f.current(), "a", "target", "renamed", 0),
    /ownership changed/,
  );
  const batch = f.env.DB.batch.bind(f.env.DB);
  let revoke = true;
  f.env.DB.batch = async (statements: any[]) => {
    if (revoke) {
      revoke = false;
      f.db
        .prepare(
          "DELETE FROM workspace_members WHERE workspace_id='target' AND user_id='o'",
        )
        .run();
    }
    return batch(statements);
  };
  await assert.rejects(
    transferProject(f.env, f.current(), "o", "target", "renamed", 0),
    /ownership changed/,
  );
  assert.equal(f.current().namespace, "source");
});
test("request database wrapper preserves RETURNING results, batches and immutable bindings; stale writers roll back after transfer", async () => {
  const f = setup(),
    db = projectDatabase(f.env.DB, "r", 0);
  assert.equal(unguardDatabase(db), f.env.DB);
  const first = await db
    .prepare(
      "INSERT INTO comments(issue_id,author_id,body) VALUES(1,'a',?) RETURNING id,body",
    )
    .bind("First")
    .first<any>();
  assert.equal(first.body, "First");
  const prepared = db.prepare(
    "UPDATE issues SET title=? WHERE id=1 RETURNING title",
  );
  assert.equal(await prepared.bind("A").first("title"), "A");
  assert.equal(await prepared.bind("B").first("title"), "B");
  const b = await db.batch([
    db.prepare("UPDATE issues SET title='C' WHERE id=1 RETURNING title"),
    db.prepare("SELECT title FROM issues WHERE id=1"),
  ]);
  assert.equal((b[0].results[0] as any).title, "C");
  assert.equal((b[1].results[0] as any).title, "C");
  const stale = db.prepare(
    "INSERT INTO comments(issue_id,author_id,body) VALUES(1,'a','Stale') RETURNING id",
  );
  await transferProject(f.env, f.current(), "o", "target", "renamed", 0);
  await assert.rejects(stale.first(), /moved or lifecycle changed/);
  await assert.rejects(
    db.batch([
      db.prepare("INSERT INTO audit(repo_id,action) VALUES('r','bad')"),
      db.prepare("UPDATE issues SET title='Stale' WHERE id=1"),
    ]),
    /moved or lifecycle changed/,
  );
  assert.equal(
    f.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='bad'").get()!.n,
    0,
  );
  assert.equal(
    f.db.prepare("SELECT title FROM issues WHERE id=1").get()!.title,
    "C",
  );
  assert.equal(
    f.db.prepare("SELECT COUNT(*) AS n FROM mutation_guards").get()!.n,
    0,
  );
  const newDb = projectDatabase(f.env.DB, "r", 1);
  await newDb.prepare("UPDATE issues SET title='New owner' WHERE id=1").run();
  // Independent requests never share mutable authorization state.
  await assert.rejects(
    db.prepare("DELETE FROM issues WHERE id=1").run(),
    /moved or lifecycle changed/,
  );
  assert.throws(
    () =>
      assertProjectRevision(
        f.current(),
        new Request("https://repo/commit", {
          method: "POST",
          headers: { "x-lifecycle-revision": "0" },
        }),
      ),
    /moved or lifecycle changed/,
  );
});

test("renaming within the same namespace preserves integrations, running leases and public deployment while advancing address authorization", async () => {
  const f = setup();
  f.db
    .prepare("UPDATE repositories SET base_repo=?,owner_id='a' WHERE id='r'")
    .run('{"provider":"generic","url":"https://example.invalid/repo.git"}');
  const before = f.current();
  const result = await transferProject(
    f.env,
    before,
    "o",
    "source",
    "newname",
    0,
  );
  assert.equal(result!.base_repo, before.base_repo);
  assert.equal(result!.owner_id, "a");
  assert.equal(result!.lifecycle_revision, 1);
  assert.equal(
    f.db.prepare("SELECT status FROM ci_runs WHERE id='running'").get()!.status,
    "running",
  );
  assert.equal(
    f.db.prepare("SELECT public FROM environments WHERE repo_id='r'").get()!
      .public,
    1,
  );
  for (const table of [
    "ci_runners",
    "git_credentials",
    "webhooks",
    "deliveries",
  ])
    assert.equal(
      f.db.prepare("SELECT COUNT(*) AS n FROM " + table).get()!.n,
      1,
      table,
    );
  assert.equal(
    f.db
      .prepare("SELECT lifecycle_revision FROM sync_jobs WHERE id='sync'")
      .get()!.lifecycle_revision,
    1,
  );
  assert.equal(
    f.db.prepare("SELECT action FROM audit ORDER BY id DESC LIMIT 1").get()!
      .action,
    "repo.rename",
  );
});
