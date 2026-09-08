# Collaboration search (v0.28)

[简体中文](../SEARCH-v28.md) · **English**

The `/search` page and `GET /api/search` search project metadata, issues, merge requests, and current wiki pages directly in D1. Results include title/body matches and snippets of up to 320 characters. Switching spaces preserves the query and filters while resetting pagination. Since v0.32, code search is a separate `type=code` option; `all` still means collaboration content.

## Parameters

- `q`: a single line of 1–128 UTF-16 code units. Search is literal: ASCII case is folded, other Unicode characters match exactly. `%`, `_`, slashes, and quotes have no wildcard meaning.
- `type`: `all`, `project`, `issue`, `merge`, or `wiki`.
- `namespace`: omitted/empty searches all accessible namespaces.
- `state`: `all`, `open`, `closed`, or `merged`; non-`all` applies only to issues and merge requests.
- `archived`: `include` (default), `exclude`, or `only`.
- `limit`: 1–50, default 30.

The response contains `results`, `has_more`, and `next_cursor`. Ordering is by type, repository UUID, and string ID—not numeric ID, relevance, or time. Keyset cursors are bound to the user and filters and validated, but are not credentials. Results are live; pagination is not a consistent export snapshot.

## Access and boundaries

The same D1 batch checks current credentials and selects authorized rows. Permissions include personal ownership, direct membership, inherited space membership, and public access. A former creator has no implicit team-project rights; administrators cannot bypass private-project access. Anonymous callers can search public content. Read-only PATs work; repository JWTs and deploy tokens do not.

Transfers use the current address and permissions. Archives remain readable. Deletion and revocation take effect without waiting for a search index. Responses use `no-store`. The interface escapes content before highlighting and does not render result snippets as Markdown.

Comments, review threads, wiki history, attachments, and Git history are excluded. [Code search](CODE-SEARCH-v32.md) has its own scope. There is no first-N-project cutoff or per-project R2/DO fan-out. The form renders before results and cancels stale requests. Substring scans use existing indexes; this is not an FTS or large-scale performance guarantee.

D1 export limitations for FTS5 virtual tables motivated ordinary tables, without extra resources or a migration. References: [D1 export](https://developers.cloudflare.com/d1/best-practices/import-export-data/), [SQLite support](https://developers.cloudflare.com/d1/sql-api/sql-statements/), and [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

Run `npm run test:search`. Remote acceptance requires explicit opt-in and a private token file; Playwright is optional. The test cleans its resources and disables its temporary user.
