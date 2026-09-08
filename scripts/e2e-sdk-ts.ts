import {
  memory,
  sessions,
  checkpoints,
  productFiles,
  parallelAttempts,
  review,
  liveDiff,
} from "../examples/workflows";
import assert from "node:assert/strict";
import { OneStorage } from "../sdk/index";
const client = new OneStorage({
  origin: process.env.TEST_ORIGIN!,
  signer: {
    issuer: process.env.TEST_ISSUER!,
    key: process.env.TEST_PRIVATE_KEY!,
    keyId: process.env.TEST_KEY_ID!,
  },
});
const project = await client.createRepo({
    name: "e2e_sdk_ts/group_" + crypto.randomUUID().slice(0, 8),
  }),
  repo = client.repo(project.namespace, project.name);
try {
  assert.equal((await client.resolveRepo(project.id)).id, project.id);
  const initial = await repo
    .createCommit({
      target_branch: "main",
      commit_message: "TS SDK",
      author: { name: "TS", email: "ts@example.com" },
    })
    .addFileFromString("README.md", "TypeScript\n")
    .addFile("binary", new Uint8Array([0, 1, 255]))
    .send();
  assert.ok(initial.sha);
  assert.equal(await (await repo.getFile("README.md")).text(), "TypeScript\n");
  await repo.createNote(initial.sha, "verified");
  assert.equal((await repo.getNote(initial.sha)).note, "verified\n");
  await repo.createBranch({
    target_branch: "scratch",
    base_branch: "main",
    ephemeral: true,
  });
  assert.equal(
    (await repo.listBranches({ ephemeral: true })).branches.length,
    1,
  );
  assert.equal((await repo.listBranches()).branches.length, 1);
  const fork = await client.createRepo({
    name: project.name + "_fork",
    base_repo: { id: project.id },
  });
  await client.repo(fork.namespace, fork.name).delete();
  for (const fn of [
    memory,
    sessions,
    checkpoints,
    productFiles,
    parallelAttempts,
    review,
  ])
    assert.ok(await fn(repo));
  for await (const value of liveDiff(repo, {
    branch: "main",
    pollMs: 1,
    iterations: 1,
  }))
    assert.ok(value);
  console.log("PASS: TypeScript signed SDK and seven agent workflows");
} finally {
  await repo.delete();
}
