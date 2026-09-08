# Git scale: implemented steps and remaining work

[简体中文](../GIT-SCALE-PLAN.md) · **English**

The v0.8 source repository had 408 reachable objects/4,794,833 expanded bytes. Passing it did not establish large GitLab-project support. The old operation cache was 32 MiB, with repeated full-graph traversal and a 5,000-object limit. Raising constants alone was insufficient.

The plan requires repository-isolated durable typed closure indexes; incremental verification at trusted boundaries; atomic/recoverable index/ref consistency; bounded reachability/streaming packs with checksums, compression, backpressure, cancellation, v0/v2/delta/tag/Notes/ephemeral isolation; recoverable old-repository indexing; and separate review of fork/archive/blame/CODEOWNERS/merge-history algorithms. Real native Git acceptance must exceed old limits and record integrity, permissions, cold/warm behavior, I/O, and component memory budgets without treating operation limits as repository capacity.

## Progress

- [v0.12](GIT-SCALE-v12.md): durable closure index, bounded object cache, streaming output, common-have negotiation. Local/production tests used 5,424 objects/42 MiB. A production v2 cold clone took 640,543 ms with 5,423 R2 reads/44,365,169 bytes and a 7,546,745-byte object-cache peak.
- [v0.13](GIT-PREFETCH-v13.md): size-aware bounded prefetch, limiting objects and bytes, with cancellation/failure draining. It preserves room for other I/O; replacing serial reads with unbounded Promise.all would be unsafe.
- [v0.16](GIT-RECEIVE-v16.md): streaming incoming packs, temporary R2 blocks, cleanup recovery, and persisted metadata reuse. It expands native initial-import budgets without changing permanent loose-object storage.
- [v0.17](GIT-PACK-CACHE-v17.md): disposable complete packs keyed by repository/exact authorized object set/output format. Incoming thin packs cannot be blindly reused. Full descriptors publish only after chunks are durable; corruption falls back to permanent objects.
- [v0.18](GIT-READS-v18.md): one bounded page-read snapshot channel during native transfers. Full Git transfers remain serialized, preserving cache-slot lifetime and lifecycle barriers.

## Remaining design constraints

Permanent packed-object storage must work across `src/repository.ts` main/background stores, `src/lifecycle.ts` fork copies, `src/fork-reviews.ts` source imports, and `src/review.ts` CODEOWNERS reads. Define mixed old/new reads, durable location metadata, cross-DO authorization/deadlock rules, aggregate cache budgets, and rollback compatibility. Blocks and locations must be durable before refs; failures preserve prior refs and leave recoverable orphan blocks. Location metadata is never authorization.

Acceptance should cover initial import, cold/warm clone, duplicate content, incremental push, fork/MR, CODEOWNERS, archive/transfer/delete, backup restoration, and Worker restart. Bound active edges for deep/wide trees as well as byte caches. Judge cloud request counts, elapsed time, integrity, and access together; emulator speed alone is insufficient.

Full Git read leases are separate from the page channel. They must address simultaneous-stream memory, retained cache chunks, cancellation, I/O draining, garbage collection, lifecycle confirmation, and old authorization snapshots. Faster repeated clones do not complete cold-import or concurrency work. Large fork/history algorithms and broader scale/recovery acceptance remain limited. See [current limits](LIMITS.md) and [roadmap](ROADMAP.md).
