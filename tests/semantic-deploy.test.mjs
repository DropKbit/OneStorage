import test from "node:test";
import assert from "node:assert/strict";
import { prepareSemanticIndex } from "../scripts/semantic-deploy.mjs";
const config = {
  ai: { binding: "AI" },
  vectorize: [{ binding: "CODE_VECTORS", index_name: "provisioned-index" }],
};
test("Deploy installs and waits for repository filtering, and repeated deployment reuses it", async () => {
  const calls = [];
  let metadata = [],
    pending = 0;
  const run = async (args) => {
    calls.push(args);
    if (args[1] === "get")
      return JSON.stringify({ config: { dimensions: 1024, metric: "cosine" } });
    if (args[1] === "create-metadata-index") {
      pending = 2;
      return "{}";
    }
    if (pending && --pending === 0)
      metadata = [{ propertyName: "repo", indexType: "String" }];
    return JSON.stringify(metadata);
  };
  await prepareSemanticIndex(config, run, async () => {});
  assert.equal(calls.filter((x) => x[1] === "create-metadata-index").length, 1);
  await prepareSemanticIndex(config, run, async () => {});
  assert.equal(calls.filter((x) => x[1] === "create-metadata-index").length, 1);
  assert.ok(calls.every((x) => x[2] === "provisioned-index"));
});
test("Deploy refuses missing bindings, wrong embedding dimensions, wrong metric and invalid metadata", async () => {
  await assert.rejects(
    prepareSemanticIndex({}, async () => ""),
    /bindings/,
  );
  for (const c of [
    { dimensions: 768, metric: "cosine" },
    { dimensions: 1024, metric: "euclidean" },
  ])
    await assert.rejects(
      prepareSemanticIndex(config, async () => JSON.stringify({ config: c })),
      /1024 dimensions/,
    );
  await assert.rejects(
    prepareSemanticIndex(config, async (a) =>
      JSON.stringify(
        a[1] === "get"
          ? { config: { dimensions: 1024, metric: "cosine" } }
          : [{ propertyName: "repo", indexType: "number" }],
      ),
    ),
    /string type/,
  );
});
