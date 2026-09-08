# HTTP API / Git protocol

Base URL: `https://git.1s.hk/api` (local: `http://localhost:8787/api`). API examples use a short-lived personal token in `Authorization: Bearer <token>`. Do not put tokens in clone URLs, query strings or shell history. Browser session mutations additionally require the exact configured `Origin`.

Responses use JSON. Errors contain `{ "error": "..." }`, and validation errors include `details`. Common status codes: 400 validation, 401 authentication, 403 permission, 404 hidden/missing resource, 409 conflict, 413 size limit, 429 saturation, 5xx transient/engine/storage failures.

## Identity

| Method     | Path          | Purpose                                                                 |
| ---------- | ------------- | ----------------------------------------------------------------------- |
| GET        | `/setup`      | Whether initial setup is required                                       |
| POST       | `/setup`      | `{username,password,secret}`; one-time administrator creation           |
| POST       | `/login`      | `{username,password}`; issues session cookie                            |
| POST       | `/logout`     | Revoke current browser session                                          |
| POST       | `/password`   | Session-only `{current_password,new_password}`; revokes all credentials |
| GET        | `/me`         | Current user or null                                                    |
| POST       | `/users`      | Administrator creates `{username,password}`                             |
| GET / POST | `/tokens`     | List/create PATs; creation requires browser session                     |
| DELETE     | `/tokens/:id` | Revoke own PAT                                                          |

Token creation: `{name,scope:"read"|"write",days:1..365}`. Plaintext token is returned once. Passwords are 12–128 characters. Slugs are lowercase letters, digits, `_` and `-`, beginning with a letter/digit, maximum 48 characters. Route names including `api`, `admin`, `auth` and `settings` are reserved.

## Projects

`/repos` supports GET with `q` and zero-based `page`, and POST with `{name,description?,visibility?,default_branch?}`. Namespaces belong to the creating user. Repositories default to private and `main`.

All paths below are relative to `/repos/:namespace/:repo`.

| Method      | Path                                  | Payload / result                                       |
| ----------- | ------------------------------------- | ------------------------------------------------------ |
| GET         | `/`                                   | Repository metadata, role, clone URL                   |
| PATCH       | `/`                                   | `{description,visibility}`; maintainer                 |
| GET         | `/branches`                           | `{branches:[{name,sha}]}`                              |
| GET         | `/tree?ref=main&path=src`             | `{ref,path,entries:[{name,type,mode,sha}]}`            |
| GET         | `/blob?ref=main&path=README.md`       | UTF-8 content, binary flag, size, resolved ref         |
| GET         | `/search?ref=main&q=keyword`          | Literal text search, 200 matches maximum               |
| GET         | `/commits?ref=main`                   | Last 30 commits                                        |
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

File API: `content:null` deletes a path. `expected_sha:null` creates an absent branch; otherwise provide its last observed SHA. Use native Git to create a branch from another branch. API errors or connection loss may follow a committed mutation: read the ref before retrying. Issue and MR numeric IDs are instance-wide, not project-local sequences.

## Git

```sh
git clone https://git.1s.hk/alice/project.git
# Username: alice
# Password: your PAT (never your account password)
```

Supports HTTPS smart HTTP `info/refs`, `git-upload-pack`, `git-receive-pack`, protocol v0/v2, pack negotiation, refs and tags. SSH, dumb HTTP and encoded/compressed HTTP request bodies are not implemented. Clients using request compression should disable it. Private clones require a PAT; anonymous public clones work. Force pushes that rewrite history and existing tag rewrites are rejected. Default branch deletion is forbidden. Push batches are all-or-nothing. SHA-256 Git repositories, shallow clone and partial clone/filter are not implemented. Incoming OFS_DELTA, REF_DELTA and thin packs are accepted; output packs contain complete zlib-compressed objects. See README for object, pack and traversal budgets.

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

All audited project events trigger delivery, e.g. `repo.commit`, `git.receive_pack`, `issue.create`, `issue.closed`, `merge_request.create`, `merge_request.merge`, `member.update`. `git.receive_pack` records a receive-pack operation; Git can reject individual refs inside an HTTP-200 response, so it does not imply every requested ref changed.

Payload: `{id,event,repository_id,actor,detail,timestamp}`. Headers: `X-OneStorage-Delivery`, `X-OneStorage-Timestamp` (Unix seconds), `X-OneStorage-Signature` (`sha256=<hex>`). Compute HMAC-SHA256 over `timestamp + "." + rawBody` with the returned secret, compare in constant time, enforce a recent timestamp window, and deduplicate using the delivery ID. Responses must be 2xx within 10 seconds; redirects are not followed.
