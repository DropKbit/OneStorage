# Default-branch code search (v0.32)

[简体中文](../CODE-SEARCH-v32.md) · **English**

This guide describes the initial v0.32–v0.33 implementation. [v0.34 content reuse](CODE-CONTENT-v34.md) avoids rewriting unchanged content while retaining these search semantics.

Choose code search or pass `type=code` to `/api/search`. Queries require at least three Unicode code points and at most 128 UTF-16 code units. Matching is literal, ASCII case-insensitive, and exact for other Unicode characters. Filters include namespace, path, extension, and archive status. Each matching file returns its first matching line/snippet and a link pinned to the indexed commit. `type=all` does not include code.

The project page shows index status, time, coverage, and skipped files. Maintainers can rebuild, including for archived repositories. Reads enforce current access; administrators do not bypass private access. A write session or PAT can rebuild; repository JWTs and deploy tokens cannot.

## Index lifecycle

A Durable Object traverses a fixed default-branch tree in chunks of 256 entries and eight files. D1 stores the durable cursor, documents, and trigrams in batches. A new generation remains hidden until atomic publication. The old generation becomes stale after a push; changing the default branch hides the old branch's results. Cleanup removes five old documents per pass, with foreign-key cleanup of postings.

Push and upstream synchronization persist an indexing intent and alarm. The authoritative default branch comes from the Durable Object; a D1 retry marker repairs its projection before indexing. A five-minute cron initializes up to 50 legacy projects and wakes up to 20 indexes. Attempt timestamps are recorded before RPC for fairness. Errors retry with a generic visible status. There is no indexing SLA; frequent pushes can cause repeated rebuilds in this initial version.

Migration `0026` adds ordinary `code_index_state`, `code_documents`, and `code_postings` tables. Trigrams narrow candidates, then full literal matching verifies them. Identity, results, and coverage share a D1 batch. Common trigrams can still produce many candidates; this is not a large-scale performance promise.

## Supported content and budgets

Only ordinary UTF-8 files on the default branch are indexed. Other branches/history, comments, actual LFS payloads, submodules, symlinks, regex, and full Unicode case folding are excluded.

Each file is limited to 256 KiB and 65,536 distinct trigrams. NUL-containing, invalid UTF-8, oversized, or excessively complex files are skipped. Each project is limited to 10,000 files, 64 MiB of text, and two million postings. Paths are limited to 1,000 bytes and depth 64; inaccessible subtrees are not scanned. Partial coverage describes only scanned content. Path filters do not shrink project-level coverage, and building/published counts are distinct.

D1 storage and read/write charges apply, including overlapping old and new generations. The index is derived and rebuildable. Git objects remain in R2; a D1 backup alone cannot restore the service.

## API and verification

`GET /api/search?type=code` accepts the filters above, a default limit of 30 (maximum 50), and a context-bound cursor. Results include path, snippet, line, blob SHA, indexed commit, branch, time, and stale status.

`GET /api/repos/:namespace/:repo/code-index` reads status. `POST …/code-index/rebuild` returns `202`. Pending requests coalesce before work starts; requests during processing defer another generation. Intent is durable before wake-up.

Run `npm run check` and `npm run test:code-index`. Acceptance uses real local Workers, native Git, migrated D1, and an isolated browser. Remote execution requires explicit environment opt-in and Playwright. Do not change the runtime during acceptance or its cleanup. See [verification](VERIFICATION-v32.md).
