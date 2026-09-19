import test from "node:test";
import assert from "node:assert/strict";
import { assertPublicFile, isPrivatePath } from "../scripts/source-policy.mjs";
test("private paths are rejected, including nested environment and credential files", () => {
  for (const file of [
    "docs/a.md",
    "public/docs/en/a.html",
    "output/report.json",
    ".data/token",
    ".env",
    ".env.production",
    "examples/app/.dev.vars",
    ".npmrc",
    "keys/id.key",
    "id.pem",
    "wrangler.apps.production.jsonc",
  ]) {
    assert.equal(isPrivatePath(file), true, file);
    assert.throws(() => assertPublicFile(file, ""));
  }
  for (const file of ["README.md", "src/index.ts", "scripts/docs.mjs"])
    assert.doesNotThrow(() => assertPublicFile(file, ""));
  assert.doesNotThrow(() =>
    assertPublicFile(".env.example", "# Empty template\nBOOTSTRAP_SECRET=\n"),
  );
  assert.throws(() =>
    assertPublicFile(".env.example", "BOOTSTRAP_SECRET=example"),
  );
});
test("credential findings withhold values and production templates reject resource IDs", () => {
  const token = "os_" + "ab".repeat(32);
  assert.throws(
    () => assertPublicFile("src/config.ts", token),
    (error) => !error.message.includes(token),
  );
  assert.throws(() =>
    assertPublicFile("src/config.ts", "-----BEGIN " + "PRIVATE KEY-----"),
  );
  assert.throws(() =>
    assertPublicFile("wrangler.jsonc", '{"database_id":"private-resource"}'),
  );
  assert.throws(() =>
    assertPublicFile("wrangler.apps.jsonc", '{"account_id":"private-account"}'),
  );
  assert.doesNotThrow(() =>
    assertPublicFile(
      "wrangler.jsonc",
      '{"database_id":"00000000-0000-0000-0000-000000000000"}',
    ),
  );
});

test("source archives sanitize resource substitutions made by the Deploy system", async () => {
  const { publicConfig } = await import("../scripts/public-config.mjs");
  const privateConfig = JSON.stringify({
    name: "user-instance",
    account_id: "account",
    routes: [{ pattern: "private.example" }],
    vars: { BOOTSTRAP_SECRET: "private-value" },
    d1_databases: [
      { binding: "DB", database_id: "real-id", database_name: "real-name" },
    ],
    vectorize: [{ binding: "CODE_VECTORS", index_name: "private-index" }],
  });
  const result = publicConfig("wrangler.jsonc", privateConfig).toString();
  assertPublicFile("wrangler.jsonc", result);
  for (const value of [
    "user-instance",
    "private.example",
    "private-value",
    "real-id",
    "real-name",
    "private-index",
  ])
    assert.ok(!result.includes(value));
  assert.equal(publicConfig("wrangler.local.jsonc", "local"), "local");
});
