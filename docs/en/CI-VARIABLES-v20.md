# Project CI variables and secrets (v0.20)

[简体中文](../CI-VARIABLES-v20.md) · **English**

Maintainers and owners manage variables in project CI/CD. Ordinary members cannot use management endpoints; administrators still need project rights. All values, including ordinary variables, are AES-GCM encrypted in D1. Management responses expose metadata only; submitted values are never shown again. Configure and separately back up `CREDENTIAL_ENCRYPTION_KEY`; discarding an old key breaks decryption. [Space inheritance](CI-WORKSPACE-VARIABLES-v24.md) was added in v0.24.

## Usage

```json
{
  "runner": "worker",
  "environment": "production",
  "variables": ["API_TOKEN", "LABEL"],
  "steps": [{ "type": "javascript", "entry": "ci.js", "files": ["ci.js"] }]
}
```

```js
export default async ({ variables }) => ({
  logs: ["Configuration loaded"],
  artifacts: { "result.txt": variables.LABEL },
});
```

External runners use the same declarations and inject values only into that job's child-process environment. The shipped runner can use `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` for `npm ci`, tests, and Wrangler deployment. Submit secrets through the management form, never repository JSON, scripts, or command strings. General commands run on the user's trusted external runner; the hosting service itself has no shell or containers.

Exact environment definitions override `*`. A paused or unauthorized exact match fails rather than falling back; deleting it restores generic matching. Environment defaults to `deploy.environment`, then `default`; explicitly specified environments must agree.

Limits: 100 definitions/project; 30 names and 64 KiB decrypted values/job; 8,192 characters/value, minimum eight for secrets, no NUL. Names use uppercase letters, digits, and underscores; runner/system names such as PATH/HOME are reserved. Environment names start with a lowercase letter and contain 1–40 lowercase letters, digits, or hyphens. Up to 20 explicit branch names or `*` are allowed.

## Authorization and snapshots

Defaults are enabled secret, protected branches only, and `main`. Protected values require branch `require_mr`. Secrets/protected values are available only to manual, push, and scheduled origins. First use must match the branch's current commit; an old retry after branch movement needs a new run. MR children/retries retain MR origin and cannot read these values. MR jobs can use explicitly ordinary, unprotected values allowed on their branch.

First use pins encrypted values and definition versions to the job. Editing, pausing, deleting, owner disablement/loss of last maintenance role, archive, or cross-space transfer cancels bound unfinished jobs and parents. Protection changes cancel jobs bound to protected values. Late completion/publication is rejected. Unbound jobs select current definitions at first use. Taking ownership pauses the definition; ordinary editing does not take ownership. PAT revocation is distinct from role revocation. Completed encrypted snapshots remain for historical log masking.

Dynamic Workers receive `input.variables`, no account bindings, and `globalOutbound: null`. External runners need their job's valid lease; value responses are `no-store` and not written to variable files. Revocation prevents further reads/publication but cannot recover values already delivered to code.

## Logs and API

Direct, URL-encoded, JSON-escaped, and UTF-8 Base64 secret forms become `[MASKED]` (`[REDACTED]` in the runner). Common console output, returned logs/errors, chunked UTF-8 runner output, and server-side log reads are filtered. Ordinary variables are not masked. Historical snapshots preserve masking after rotation/deletion. Masking reduces accidents; trusted code can transform or export a value or include it in artifacts.

- `GET/POST /api/repos/:namespace/:repo/ci/variables`: metadata/create.
- `PUT/DELETE …/variables/:id`: current `revision`; omitted `value` retains it.
- `POST …/variables/:id/take-ownership`: revision, then paused.
- `GET /api/runner/runs/:id/variables`: runner token plus `X-Run-Lease`.

Writes atomically check current access/revision and audit. Back up and rehearse `0016_ci_variables.sql` before applying; it adds definitions, encrypted snapshots, origin markers, and revocation triggers without rewriting old runs or Git storage.

## Historical verification

v0.20 passed 226 unit tests/type checking; local variable tests 41 checks, variable UI 16, general UI 43, core 43 assertions plus Git/LFS, workflow UI 18, workflows 23, and Git/DAG/fsck 21. Production passed 41 variable checks and 30 Git/DAG/fsck checks; assets, source fingerprint, health, backup recovery, and migration rehearsal passed. Cubelink was unchanged at that release. Run `test:variables` and `test:variable-ui` for focused acceptance; remote tests require explicit opt-in and temporary resources.
