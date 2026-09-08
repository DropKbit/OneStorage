# Shared build caches (v0.21)

[简体中文](../CI-CACHES-v21.md) · **English**

Rebuildable dependency/intermediate files live in R2, with D1 tracking immutable versions, origin runs, quotas, and cleanup. Caches are separate from artifacts and releases. Worker file caches and external-runner archives use isolated formats.

## Configuration

```json
{
  "runner": "external",
  "caches": [
    {
      "id": "npm",
      "key": "npm-v1",
      "key_files": ["package-lock.json"],
      "paths": [".npm"],
      "scope": "branch",
      "policy": "pull-push"
    }
  ],
  "steps": [
    {
      "type": "run",
      "name": "Install",
      "command": "npm ci --cache .npm --prefer-offline"
    },
    { "type": "run", "name": "Test", "command": "npm test" }
  ]
}
```

Use matching `scripts/runner.mjs` and `runner-cache.mjs`. The runner restores after checking out the fixed commit and saves after all steps/artifact uploads succeed. Failed/cancelled runs do not produce reusable caches. Restore validates SHA-256, sizes, complete tar contents, and destination parents before extracting. Paths must stay under configured paths; `.git`, traversal, symlinks, hardlinks, and device files are prohibited. Prefer package download directories over linked `node_modules`.

Read/write failures, expiry, insufficient quota, and invalid generations log MISS/SKIP and allow a normal build. Scripts must work without cache.

Worker jobs declare the same slots and receive `input.caches[slot] = { relativePath: {content,binary?} }`. Binary content is Base64. Returning `caches` saves updates, available to later steps; empty sets do not overwrite existing caches. Isolated code gains no filesystem, network, or account bindings. Native npm compilation was added later in [v0.22](CI-BUILDS-v22.md).

## Keys and trust

At most four unique slots/job, ten nonoverlapping literal paths/slot, five `key_files` (1 MiB each), and three ordered `fallback_keys`. Fixed-commit filenames and SHA-256 values contribute to the primary key. Fallbacks are static keys without this run's lockfile hash and can be filled by jobs omitting `key_files`. Environment/job IDs are not automatically part of keys.

Default branch scope shares only within the same repository, branch, protection state, paths, and format. MR caches use an isolated review-origin scope; forks do not share. Protected scope permits sharing between protected branches of the same project, requires original manual/push/schedule origin and `require_mr`, and excludes MR retries. Ordinary branch writes require the run SHA still be current.

Policies are `pull-push` (default), `pull`, or `push`, pinned with the CI snapshot. One immutable upload per slot/run; repeating the same checksum is idempotent. Cache visibility requires both job and parent success. A pending upload never hides an earlier successful version. Caches are neither trusted test results nor secret storage; still verify dependencies and never cache credentials.

## Lifecycle and quotas

Members see versions, paths, origin, expiry, and usage in CI/CD. Maintainers clear using the current `generation`; permission/revision/audit checks are transactional. A new generation immediately invalidates old publishing runs. Archive/restore, cross-space transfer, and protection changes invalidate generations; same-space renames preserve them.

Per project: 100 objects/512 MiB. External archive: 64 MiB compressed, 256 MiB expanded, 25,000 entries. Worker slots together: 4 MiB JSON. Quotas reserve before upload, including unfinished/failed/cleanup-pending objects, and release only after deletion. Retention is seven days.

Clear sends Queue cleanup with five-minute Cron fallback, deleting up to 100 invalid, failed, expired, or superseded objects per batch. Incomplete uploads remain ten minutes; requests have a 90-second deadline. Ownership records survive run/project deletion. Project deletion reuses `ci/<repo>/` collection; failed R2 deletion retries.

## API and deployment

`GET /api/repos/:namespace/:repo/ci/caches` exposes metadata/quota, not bytes/R2 keys. `POST …/ci/caches/clear` accepts `{generation}`. Runner `GET /api/runner/runs/:id/caches/:slot` requires a repository token and `X-Run-Lease`; misses return `{hit:false}`, hits gzip with `X-Cache-SHA256` and length. `PUT` requires length/checksum and streams through `FixedLengthStream`, rechecking authorization/generation afterward. Responses disable HTTP caching.

Back up and rehearse migration `0017_ci_caches.sql`. It adds generations, run bindings, object ownership, and visibility views without rewriting Git or CI history. Run `test:caches` and `test:cache-ui`; remote tests require opt-in and cleanup before redeployment.

Historical v0.21: 238 unit tests/type checking; local caches 22 checks (including 2 MiB binary round-trip), cache UI 10, general UI 42, workflow UI 18, core 43 assertions/Git/LFS, workflows 23, and Git/DAG/fsck 21. Production caches passed 22 checks and Git/DAG/fsck 37. Backups, cleanup, health, and source/assets passed. These transferred sizes are evidence, not maximum-load or SLA claims.
