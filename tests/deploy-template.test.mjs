import test from "node:test";
import assert from "node:assert/strict";
import {
  deploymentConfigs,
  childEnvironment,
  gatewayOrigin,
} from "../scripts/deploy-template.mjs";
const fixture = () => ({
  name: "my-forge",
  vars: {},
  d1_databases: [
    { binding: "DB", database_id: "12345678-1234-1234-1234-123456789abc" },
  ],
  r2_buckets: [
    { binding: "OBJECTS", bucket_name: "my-git" },
    { binding: "NPM_CACHE", bucket_name: "my-cache" },
  ],
  queues: {
    producers: [{ binding: "EVENTS", queue: "my-events" }],
    consumers: [{ queue: "my-events" }],
  },
});
test("provisioned bindings are shared only with the workers that need them", () => {
  const f = fixture(),
    c = deploymentConfigs(f, {}, {});
  assert.equal(c.primary.services[0].service, "my-forge-build");
  assert.equal(c.build.name, "my-forge-build");
  assert.equal(c.build.workers_dev, false);
  assert.equal(c.build.d1_databases, undefined);
  assert.equal(c.build.r2_buckets[0].bucket_name, "my-cache");
  assert.deepEqual(c.gateway.d1_databases, f.d1_databases);
  assert.equal(c.gateway.r2_buckets.length, 1);
  assert.equal(c.gateway.r2_buckets[0].bucket_name, "my-git");
  assert.equal(f.services, undefined);
});
test("template refuses production configs, missing provisioning and shared object/cache buckets", () => {
  for (const edit of [
    (f) => (f.vars.APP_ORIGIN = "https://git.1s.hk"),
    (f) => (f.routes = [{ pattern: "git.1s.hk" }]),
    (f) => (f.account_id = "real-account"),
    (f) =>
      (f.d1_databases[0].database_id = "00000000-0000-0000-0000-000000000000"),
    (f) => (f.r2_buckets[1].bucket_name = "my-git"),
    (f) => (f.queues.consumers[0].queue = "different"),
    (f) => (f.name = "x".repeat(60)),
  ]) {
    const f = fixture();
    edit(f);
    assert.throws(() => deploymentConfigs(f, {}, {}));
  }
});
test("sibling deployments cannot inherit the main Worker CI name or tag", () => {
  const env = {
    WRANGLER_CI_OVERRIDE_NAME: "my-forge",
    WRANGLER_CI_MATCH_TAG: "tag",
    CLOUDFLARE_API_TOKEN: "fake-test-token",
    OTHER: "keep",
  };
  assert.deepEqual(childEnvironment(env), {
    CLOUDFLARE_API_TOKEN: "fake-test-token",
    OTHER: "keep",
  });
  assert.deepEqual(childEnvironment(env, true), env);
  assert.equal(
    gatewayOrigin("https://my-forge-apps.account.workers.dev", "my-forge"),
    "https://my-forge-apps.account.workers.dev",
  );
  assert.throws(() =>
    gatewayOrigin("https://unrelated.account.workers.dev", "my-forge"),
  );
});
