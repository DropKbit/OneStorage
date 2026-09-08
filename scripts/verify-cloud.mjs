// Opt-in acceptance on an operator-owned instance. Only generated repositories are mutated.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { OneStorage } from "../sdk/index.ts";
if (process.env.ALLOW_REMOTE_ACCEPTANCE !== "1")
  throw Error(
    "Set ALLOW_REMOTE_ACCEPTANCE=1 to create and delete isolated acceptance repositories",
  );
const origin = process.env.ONESTORAGE_ORIGIN,
  token = process.env.ONESTORAGE_TOKEN,
  namespace = process.env.ONESTORAGE_NAMESPACE;
if (!origin || !token || !namespace)
  throw Error("Origin, token and namespace are required");
const client = new OneStorage({ origin, token }),
  name = "accept_v03_" + crypto.randomUUID().slice(0, 8),
  created = [],
  evidence = [];
async function check(name, fn) {
  await fn();
  evidence.push(name);
  console.log("PASS:", name);
}
const author = {
  name: "OneStorage acceptance",
  email: "acceptance@example.com",
};
const health = await (await fetch(origin + "/api/health")).json();
assert.equal(health.version, "0.3.0");
const p = await client.createRepo({ name: name + "/project" });
assert.equal(p.namespace, namespace);
const repo = client.repo(namespace, p.name);
created.push(repo);
try {
  let base, changed;
  await check("grouped repo create/get/list/resolve", async () => {
    assert.equal((await client.resolveRepo(p.id)).id, p.id);
    assert.ok((await client.request("/repos?limit=1")).repositories.length);
    assert.equal(
      (
        await client.request(
          "/repos/" + namespace + "/" + encodeURIComponent(p.name),
        )
      ).id,
      p.id,
    );
  });
  await check("streamed binary file commit", async () => {
    base = await repo
      .createCommit({
        target_branch: "main",
        expected_target_sha: null,
        commit_message: "Initial acceptance",
        author,
      })
      .addFileFromString("README.md", "one\ntwo\n")
      .addFile("binary.dat", new Uint8Array([0, 255, 1]))
      .send();
    assert.ok(base.sha);
  });
  await check("raw GET/HEAD/Range/ETag and archive", async () => {
    assert.equal(await (await repo.getFile("README.md")).text(), "one\ntwo\n");
    const head = await repo.getFile("README.md", { head: true });
    assert.equal(head.status, 200);
    const range = await repo.getFile("README.md", {
      headers: { Range: "bytes=0-2" },
    });
    assert.equal(range.status, 206);
    assert.equal(await range.text(), "one");
    const cached = await repo.getFile("README.md", {
      headers: { "If-None-Match": head.headers.get("etag") },
    });
    assert.equal(cached.status, 304);
    const archive = await repo.getArchive({
      ref: "main",
      include_globs: ["*.md"],
      archive: { prefix: "acceptance/" },
    });
    assert.deepEqual(
      new Uint8Array(await archive.arrayBuffer()).slice(0, 2),
      new Uint8Array([31, 139]),
    );
  });
  await check("files metadata/history/commit/grep/blame", async () => {
    assert.equal((await repo.getCommit(base.sha)).commit.sha, base.sha);
    assert.ok((await repo.listCommits({ path: "README.md" })).commits.length);
    assert.ok(
      (await repo.listFiles({ metadata: true, recursive: true })).files.length,
    );
    assert.ok((await repo.listFiles()).files.length);
    assert.ok((await repo.grep({ query: { pattern: "one" } })).matches.length);
    assert.ok((await repo.blame("README.md")).lines.length);
  });
  await check("branch and ephemeral namespace isolation", async () => {
    await repo.createBranch({
      target_branch: "agent",
      base_branch: "main",
      ephemeral: true,
    });
    assert.equal((await repo.listBranches()).branches.length, 1);
    assert.equal(
      (await repo.listBranches({ ephemeral: true })).branches.length,
      1,
    );
    assert.ok((await repo.getBranch("main")).sha);
    await repo.deleteBranch("agent", { ephemeral: true });
    await repo.createBranch({ target_branch: "feature", base_branch: "main" });
  });
  await check("native diff patch stream and compare", async () => {
    changed = await repo.createDiffCommit(
      {
        target_branch: "feature",
        expected_target_sha: base.sha,
        commit_message: "Apply native diff",
        author,
      },
      "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1,2 +1,2 @@\n one\n-two\n+three\n",
    );
    assert.ok(changed.sha);
    assert.ok(
      (await repo.getDiff({ ref: "feature", base: "main" })).diff.includes(
        "+three",
      ),
    );
    assert.ok(
      (await repo.diffBranches("feature", "main")).diff.includes("+three"),
    );
  });
  await check("immutable merge preview and merge", async () => {
    const preview = await repo.previewMerge({
      source_ref: changed.sha,
      target_branch: "main",
      include_content: true,
    });
    assert.equal(preview.target_tip_sha, base.sha);
    await repo.mergeBranches({
      source_ref: changed.sha,
      target_branch: "main",
      expected_target_sha: base.sha,
      strategy: "ff_only",
    });
    assert.equal(
      await (await repo.getFile("README.md")).text(),
      "one\nthree\n",
    );
  });
  await check("restore commit and reset alias", async () => {
    const restore = await repo.restoreCommit({
      target_branch: "main",
      base_ref: base.sha,
      expected_target_sha: changed.sha,
      commit_message: "Restore baseline",
      author,
    });
    assert.equal(await (await repo.getFile("README.md")).text(), "one\ntwo\n");
    const response = await client.raw(
      "/repos/" +
        namespace +
        "/" +
        encodeURIComponent(p.name) +
        "/reset-commits",
      "POST",
      JSON.stringify({
        metadata: {
          target_branch: "main",
          base_ref: changed.sha,
          expected_target_sha: restore.sha,
          commit_message: "Restore selected tree",
          author,
        },
      }) + "\n",
      { "Content-Type": "application/x-ndjson" },
    );
    assert.equal(response.status, 201);
    await response.body?.cancel();
  });
  await check("Git Notes and tags CRUD", async () => {
    await repo.createNote(base.sha, "Acceptance");
    await repo.appendNote(base.sha, "Append");
    assert.ok((await repo.getNote(base.sha)).note.includes("Append"));
    assert.ok((await repo.listNotesRefs()).refs.length);
    await repo.deleteNote(base.sha);
    await repo.createTag("v-test", "main");
    assert.ok((await repo.listTags()).tags.length);
    assert.ok((await repo.getTag("v-test")).sha);
    await repo.deleteTag("v-test");
  });
  await check("default branch and independent fork", async () => {
    await repo.update({
      default_branch: "feature",
      description: "Isolated release acceptance",
    });
    const f = await client.createRepo({
      name: name + "_fork",
      base_repo: { id: p.id },
    });
    const fork = client.repo(namespace, f.name);
    created.push(fork);
    assert.equal(
      await (await fork.getFile("README.md")).text(),
      "one\nthree\n",
    );
    await repo.update({ default_branch: "main" });
    await repo.deleteBranch("feature");
  });
  await check("encrypted upstream credentials and detach", async () => {
    await repo.configureUpstream({
      provider: "gitlab",
      owner: "onestorage-acceptance",
      name: "unconnected",
    });
    const credential = await repo.createGitCredential(
      "acceptance-only-" + crypto.randomUUID(),
      "test",
    );
    await repo.updateGitCredential(
      "replacement-" + crypto.randomUUID(),
      "test",
    );
    assert.equal((await repo.listGitCredentials()).credentials.length, 1);
    await repo.deleteGitCredential(credential.id);
    await repo.unsetBaseRepo();
    assert.equal((await repo.syncStatus()).upstream, null);
  });
  await check("MCP authorization and public machine docs", async () => {
    const response = await fetch(origin + "/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(response.status, 200);
    assert.ok((await response.json()).result.tools.length >= 20);
    const unauth = await fetch(origin + "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(unauth.status, 401);
    assert.ok(
      (await (await fetch(origin + "/llms.txt")).text()).includes("OneStorage"),
    );
    const spec = await (await fetch(origin + "/openapi.json")).json();
    assert.equal(
      Object.values(spec.paths).reduce((n, x) => n + Object.keys(x).length, 0),
      40,
    );
  });
  await check("real public GitHub sync through cloud Queue/R2/DO", async () => {
    const s = await client.createRepo({
      name: name + "_sync",
      base_repo: {
        provider: "github",
        owner: "octocat",
        name: "Hello-World",
        mode: "public",
      },
    });
    const sync = client.repo(namespace, s.name);
    created.push(sync);
    let status;
    for (let i = 0; i < 90; i++) {
      status = await sync.syncStatus();
      if (status.synced_at) break;
      if (status.status === "failed")
        throw Error("Public upstream failed: " + status.error);
      await new Promise((r) => setTimeout(r, 2000));
    }
    assert.ok(status.synced_at, "Sync did not complete");
    assert.ok((await sync.listBranches()).branches.length);
    assert.ok((await sync.listFiles()).files.length);
    await sync.pullUpstream();
  });
} finally {
  for (const repo of created.reverse()) await repo.delete();
  console.log("Cleaned up all isolated acceptance repositories");
}
await check("deleted repo hidden", async () => {
  await assert.rejects(
    () => repo.getCommit(),
    (e) => e.status === 404,
  );
});
if (process.env.ACCEPTANCE_REPORT)
  await writeFile(
    process.env.ACCEPTANCE_REPORT,
    JSON.stringify(
      { origin, date: new Date().toISOString(), repository_id: p.id, evidence },
      null,
      2,
    ) + "\n",
  );
console.log("PASS: cloud acceptance complete");
