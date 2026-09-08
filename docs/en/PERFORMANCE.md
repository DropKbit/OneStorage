# Page loading improvements — v0.3.1

[简体中文](../PERFORMANCE.md) · **English**

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
