# Shared code-index content (v0.34)

[简体中文](../CODE-CONTENT-v34.md) · **English**

Within a repository and cache epoch, a unique blob SHA identifies reusable indexed content. Unchanged files, renames, and copies reuse text and trigrams without rereading R2. Content is never shared across repositories. Paths still come from a complete, fixed tree traversal, and publication remains atomic with live authorization.

Migration `0027` adds `code_contents` and `code_content_grams`; path documents reference content through foreign keys. Old text/postings remain readable while background work converts the index to format 2. Version recovery handles requests consumed by an older Worker. Git storage format and the Durable Object runtime model do not change.

Manual rebuild creates a durable cache epoch and rereads Git. A request counter and force-epoch compare-and-swap prevent concurrent requests from being swallowed; an in-progress rebuild schedules another cycle. Ordinary pushes reuse content in the same epoch, including unpublished content from that repository.

Each processing step writes content, paths, and the cursor in one D1 batch, recovering safely from a lost response. The previous index remains searchable until publication; changing the default branch hides it. Cleanup removes five old paths and then five unreferenced content rows per pass; foreign keys remove grams. Project deletion removes paths, content, then the repository.

Coverage adds `index_version: 2`, `reused_files`, `created_contents`, and `written_postings`. Byte/posting budgets remain logical per-path budgets: copies count toward limits even when physical writes are reused. Skipped files are not negatively cached. [v0.32 limits](CODE-SEARCH-v32.md) still apply. This is not Git-diff indexing or all-history search, and does not promise a particular bill reduction.

Ordinary SQL remains exportable, but restoration also requires identity/configuration, Durable Object state, and R2. Rolling back to v0.33 requires pausing search and rebuilding the old index format.

Run `npm run check` and `npm run test:code-content`. Real Workers, Git, and browser tests cover reuse, manual rebuilds, default-branch changes, revocation, and cleanup. Remote acceptance requires explicit opt-in. See [verification](VERIFICATION-v34.md).
