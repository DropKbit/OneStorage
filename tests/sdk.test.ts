import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportPKCS8, jwtVerify } from "jose";
import {
  OneStorage,
  createToken,
  validateWebhook,
  CommitBuilder,
  streamNDJSON,
} from "../sdk/index";
import { signature } from "../src/webhooks";
import { ObjectStore, text } from "../src/git/objects";
import { parseCommitStream } from "../src/git/commit-stream";
test("TypeScript SDK JWT signatures interoperate for every supported algorithm", async () => {
  for (const alg of ["ES256", "ES384", "ES512", "RS256"] as const) {
    const pair = await generateKeyPair(alg, { extractable: true });
    const token = await createToken({
      issuer: "owner",
      key: await exportPKCS8(pair.privateKey),
      algorithm: alg,
      subject: "agent",
      repo: "owner/repo",
      scopes: ["git:write"],
      refs: [["main", ["no-push"]]],
    });
    const { payload } = await jwtVerify(token, pair.publicKey, {
      issuer: "owner",
      algorithms: [alg],
    });
    assert.equal(payload.repo, "owner/repo");
    assert.deepEqual(payload.scopes, ["git:write"]);
  }
});
test("SDK stream builder supports binary, streamed chunks, deletes and single-use requests", async () => {
  const store = new ObjectStore("sdk", {
    get: async () => null,
    put: async () => null,
  } as any);
  let captured: any;
  const builder = new CommitBuilder(
    {
      target_branch: "main",
      commit_message: "Stream",
      author: { name: "SDK", email: "sdk@example.com" },
    },
    async (stream) => {
      captured = await parseCommitStream(
        new Request("http://sdk", {
          method: "POST",
          body: stream,
          duplex: "half",
        } as any),
        store,
        "files",
      );
      return { sha: "test" } as any;
    },
  );
  async function* chunks() {
    yield new Uint8Array([0, 1]);
    yield new Uint8Array([255, 2]);
  }
  await builder
    .addFileFromStream("bin", chunks(), "100755")
    .deleteDirectory("old")
    .send();
  assert.equal(captured.metadata.files[0].mode, "100755");
  assert.deepEqual(
    (await store.get(captured.metadata.files[0].sha)).data,
    new Uint8Array([0, 1, 255, 2]),
  );
  assert.equal(captured.metadata.files[1].operation, "delete");
  await assert.rejects(() => builder.send(), /already sent/);
});
test("SDK applies narrow scopes and refuses credential-bearing redirects", async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const calls: any[] = [];
  const client = new OneStorage({
    origin: "https://git.example.com",
    signer: { issuer: "owner", key: pair.privateKey },
    fetch: async (url, init) => {
      const { payload } = await jwtVerify(
        new Headers(init?.headers).get("authorization")!.slice(7),
        pair.publicKey,
      );
      calls.push({ url, payload, redirect: init?.redirect });
      return Response.json({ branches: [] });
    },
  });
  await client.repo("owner", "repo").listBranches();
  await client.repo("owner", "repo").grep({ query: { pattern: "needle" } });
  await client.repo("owner", "repo").update({ description: "x" });
  assert.deepEqual(
    calls.map((c) => c.payload.scopes),
    [["git:read"], ["git:read"], ["repo:write"]],
  );
  assert.ok(calls.every((c) => c.redirect === "manual"));
});
test("SDK webhook verifier checks timestamp, signature and raw bytes", async () => {
  const payload = '{"event":"push"}',
    stamp = String(Math.floor(Date.now() / 1000)),
    secret = "testsecret";
  const headers = new Headers({
    "x-onestorage-timestamp": stamp,
    "x-onestorage-signature": await signature(secret, stamp, payload),
  });
  assert.equal((await validateWebhook(payload, headers, secret)).valid, true);
  assert.equal(
    (await validateWebhook(payload + " ", headers, secret)).valid,
    false,
  );
  headers.set("x-onestorage-timestamp", "1");
  assert.equal((await validateWebhook(payload, headers, secret)).valid, false);
});
