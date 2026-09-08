import { test } from "node:test";
import assert from "node:assert/strict";
import {
  branch,
  slug,
  equal,
  passwordHash,
  verifyPassword,
  boundedBody,
  digest,
} from "../src/security.ts";
test("reject option, traversal and ambiguous ref syntax", () => {
  for (const s of [
    "--upload-pack=evil",
    "../main",
    "refs/heads/../main",
    "a..b",
    "a@{1}",
    "a.lock",
    "a/.hidden",
    "a//b",
    "a b",
    "/main",
    "main/",
    "a\nmain",
    "a.",
  ])
    assert.equal(branch.safeParse(s).success, false, s);
  for (const s of ["main", "release/v1.0", "feature/hello-world"])
    assert.equal(branch.safeParse(s).success, true, s);
});
test("repository names exclude route collisions and escape characters", () => {
  for (const s of [
    "api",
    "settings",
    "../private",
    "a/b",
    "-repo",
    "UPPER",
    "repo.git",
  ])
    assert.equal(slug.safeParse(s).success, false, s);
  assert.equal(slug.parse("my-repo_1"), "my-repo_1");
});
test("password hashes are salted and verified; equality includes length", async () => {
  const a = await passwordHash("a-long-test-password"),
    b = await passwordHash("a-long-test-password");
  assert.notEqual(a, b);
  assert.equal(await verifyPassword("a-long-test-password", a), true);
  assert.equal(await verifyPassword("wrong-password", a), false);
  assert.equal(equal("abc", "abc\0"), false);
  assert.equal(equal("abc", "abd"), false);
});
test("streaming request limit cannot be bypassed by omitted content-length", async () => {
  const chunks = [new Uint8Array(3), new Uint8Array(4)];
  const stream = new ReadableStream({
    pull(c) {
      const chunk = chunks.shift();
      chunk ? c.enqueue(chunk) : c.close();
    },
  });
  await assert.rejects(
    () =>
      boundedBody(
        new Request("http://test", {
          method: "POST",
          body: stream,
          duplex: "half",
        } as RequestInit),
        6,
      ),
    /Request too large/,
  );
});
test("LFS checksum uses SHA-256 bytes", async () => {
  assert.equal(
    await digest(new TextEncoder().encode("hello")),
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  );
});
import { webhookURL, signature } from "../src/webhooks.ts";
import { createHmac } from "node:crypto";
test("webhook URL rejects unapproved hosts, credentials and non-HTTPS transports", () => {
  for (const url of [
    "http://hooks.example.com/x",
    "https://127.0.0.1/x",
    "https://hooks.example.com.evil.test/x",
    "https://user:secret@hooks.example.com/x",
    "https://hooks.example.com:8443/x",
    "https://hooks.example.com/#x",
  ])
    assert.throws(() => webhookURL(url, "hooks.example.com"));
  assert.equal(
    webhookURL("https://hooks.example.com/notify", "hooks.example.com"),
    "https://hooks.example.com/notify",
  );
});
test("webhook signature binds timestamp and exact raw payload", async () => {
  const body = '{"event":"repo.commit"}',
    expected =
      "sha256=" +
      createHmac("sha256", "secret")
        .update("123." + body)
        .digest("hex");
  assert.equal(await signature("secret", "123", body), expected);
  assert.notEqual(await signature("secret", "124", body), expected);
});
