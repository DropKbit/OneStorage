import test from "node:test";
import assert from "node:assert/strict";
import {
  ownerPattern,
  parseCodeowners,
  changedOwnerPaths,
} from "../src/codeowners";
import { reviewGate, protectRefs } from "../src/review";
import { fixture } from "./support/review-fixture";

test("CODEOWNERS path rules cover rooted, recursive, basename, escaped spaces and exclusions with linear-time matching", () => {
  for (const [pattern, yes, no] of [
    ["*.ts", "a/b.ts", "a/b.js"],
    ["/docs/**/*.md", "docs/a/b.md", "other/docs/a.md"],
    ["/docs/", "docs/a/b", "nested/docs/b"],
    ["**/README.md", "README.md", "README.txt"],
    ["a?b", "dir/acb", "dir/ab"],
  ]) {
    assert.equal(ownerPattern(pattern).matcher(yes).matches(), true);
    assert.equal(ownerPattern(pattern).matcher(no).matches(), false);
  }
  const parsed = parseCodeowners(
    "[Docs] @dev\ndocs/My\\ File.md\n!docs/generated/\n[docs][2] @owner\n*.md\n",
  );
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.rules[0].section.required, 2);
  assert.equal(
    parsed.rules[0].match.matcher("docs/My File.md").matches(),
    true,
  );
  assert.deepEqual(parsed.rules[0].owners, ["@dev"]);
  assert.deepEqual(parsed.rules[1].owners, []);
  assert.deepEqual(parsed.rules[2].owners, ["@owner"]);
  assert.equal(
    parseCodeowners("[bad][0]\n*.ts email@host\na[bc] @dev").errors.length,
    3,
  );
});
test("CODEOWNERS uses only the target snapshot, counts each last-match rule, expires reviews and rechecks membership", async () => {
  const f = fixture(),
    target = await f.commit({
      CODEOWNERS: "* @owner\n/src/ @dev\n",
      "src/code.ts": "one",
      "docs/a.md": "one",
    });
  const source = await f.commit(
      { CODEOWNERS: "* @author", "src/code.ts": "two", "docs/a.md": "one" },
      target,
    ),
    mr = f.mr(source, target);
  let gate = await reviewGate(f.env, f.repo, mr, f.store);
  assert.equal(gate.allowed, false);
  assert.deepEqual(
    gate.codeowners!.requirements.map((r) => r.owners),
    [["@owner"], ["@dev"]],
  );
  f.approve(source, target);
  assert.equal((await reviewGate(f.env, f.repo, mr, f.store)).allowed, false);
  f.approve(source, target, "o");
  assert.equal((await reviewGate(f.env, f.repo, mr, f.store)).allowed, true);
  f.db.exec("DELETE FROM members WHERE user_id='d'");
  assert.equal((await reviewGate(f.env, f.repo, mr, f.store)).allowed, false);
  f.db.exec(
    "INSERT INTO members VALUES('r','d','developer');UPDATE users SET disabled=1 WHERE id='d'",
  );
  assert.equal((await reviewGate(f.env, f.repo, mr, f.store)).allowed, false);
  f.db.exec("UPDATE users SET disabled=0");
  const newer = await f.commit(
    { CODEOWNERS: "* @author", "src/code.ts": "three" },
    source,
  );
  assert.equal(
    (await reviewGate(f.env, f.repo, f.mr(newer, target), f.store)).allowed,
    false,
  );
});
test("CODEOWNERS sections independently require multiple eligible owners and optional rules cannot block", async () => {
  const f = fixture(),
    code =
      "[Core][2] @owner @dev @author\n*.ts\n[Security] @owner\n*\n^[Docs] @missing\n*\n";
  const target = await f.commit({ CODEOWNERS: code, "a.ts": "one" }),
    source = await f.commit({ CODEOWNERS: code, "a.ts": "two" }, target),
    mr = f.mr(source, target);
  f.approve(source, target, "a");
  f.approve(source, target, "o");
  let gate = await reviewGate(f.env, f.repo, mr, f.store);
  assert.equal(gate.allowed, false);
  assert.deepEqual(gate.codeowners!.requirements[0].eligible.sort(), [
    "dev",
    "owner",
  ]);
  f.approve(source, target);
  assert.equal((await reviewGate(f.env, f.repo, mr, f.store)).allowed, true);
  f.approve(source, target, "o", "changes");
  assert.equal((await reviewGate(f.env, f.repo, mr, f.store)).allowed, false);
});
test("CODEOWNERS accepts target workspace members and exact effective roles, never grants authority from named owners", async () => {
  const f = fixture();
  f.db.exec(
    "INSERT INTO workspaces(id,slug,name) VALUES('w','team','Team');INSERT INTO workspace_members(workspace_id,user_id,role) VALUES('w','o','owner'),('w','g','maintainer');UPDATE repositories SET workspace_id='w',namespace='team' WHERE id='r'",
  );
  const repo = { ...f.repo, workspace_id: "w", namespace: "team" },
    code = "[Team] @team\n*\n[Lead] @@maintainer\n*\n";
  const target = await f.commit({ CODEOWNERS: code, a: "1" }),
    source = await f.commit({ CODEOWNERS: code, a: "2" }, target),
    mr = f.mr(source, target);
  f.approve(source, target, "o");
  assert.equal((await reviewGate(f.env, repo, mr, f.store)).allowed, false);
  f.approve(source, target, "g");
  assert.equal((await reviewGate(f.env, repo, mr, f.store)).allowed, true);
  f.db.exec("DELETE FROM workspace_members WHERE user_id='g'");
  assert.equal((await reviewGate(f.env, repo, mr, f.store)).allowed, false);
});
test("missing/invalid CODEOWNERS blocks enabled rules and cannot be bypassed by direct ref updates", async () => {
  const f = fixture(),
    target = await f.commit({ a: "1" }),
    source = await f.commit({ CODEOWNERS: "* @author", a: "2" }, target),
    mr = f.mr(source, target);
  const gate = await reviewGate(f.env, f.repo, mr, f.store);
  assert.match(gate.reasons.join(" "), /No CODEOWNERS/);
  await assert.rejects(
    protectRefs(
      f.env,
      f.repo,
      f.store,
      { "refs/heads/main": target },
      { "refs/heads/main": source },
    ),
    /reviewed merge/,
  );
  await assert.rejects(
    protectRefs(
      f.env,
      f.repo,
      f.store,
      { "refs/heads/main": target },
      { "refs/heads/main": source },
      mr,
    ),
    /No CODEOWNERS/,
  );
  const bad = await f.commit({
    CODEOWNERS: "* @missing # inline comments unsupported",
  });
  assert.match(
    (await reviewGate(f.env, f.repo, f.mr(source, bad), f.store)).reasons.join(
      " ",
    ),
    /CODEOWNERS/,
  );
});
test("tree comparison includes removed files and file/directory replacements without reading blobs", async () => {
  const f = fixture(),
    target = await f.commit({ gone: "1", same: "x", "dir/a": "1" }),
    source = await f.commit({ new: "2", same: "x", dir: "file" }, target);
  assert.deepEqual(await changedOwnerPaths(f.store, source, target), [
    "dir",
    "dir/a",
    "gone",
    "new",
  ]);
});
