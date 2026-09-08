# HTTP API / Git protocol — v0.3

Base URL: `https://git.1s.hk/api` (local: `http://localhost:8787/api`). API examples use a short-lived personal token in `Authorization: Bearer <token>`. Do not put tokens in clone URLs, query strings or shell history. Browser session mutations additionally require the exact configured `Origin`.

Responses use JSON. Errors contain `{ "error": "..." }`, and validation errors include `details`. Common status codes: 400 validation, 401 authentication, 403 permission, 404 hidden/missing resource, 409 conflict, 413 size limit, 429 saturation, 5xx transient/engine/storage failures.

## Identity

| Method     | Path          | Purpose                                                                   |
| ---------- | ------------- | ------------------------------------------------------------------------- |
| GET        | `/setup`      | Whether initial setup is required                                         |
| POST       | `/setup`      | `{username,password,secret}`; one-time administrator creation             |
| POST       | `/login`      | `{username,password}`; issues session cookie                              |
| POST       | `/logout`     | Revoke current browser session                                            |
| POST       | `/password`   | Session-only `{current_password,new_password}`; revokes sessions and PATs |
| GET        | `/me`         | Current user or null                                                      |
| POST       | `/users`      | Administrator creates `{username,password}`                               |
| GET / POST | `/tokens`     | List/create PATs; creation requires browser session                       |
| DELETE     | `/tokens/:id` | Revoke own PAT                                                            |

Token creation: `{name,scope:"read"|"write",days:1..365}`. Plaintext token is returned once. Passwords are 12–128 characters. Slugs are lowercase letters, digits, `_` and `-`, beginning with a letter/digit, maximum 48 characters. Route names including `api`, `admin`, `auth` and `settings` are reserved.

## Projects

`/repos` supports GET with `q` and zero-based `page`, and POST with `{name,description?,visibility?,default_branch?}`. Namespaces belong to the creating user. Repositories default to private and `main`.

All paths below are relative to `/repos/:namespace/:repo`.

| Method      | Path                                  | Payload / result                                       |
| ----------- | ------------------------------------- | ------------------------------------------------------ |
| GET         | `/`                                   | Repository metadata, role, clone URL                   |
| PATCH       | `/`                                   | `{description,visibility,default_branch}`; maintainer  |
| GET         | `/branches`                           | `{branches:[{name,sha}]}`                              |
| GET         | `/tree?ref=main&path=src`             | `{ref,path,entries:[{name,type,mode,sha}]}`            |
| GET         | `/blob?ref=main&path=README.md`       | UTF-8 content, binary flag, size, resolved ref         |
| GET         | `/search?ref=main&q=keyword`          | Literal text search, 200 matches maximum               |
| GET         | `/commits?ref=main`                   | Paginated history; optional path filter                |
| GET         | `/compare?source=feature&target=main` | Immutable SHAs and plain diff                          |
| POST        | `/commit`                             | `{branch,expected_sha,message,files:[{path,content}]}` |
| GET / PUT   | `/members`                            | List or upsert `{username,role}`                       |
| DELETE      | `/members/:username`                  | Remove member                                          |
| GET / POST  | `/issues`                             | List or create `{title,body?}`                         |
| GET / PATCH | `/issues/:id`                         | Detail/comments or `{state:"open"                      | "closed"}` |
| POST        | `/issues/:id/comments`                | `{body}`                                               |
| GET / POST  | `/merges`                             | List or create `{title,body?,source,target}`           |
| GET         | `/merges/:id`                         | Reviewed SHA pair and diff                             |
| POST        | `/merges/:id/merge`                   | Fast-forward and mark merged                           |
| GET         | `/audit`                              | Last 100 audit events; maintainer                      |

File API: `content:null` deletes a path. `expected_sha:null` creates an absent branch; otherwise provide its last observed SHA. Use `/branches/create` to create a branch from another branch or revision. API errors or connection loss may follow a committed mutation: read the ref before retrying. Issue and MR numeric IDs are instance-wide, not project-local sequences.

## Git

```sh
git clone https://git.1s.hk/alice/project.git
# Username: alice
# Password: your PAT (never your account password)
```

Supports HTTPS smart HTTP `info/refs`, `git-upload-pack`, `git-receive-pack`, protocol v0/v2, pack negotiation, refs and tags. SSH, dumb HTTP and encoded/compressed HTTP request bodies are not implemented. Clients using request compression should disable it. Private clones require a PAT; anonymous public clones work. PAT pushes retain the default no-history-rewrite policy. Delegated JWT pushes may rewrite refs unless their first matching ref policy forbids it. Default branch deletion is forbidden. Push batches are all-or-nothing. SHA-256 Git repositories, shallow clone and partial clone/filter are not implemented. Incoming OFS_DELTA, REF_DELTA and thin packs are accepted; output packs contain complete zlib-compressed objects. See README for object, pack and traversal budgets.

## LFS

Standard endpoint: `https://git.1s.hk/alice/project.git/info/lfs`.

- POST `/objects/batch`: `operation: upload|download`, `objects:[{oid,size}]`; basic transfer.
- PUT `/objects/:sha256`: upload bytes, validate SHA-256 (16 MiB cap).
- GET `/objects/:sha256`: authorized streaming download.

Actions contain the trusted application origin and carry the requesting Authorization header. A missing object gets a per-object 404. OIDs are isolated by repository even when content hashes match. LFS locking and optional verify actions are not provided.

## SDK

Copy/import `sdk/index.ts` in a TypeScript workspace:

```ts
import { OneStorage } from "./sdk/index";
const storage = new OneStorage({
  origin: "https://git.1s.hk",
  token: env.ONESTORAGE_TOKEN,
});
await storage.createRepo({ name: "agent-memory", visibility: "private" });
const repo = storage.repo("alice", "agent-memory");
const result = await repo.commit({
  branch: "main",
  expected_sha: null,
  message: "Initialize memory",
  files: [{ path: "memory.md", content: "# Memory\n" }],
});
const file = await repo.file("memory.md");
```

## Webhooks (operator opt-in)

All paths relative to `/repos/:namespace/:repo`, maintainer role required:

- GET/POST `/webhooks`: list or create `{url}` (10 per repository). Create returns `{id,url,secret}`; secret is shown once. Only HTTPS hosts in `WEBHOOK_ALLOWED_HOSTS` may be used.
- DELETE `/webhooks/:id`: disable a hook and remove its delivery records.
- GET `/deliveries`: most recent 100 delivery statuses and attempts.

Create accepts optional `events` filters. The `push` event records only published ref changes, with old/new SHAs, atomically persisted alongside refs in the DO. Rejected pushes and flush-only probes do not emit it. Sync events include `repo.sync.started`, `repo.sync.succeeded`, and `repo.sync.failed`. Collaboration audit events continue to use the D1 outbox. Deliveries are at least once; deduplicate IDs.

Payload: `{id,event,repository_id,actor,detail,timestamp}`. Headers: `X-OneStorage-Delivery`, `X-OneStorage-Timestamp` (Unix seconds), `X-OneStorage-Signature` (`sha256=<hex>`). Compute HMAC-SHA256 over `timestamp + "." + rawBody` with the returned secret, compare in constant time, enforce a recent timestamp window, and deduplicate using the delivery ID. Responses must be 2xx within 10 seconds; redirects are not followed.

## v0.3 authentication and naming

Repository names may contain up to five slash-separated slug segments (200 characters total). Encode the complete name as one API/Git path segment, e.g. `/api/repos/alice/team%2Fproject` and `/alice/team%2Fproject.git`. Usernames remain a single slug. `/repos` accepts `limit` (1–100), `cursor`, `page`, and `q`; use returned `next_cursor` unchanged.

Browser-session-only `/api/api-keys` and `/api/signing-keys` accept GET, POST `{name,public_key,algorithm?}`, and DELETE `/:id`. API keys accept SPKI public PEM with ES256 (default), ES384, ES512 or RS256 (RSA ≥2048 bits). Signing keys accept SSH public keys or armored OpenPGP public keys. Private API/signing keys remain client-side; up to 20 of each per user.

JWT header uses `alg` and optional `kid`; claims include `iss` (username), `sub`, `iat`, `exp`, `repo` (`alice/team/project`) and `scopes`. Scopes `git:read`, `git:write`, `repo:write`, `org:read` are independent: write does not imply read. Listing uses `org:read`; a fork needs target `repo:write` plus `git:read`. Public keys are checked on every request; revocation takes effect without waiting for token expiry. Use the SDK token generators to encode policies correctly. Ordered `refs` policies allow exact names, terminal `/*`, or `*`; first match wins. Supported restrictions: `no-push`, `no-force-push`, `verify-sig`. Verification checks all newly introduced commits against the issuer's currently registered signing keys; unsigned API-generated commits cannot bypass it.

Git HTTP Basic accepts a PAT or JWT as password. For isolated temporary refs use `/alice/project+ephemeral.git`; normal and ephemeral API operations select `ephemeral=true` (query or supported request body). `/alice/project+import.git` is push-only and cannot write a repository configured with an upstream. Logical refs are restricted to heads/tags/notes; clients cannot address internal namespace paths.

## Complete feature operation map

The table maps the 40 preferred Code Storage operations to OneStorage routes. It is a behavior mapping, not a claim of wire compatibility. All paths below include `/api`. Machine-readable contract: `/openapi.json`; the JSON/NDJSON details and SDK types here are authoritative for request construction.

| Operation                  | Method | OneStorage path                                      |
| -------------------------- | ------ | ---------------------------------------------------- |
| Get Repo Url By Id         | GET    | `/api/repo-url/{id}`                                 |
| List Repos                 | GET    | `/api/repos`                                         |
| Create Repo                | POST   | `/api/repos`                                         |
| Delete Repo                | DELETE | `/api/repos/{namespace}/{repo}`                      |
| Get Repo                   | GET    | `/api/repos/{namespace}/{repo}`                      |
| Update Repository Settings | PATCH  | `/api/repos/{namespace}/{repo}`                      |
| Archive                    | POST   | `/api/repos/{namespace}/{repo}/archive`              |
| Unset Base Repo            | DELETE | `/api/repos/{namespace}/{repo}/base`                 |
| Blame                      | GET    | `/api/repos/{namespace}/{repo}/blame`                |
| Get Branch                 | GET    | `/api/repos/{namespace}/{repo}/branch`               |
| Delete Branch              | DELETE | `/api/repos/{namespace}/{repo}/branches`             |
| List Branches              | GET    | `/api/repos/{namespace}/{repo}/branches`             |
| Create Branch              | POST   | `/api/repos/{namespace}/{repo}/branches/create`      |
| Get Branch Diff            | GET    | `/api/repos/{namespace}/{repo}/branches/diff`        |
| Get Commit                 | GET    | `/api/repos/{namespace}/{repo}/commit`               |
| Create Commit from Files   | POST   | `/api/repos/{namespace}/{repo}/commit-pack`          |
| List Commits               | GET    | `/api/repos/{namespace}/{repo}/commits`              |
| Get Commit Diff            | GET    | `/api/repos/{namespace}/{repo}/diff`                 |
| Create Commit from Diff    | POST   | `/api/repos/{namespace}/{repo}/diff-commit`          |
| Get File                   | GET    | `/api/repos/{namespace}/{repo}/file`                 |
| Get File Headers           | HEAD   | `/api/repos/{namespace}/{repo}/file`                 |
| List Files                 | GET    | `/api/repos/{namespace}/{repo}/files`                |
| List Files with Metadata   | GET    | `/api/repos/{namespace}/{repo}/files/metadata`       |
| Create Git Credential      | POST   | `/api/repos/{namespace}/{repo}/git-credentials`      |
| Delete Git Credential      | DELETE | `/api/repos/{namespace}/{repo}/git-credentials/{id}` |
| Update Git Credential      | PUT    | `/api/repos/{namespace}/{repo}/git-credentials`      |
| Grep                       | POST   | `/api/repos/{namespace}/{repo}/grep`                 |
| Merge Branch               | POST   | `/api/repos/{namespace}/{repo}/merge`                |
| Preview Merge              | GET    | `/api/repos/{namespace}/{repo}/merge/preview`        |
| Delete Note                | DELETE | `/api/repos/{namespace}/{repo}/notes`                |
| Get Note                   | GET    | `/api/repos/{namespace}/{repo}/notes`                |
| Create or Append Note      | POST   | `/api/repos/{namespace}/{repo}/notes`                |
| List Notes Refs            | GET    | `/api/repos/{namespace}/{repo}/notes/refs`           |
| Pull Upstream              | POST   | `/api/repos/{namespace}/{repo}/pull-upstream`        |
| Reset Branch to Commit     | POST   | `/api/repos/{namespace}/{repo}/reset-commits`        |
| Restore Commit             | POST   | `/api/repos/{namespace}/{repo}/restore-commit`       |
| Get Tag                    | GET    | `/api/repos/{namespace}/{repo}/tag`                  |
| List Tags                  | GET    | `/api/repos/{namespace}/{repo}/tags`                 |
| Create Tag                 | POST   | `/api/repos/{namespace}/{repo}/tags`                 |
| Delete Tag                 | DELETE | `/api/repos/{namespace}/{repo}/tags/{tag}`           |

### Files, history and search

- `GET /commit?sha=<revision>` returns full metadata, parents, tree and signature payload when present. `/commits?ref=main&path=src&limit=20` filters path history. Revisions support full/unambiguous short SHA, refs, `~n`, and `^n` within traversal budgets.
- `/files` and `/files/metadata`: `ref`, `path`, `recursive`, `limit`, `cursor`; metadata includes last change. Cursor queries must retain their original filters and pinned revision.
- `/file?ref=main&path=README.md`: raw bytes; GET/HEAD support ETag, Last-Modified, If-Match, If-None-Match, If-Modified-Since, If-Unmodified-Since, If-Range and a single byte Range. Unsatisfied ranges return 416.
- `POST /archive`: `{ref?,include_globs?:string[],exclude_globs?:string[],max_blob_size?,archive?:{prefix?}}` streams gzip tar with modes, links and PAX long paths. Path filters are globs; archives do not dereference links.
- `POST /grep`: `{ref?,query:{pattern,case_sensitive?},paths?,file_filters?,context?:{before?,after?},limits?:{max_matches_per_file?,max_lines?},limit?,cursor?}`. RE2 regular expressions; unsupported patterns and budget exhaustion fail explicitly. See SDK/test examples for additional file filters.
- `/diff?ref=<new>&base=<old>` compares commits; omitted base uses the first parent. `/branches/diff?source=feature&target=main` uses a unique merge base. Result contains a native Git unified/binary diff. Multiple bases require an explicit base.
- `/blame?ref=main&path=src/app.ts` returns line attribution; repeated `ranges` select numeric, regex or function ranges. Range parser details and fixtures are in `src/git/blame-range.ts` and `tests/forge.test.ts`.

### Ref writes, commit streams and merging

- Create branch: `{target_branch,base_ref?|base_branch?,base_is_ephemeral?,ephemeral?}`. DELETE `/branches` takes JSON `{branch,expected_sha?,ephemeral?}`.
- POST `/tags`: `{name,ref?|sha?,ephemeral?}` creates a lightweight tag. Native Git supports annotated tags. DELETE `/tags/:tag` URL-encodes the complete tag name.
- Notes GET uses `sha` and optional `notes_ref`; POST `{sha,note,operation?:"create"|"append",notes_ref?,expected_ref_sha?}`; DELETE takes `{sha,notes_ref?,expected_ref_sha?}`. These are real Git notes refs, interoperable with `git notes`.
- `/commit-files` takes `{target_branch,commit_message,author?,committer?,expected_target_sha?,base_ref?,base_branch?,ephemeral_base?,ephemeral?,files}`. Each file uses `{path,content,encoding?:"base64",mode?}`, `{path,sha,mode?}` to reuse an existing blob, or `{path,content:null}` to recursively delete. Modes include `100644`, `100755`, `120000`, `160000`. An explicit stale `expected_target_sha` returns 409; null requires an absent branch.
- `/commit-pack`, `/diff-commit`, `/restore-commit` and `/reset-commits` require `Content-Type: application/x-ndjson`. Metadata is the first line. Stream author is required; JSON routes can derive author from the authenticated user. Commit builder metadata adds `files:[{path,content_id,operation:"upsert"|"delete",mode?}]`. Each subsequent line is `{blob_chunk:{content_id,data:<base64>,eof:<boolean>}}`. Every upsert needs EOF; deletes need no content. Limits are in README. No partial stream publishes refs.
- Diff streams use the same metadata and `{diff_chunk:{data:<base64>,eof:<boolean>}}`. Native Git text/binary literal/delta patches, modes, rename/copy and quoted paths are supported; context is strict (no fuzzy application).
- Restore/reset streams contain only `{metadata:{target_branch,base_ref,commit_message,author,...}}`. Both create a new commit with the selected tree and current branch tip as parent; they do not erase history.
- `/merge/preview?source_ref=feature&target_branch=main&include_content=true` is read-only. POST `/merge` takes `{source_ref,target_branch,expected_target_sha?,strategy:"merge"|"ff_only"|"ff_prefer",squash?,allow_unrelated_histories?,source_is_ephemeral?,target_is_ephemeral?,commit_message?,author?}`. Pin source_ref to preview's source SHA and expected_target_sha to its target SHA. Conflicts prevent publication. Source refs remain. Multiple merge bases return an explicit conflict rather than guessing a recursive base.

### Lifecycle and upstreams

Create `/repos` accepts `name` (or generated when omitted), description/visibility/default_branch and optional `base_repo`. `{base_repo:{id:<repository UUID>,ref?}}` forks an owned source into independent R2 objects/refs. An upstream descriptor uses `{provider,owner,name,upstream_host?,mode?,default_branch?}`. Provider values: github, gitlab, bitbucket, gitea, forgejo, codeberg, sr.ht/sourcehut. GitHub `mode:"public"` enables manual one-way pull; GitHub App and generic providers support upstream-first pushes. Generic credentials must be configured before a successful pull.

PATCH repository updates description/visibility/default_branch; DELETE immediately tombstones it and schedules physical cleanup. GET `/repo-url/:id` resolves stable identity to ordinary, ephemeral and import URLs. Deletion requires maintainer permissions; fork sources must belong to the caller. Membership permissions still apply to other operations.

PUT `/upstream` takes an upstream descriptor or null; DELETE `/base` detaches it. POST `/pull-upstream` returns 202 and a persisted job; GET `/sync-status` exposes status, attempts and sanitized errors. Normal heads/tags sync upstream; ephemeral refs and local Notes stay local. A pending uncertain upstream push blocks normal operations until reconciliation; it never returns fabricated success.

Generic credentials: POST/PUT `/git-credentials` `{username,password}`; GET lists IDs/timestamps only; DELETE `/:id`. This collection-level PUT differs from the reference API's credential-ID route. Secrets are AES-GCM encrypted at rest.

GitHub App: browser-session-only GET/PUT/DELETE `/api/integrations/github`; PUT `{app_id,installation_id,private_key,webhook_secret}`. The app needs repository Contents read/write and push webhooks. Deliver to `/webhooks/github/:username`; validate HMAC and installation identity, deduplicate delivery IDs, queue real sync. An unconfigured private App fails explicitly. GitHub App LFS uses installation authorization for the batch endpoint and only action-provided headers for approved storage hosts; generic/public upstream LFS is unsupported.

## MCP

POST `/mcp` implements stateless Streamable HTTP JSON-RPC (protocol versions 2025-03-26, 2025-06-18, 2025-11-25). Configure `Authorization: Bearer <PAT or JWT>` in your MCP client. Supports initialize, ping, tools/list, tools/call and resources/list/read. GET returns 405: no SSE session is required. Every tool delegates through the same scope/role checks as REST. `/llms.txt` links agent instructions and the OpenAPI document. Never place a token in a URL or checked-in MCP config.
