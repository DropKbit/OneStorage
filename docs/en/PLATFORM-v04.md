# Collaboration spaces and CI/CD (v0.4)

[简体中文](../PLATFORM-v04.md) · **English**

This historical release introduced locally bundled, lazy Highlight.js (16 languages, line numbers/escaping, plain-text fallback for unknown or over-200,000-character files), personal/team spaces and switching, inherited/direct roles, administrator management, and fixed-commit CI with logs/artifacts, cancellation/retry, repository runners, built-in checks, and external builds/Cloudflare deployment. Later capabilities are listed in [roadmap](ROADMAP.md).

| Role       | Read | Push/create space project | Repository settings/CI/runners | Space role assignment |
| ---------- | ---- | ------------------------- | ------------------------------ | --------------------- |
| reader     | yes  | no                        | no                             | no                    |
| developer  | yes  | yes                       | no                             | no                    |
| maintainer | yes  | yes                       | yes                            | no                    |
| owner      | yes  | yes                       | yes                            | yes                   |

Direct/inherited grants take the higher role. Removing one does not remove another. Former creators retain no hidden team ownership. Keep at least one space owner and active instance administrator. Usernames/space slugs share a unique namespace; slugs are immutable. Empty spaces can be deleted after deleted-project GC finishes (initial collection roughly 60 seconds later).

Administrators manage metadata/users, enable/disable, reset passwords/revoke credentials, audit, and explicitly restore space ownership with audit. Admin status does not automatically expose private code. Disablement blocks passwords/PATs/sessions/JWTs. Passwords, hashes, and upstream secrets are not shown.

## External CI

Maintainers save JSON in CI/CD. Runs pin SHA/configuration; exact push `branches` excludes tags, ephemeral refs, and deletion. Manual/retry remains possible with automatic push disabled. [Versioned configuration/DAG](CI-WORKFLOWS-v14.md) came later.

```json
{
  "name": "Build and deploy",
  "runner": "external",
  "branches": ["main"],
  "timeout_seconds": 900,
  "steps": [
    { "type": "run", "name": "Install", "command": "npm ci" },
    { "type": "run", "name": "Test", "command": "npm test" },
    { "type": "run", "name": "Deploy", "command": "npx wrangler deploy" }
  ],
  "artifacts": ["dist/report.json"]
}
```

Commands use `/bin/sh -eu` in one isolated checkout/job, stopping on failure. The target needs its own tests/Wrangler config. Artifacts are explicit files, not directories/globs. Templates do not create accounts/projects or inject credentials.

Register a repository runner, save its one-time token in a mode-600 file on a trusted POSIX host, obtain this source, run npm ci, and install required build tools:

```sh
export ONESTORAGE_ORIGIN=https://1s.hk
export ONESTORAGE_RUNNER_TOKEN_FILE=/secure/onestorage-runner-token
export ONESTORAGE_JOB_ENV=CLOUDFLARE_API_TOKEN,CLOUDFLARE_ACCOUNT_ID
node scripts/runner.mjs
```

Supply deployment values through host secret management. Only explicit `ONESTORAGE_JOB_ENV` names and basic PATH/fresh HOME/CI/commit/ref pass to child processes; runner token/file do not. Known token/selected values are masked across log chunks, but this cannot stop malicious code encoding/exporting secrets. A dedicated trusted account/host is required: directories/environment filters are not an OS sandbox. Source extraction rejects links/devices and artifacts cannot escape checkout. Long-lived runner operation and real deployment credentials remain operator responsibilities.

## Worker checks and reliability

```json
{
  "runner": "worker",
  "branches": ["main"],
  "steps": [{ "type": "file", "path": "package.json", "format": "json" }],
  "artifacts": []
}
```

`file` supports exists/json. HTTP checks need approved HTTPS hosts in `CI_ALLOWED_HOSTS`, reject redirects, and carry no deployment secrets. Arbitrary repository code is never evaluated in the main Worker; [isolated JS/WASM](CLOUD-NATIVE-v05.md) was added later.

Runs are queued/running/succeeded/failed/canceled. Atomic D1 claims prevent duplicate execution, with 120-second leases/15-second runner heartbeats. Cron reclaims expired leases and retries durable unsent Worker jobs. Lost execution fails for explicit retry, avoiding automatic duplicate deployment. Cancellation revokes further source/log/artifact/completion access; the runner stops its process group at the next heartbeat. External effects are not rolled back automatically.

Historical limits: 20 active runs and ten runners/repository; 20 steps (ten Worker); ten artifacts/16 MiB each; 256×4,096-character logs; source 128 MiB compressed/256 MiB expanded; Worker file reads 1 MiB; external timeout 10–3,600 seconds and Worker 110 seconds. Logs/artifacts require membership even on public repositories. Later workflow/cache/build limits have separate guides.

APIs: `/api/workspaces`, space members, `/api/admin/*`, repository `/ci/{config,runs,runners}`; runner `/api/runner/claim` and `/api/runner/runs/:id/{heartbeat,source,logs,artifacts/:name,complete}` using runner token plus `X-Run-Lease` after claim. Space/admin/CI reject delegated JWTs.

Back up D1, apply `0005_workspaces_ci.sql`, then deploy main. No R2/DO rebuild or Git URL change. Third-party licenses ship in `public/THIRD_PARTY_LICENSES.txt`. See [historical verification](VERIFICATION-v04.md) and [current deployment](DEPLOYMENT.md).
