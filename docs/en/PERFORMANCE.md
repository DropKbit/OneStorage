# Page loading performance

[简体中文](../PERFORMANCE.md) · **English**

## v0.39: Durable root cache and prewarming

Root directory and README content are cached by the Git target object ID in the repository Durable Object. Ordinary and ephemeral namespaces each have one fixed slot, capped at 96 KiB with a seven-day expiry. Authorization, branch lists, and the default branch are never cached. Every request still checks current authorization, deletion, project version, and refs; changed refs immediately select fresh content.

Background maintenance after push/sync events prewarms the default branch. Cached content survives DO reconstruction. Oversized entries, cache failures, expired entries, subdirectories/files, and complex revisions retain the existing verified-object read path. A new commit without prewarming still requires R2 reads on its first visit. Git protocol and repository size budgets are unchanged. Repository deletion removes the cache.

Server-Timing exposes browse duration and hit/miss state, r2_reads, repo_queue, and repo_total, without paths, credentials, or user content.

Validation: 387 tests pass. The local test:browse-cache acceptance verifies automatic prewarming, private authorization on hits, and immediate visibility after writes. Native Git/LFS/concurrency acceptance passes. After stopping and restarting workerd, an existing root cache hit requires zero R2 reads. The fresh-object-store unit comparison is three initial reads versus zero durable-hit reads. These are not global p95 measurements or guarantees for never-warmed repositories.

The following measurements describe historical v0.3.1 behavior. Language negotiation changed HTML ETag handling in v0.38.

Measured on 2026-09-08 at `git.1s.hk`, using private repository `1shk/nb`. This historical release addressed the full-page “connecting” screen on refresh and slow page navigation.

## Causes and changes

- Previously, rendering waited for identity, repository metadata, branches, directory contents, and README. HTML now includes public navigation and skeletons. Navigation responds immediately; identity and page data load concurrently. Leaving a page cancels old GET requests so stale responses cannot overwrite the next page.
- Public HTML, JS, and CSS previously queried identity storage and used `no-store`. Assets now run before authentication with identity headers removed. At this release, HTML revalidated with ETags; content-hashed JS/CSS cache for one year, and dependency modules are preloaded. API and Git requests remain individually authenticated. v0.38 language-specific HTML instead varies by language/cookie and does not reuse an untranslated ETag.
- `GET /api/bootstrap` combines identity and setup checks. `GET /api/repos/:namespace/:repo/browse` returns branches, default branch, directory or file, and README at one commit in one DO request, replacing three sequential calls. The default branch and edit links use current DO state.
- Owners no longer need a membership-table query. Metadata responses reuse the resolved role; read-only DO requests avoid repeating outer repository checks.
- Each DO caches verified, persisted objects for five minutes, with limits of 8 MiB / 512 entries / 1 MiB per entry. Bytes are copied, caches are repository-scoped, and failed writes/unpublished objects never enter them. References and authorization decisions are not cached. Browser metadata reuse lasts 15 seconds in memory and is cleared by writes or permission errors; data endpoints still authorize requests.

## Production measurements

Node `fetch` measured complete response reads for one repository with the same account token. Previous version: `d3a0104`; first improved deployment: `59277d89-4701-46f6-b325-5cf642b67b5b`.

| Measurement                                                    | Before                  | After                                   |
| -------------------------------------------------------------- | ----------------------- | --------------------------------------- |
| Sequential repository, branches, directory, README             | 4,920 ms                | Parallel metadata + aggregate browse    |
| First aggregate browse after deployment                        | Unavailable             | 760 ms                                  |
| Completion of three parallel identity/metadata/browse requests | Unavailable             | 386 / 211 / 218 ms across three samples |
| Conditional public HTML                                        | Full download, no-store | 304, 143 ms                             |
| Versioned JS                                                   | No persistent cache     | public, max-age=31536000, immutable     |

Another comparison using the old individual endpoints measured 547 / 743 / 950 / 842 ms. Network, connection, and backend location still affect latency; the best sample is not a performance promise. These are not full browser rendering, FCP, p95, or global benchmarks. DO restarts and cache expiry still require R2 reads.

## Verification

- TypeScript and 60 unit tests passed, covering public assets bypassing identity storage, private API/Git authorization, cache isolation/copying/failed writes/capacity/TTL.
- Local workerd passed 43 basic HTTP checks plus native Git/LFS/concurrency, and 76 advanced checks covering empty directories, aggregate consistency, content, default branches, read-after-write, and token revocation after cache hits. Signed pushes and revocation checks passed.
- Browser navigation between code, commits, and Git tools was checked with real contents.
- Production aggregate results matched the old directory/README endpoints. Anonymous and invalid-token private access returned 401. APIs remained no-store; conditional public HTML returned 304 and versioned scripts cached correctly.
- Production build passed without database migrations, containers, or additional paid services.

## v0.40: File list update times

File and directory rows receive relative update times after the listing renders. Tooltips show exact committer dates. A fixed page commit anchors a first-parent walk for each path's latest content or mode change. Merged content uses the merge commit date, renames count as new-path changes, and directories track tree changes. Repository creation dates and unrelated tip commits are never substituted.

`GET /api/repos/:namespace/:repo/tree-updates?ref=<fixed-commit>&path=<directory>` returns `ref`, `path`, `updates` (name/date/commit), `complete`, and `limited`. Repeated requests advance at most 16 commits each, with a 5,000-commit traversal ceiling. Each namespace has one 96 KiB progress slot expiring after seven days; changed refs or paths restart the walk. Current repository read authorization applies. Budget limits or failures show a dash rather than invented dates. Navigation cancels subsequent requests. This cache is separate from the v0.39 root cache and is removed on repository deletion.
