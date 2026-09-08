# Cloudflare-native collaboration platform (v0.5)

[简体中文](../CLOUD-NATIVE-v05.md) · **English**

OneStorage pursues practical GitLab/Gogs workflows using Workers, JavaScript/WASM, R2, and Durable Objects without containers. This guide records the initial cloud execution/collaboration release; [roadmap](ROADMAP.md) and [limits](LIMITS.md) describe subsequent progress and remaining boundaries.

Git HTTP v0/v2, objects/packs/deltas, merges, and CAS refs run in JavaScript with one repository DO; bytes live in R2. D1 holds users/spaces/permissions/issues/MRs/reviews/wiki/runs. Durable events flow through Queues into Workers/Dynamic Workers; Cron recovers undelivered jobs and expired leases. Isolated JS/WASM has no main bindings/credentials and `globalOutbound: null`, with default one-second/max-ten-second step CPU.

Artifacts/application versions are immutable R2 objects; D1 atomically publishes their index/version/success. Invalid leases cannot publish. A separate `onestorage-apps` gateway serves explicitly public active versions on a separate origin, strips credentials/Set-Cookie, and applies CSP sandbox. User applications never execute on the Git login origin.

## Native CI and application release

Use `examples/cloud-native/`, preserving paths, or create:

```js
// ci.js
import app from "./index.js";
export default async ({ sha, ref }) => {
  const response = await app.fetch(new Request("https://test.invalid/"));
  if (response.status !== 200) throw Error("Expected HTTP 200");
  return { logs: ["Test passed: " + sha], artifacts: { "report.json": JSON.stringify({sha,ref,passed:true}) } };
};
// index.js
export default { fetch() { return new Response("Hello from OneStorage"); } };
```

```json
{
  "runner": "worker",
  "branches": ["main", "feature"],
  "timeout_seconds": 90,
  "steps": [
    {
      "type": "javascript",
      "entry": "ci.js",
      "files": ["ci.js", "index.js"],
      "cpu_ms": 1000
    }
  ],
  "deploy": {
    "environment": "production",
    "kind": "worker",
    "entry": "index.js",
    "files": ["index.js"]
  }
}
```

Push or run manually, then activate a successful version in Applications. Selecting a historical version rolls back through CAS so another maintainer's change is not overwritten. Environments are private by default; even private-repository apps require explicit public exposure. Turning it off yields 404.

Explicit fixed-commit files support JS ESM, WASM imports/instantiation, and text modules. Binary commit API input uses `{path,data:BASE64}`. Returned artifacts are filename/text mappings, available to later steps; same-name artifacts override source in deploy files. Use static kind/index.html for generated sites. Native npm compilation is a later [build step](CI-BUILDS-v22.md).

Historical JS budgets: 32 files, 1 MiB/file, 4 MiB source/deployment; ten artifacts/2 MiB total; relative safe paths with reserved `__onestorage`; 20 seconds/isolated request, 110 seconds/ten steps per Worker job. Platform limits also apply. Explicit retries avoid duplicate deployments. Trusted external runners remain an optional general-OS path.

## Reviews and collaboration

Exact-name protection can require approvals, MR, and CI, always rejecting deletion/force-push. Git/API/web edits/direct merge/upstream cannot bypass review requirements. Approvals pin source and target SHAs; refresh invalidates old approvals. Only current non-author developers/maintainers/owners count. Latest non-comment changes-requested review blocks merging. CI selects the latest top-level run for the pinned source, avoiding same-second UUID ordering. Fast-forward, three-way, forced merge commit, and squash use target CAS; DO-persisted MR results recover failed D1 projection.

Issues support discussion/edit/reopen/close, member assignment, project labels/milestones and completion counts. Releases pin existing tags/SHAs; deleting a release does not delete its tag. Wiki has optimistic revisions and transaction-recorded history. Stars, watches, and audit-derived notifications recheck repository access. Historical lists were bounded to 100 notifications and 200 wiki/label/milestone entries.

Back up/migrate before deployment. The main Worker uses LOADER/APPS_ORIGIN; the gateway shares D1/R2 and LOADER. New self-hosting now deploys three Workers through [deployment instructions](DEPLOYMENT.md). Deleting a repository reclaims `ci/<repo>/`; soft deletion immediately blocks application access. Operator Wrangler credentials are never copied into jobs.

Subsequent releases add fork review/CODEOWNERS, account/MFA/OAuth, issue boards/lifecycle/search, scheduled DAG CI/variables/caches/native compilation, packages/deploy tokens, merge queue, code indexing, and Notebook preview. SSH hosting, arbitrary OS builds inside Workers, full GitLab YAML/API, all package ecosystems, giant-repository guarantees, SAML/SCIM/Access, and complete account recovery are not implied. See [current roadmap](ROADMAP.md).
