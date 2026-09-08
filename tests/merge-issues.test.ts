import test from "node:test";
import assert from "node:assert/strict";
import {
  closingIssueIds,
  plannedIssueClosures,
  projectMerge,
} from "../src/merge-issues";
import { fixture } from "./support/review-fixture";
test("closing patterns accept local references and lists while excluding code, quotes, URLs and ordinary mentions", () => {
  assert.deepEqual(
    closingIssueIds(
      "Closes #1, #2 and #3. FIXES: #4\n\nResolves #5\n\nMention #6\n\n`Fixes #7`\n\n> Closes #8\n\n```\nFixes #9\n```\n\nFixes other/repo#10\n\nFixes https://host/issues/11\n\n<!-- Fixes #12 -->",
    ),
    [1, 2, 3, 4, 5],
  );
  assert.throws(
    () =>
      closingIssueIds(
        "Fixes " +
          Array.from({ length: 101 }, (_, i) => "#" + (i + 1)).join(", "),
      ),
    /100/,
  );
});
test("issue plans include new commit messages and MR prose only for default target, filtering unrelated projects and old history", async () => {
  const f = fixture();
  f.db.exec(
    "INSERT INTO issues(id,repo_id,author_id,title) VALUES(1,'r','a','one'),(2,'r','a','two'),(3,'other','o','private'),(4,'r','a','old')",
  );
  const target = await f.commit({ a: "1" }, undefined, "Fixes #4"),
    source = await f.commit({ a: "2" }, target, "Fixes #2 and #3"),
    mr = f.mr(source, target, "Closes #1, #1");
  assert.deepEqual(
    await plannedIssueClosures(f.env, f.repo, mr, f.store, "main"),
    [1, 2],
  );
  assert.deepEqual(
    await plannedIssueClosures(f.env, f.repo, mr, f.store, "release"),
    [],
  );
});
test("merge projection atomically closes scoped issues once; replay repairs MR but preserves manual reopens and produces no duplicate comments/notifications", async () => {
  const f = fixture();
  f.db.exec(
    "INSERT INTO issues(id,repo_id,author_id,title) VALUES(1,'r','a','one'),(2,'other','o','unrelated');INSERT INTO repository_watches VALUES('r','d')",
  );
  const result = { sha: "a".repeat(40), issue_ids: [1, 2], actor_id: "o" };
  await projectMerge(f.env, "r", 1, result);
  assert.equal(
    f.db.prepare("SELECT state FROM issues WHERE id=1").get()!.state,
    "closed",
  );
  assert.equal(
    f.db.prepare("SELECT state FROM issues WHERE id=2").get()!.state,
    "open",
  );
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM comments").get()!.n, 1);
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM notifications").get()!.n,
    1,
  );
  f.db.exec(
    "UPDATE issues SET state='open' WHERE id=1;UPDATE merge_requests SET state='open',merged_sha=NULL WHERE id=1",
  );
  await projectMerge(f.env, "r", 1, result);
  assert.equal(
    f.db.prepare("SELECT state FROM issues WHERE id=1").get()!.state,
    "open",
  );
  assert.equal(
    f.db.prepare("SELECT state FROM merge_requests WHERE id=1").get()!.state,
    "merged",
  );
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM comments").get()!.n, 1);
});
test("failed D1 closure projection rolls back MR and issue changes; a later replay succeeds", async () => {
  const f = fixture();
  f.db.exec(
    "INSERT INTO issues(id,repo_id,author_id,title) VALUES(1,'r','a','one');CREATE TRIGGER reject_close BEFORE INSERT ON comments BEGIN SELECT RAISE(ABORT,'simulated unavailable projection'); END",
  );
  const result = { sha: "b".repeat(40), issue_ids: [1], actor_id: "o" };
  await assert.rejects(projectMerge(f.env, "r", 1, result), /simulated/);
  assert.equal(
    f.db.prepare("SELECT state FROM issues WHERE id=1").get()!.state,
    "open",
  );
  assert.equal(
    f.db.prepare("SELECT state FROM merge_requests WHERE id=1").get()!.state,
    "open",
  );
  f.db.exec("DROP TRIGGER reject_close");
  await projectMerge(f.env, "r", 1, result);
  assert.equal(
    f.db.prepare("SELECT state FROM issues WHERE id=1").get()!.state,
    "closed",
  );
});
