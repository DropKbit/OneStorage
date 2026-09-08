# Durable Git object indexing and streaming downloads (v0.12)

[简体中文](../GIT-SCALE-v12.md) · **English**

This historical release removes whole-repository object/pack retention from native downloads and lets incremental pushes reuse verified history. It does not by itself solve large initial imports, forks, synchronization, or all history algorithms. See [current limits](LIMITS.md).

Each repository's SQLite Durable Object indexes object type, length, and typed edges. R2 objects are hash/length-checked and conditionally written first. Children are indexed before parents; a synchronous transaction marks a parent only after its complete child closure is durably verified. Existing trusted boundaries are reusable. Old repositories build the index on demand and recover completed subclosures after interruption.

Index/publication failure cannot advance refs. Complete unpublished objects/index entries may remain, but are not authorization: wants/haves must be reachable from currently visible refs. Ordinary and ephemeral namespaces remain separate; indexes belong to one repository UUID. Deletion removes objects and index tables; general unreachable-object retention is unchanged.

Request reads use an 8 MiB/1,024-entry LRU; unpersisted staging remains 32 MiB and is released on flush. Pack generation compresses one object at a time using 16 KiB inputs and incremental SHA-1, with backpressure. v0 raw/sideband and v2 packfile sections share the generator. The repository queue is released only after completion/error/cancellation and draining started I/O; a 20-second idle timer ends unconsumed streams. Lifecycle operations retain ordering.

v2 returns ACK/ready and incremental packs for common haves. v0 advertises `multi_ack_detailed` and HTTP `no-done`. Unpublished/invisible objects cannot receive ACKs or become wants.

Historical budgets: 8 MiB/object; incoming 16 MiB/2,000 objects/32 MiB expanded; reachability planning 100,000 objects and outbound pack 512 MiB. The incoming path was later expanded in [v0.16](GIT-RECEIVE-v16.md). The main Worker config allows 250,000 subrequests for theoretical cold-index/read passes; actual acceptance was far smaller and account CPU/memory/plan limits still apply. These are operation budgets, not guaranteed repository capacity.

Cold clone initially read each R2 object serially, with neither outgoing delta nor pack cache; [prefetch](GIT-PREFETCH-v13.md) and [pack caching](GIT-PACK-CACHE-v17.md) improve it. Fork/MR import, upstream clients, tree/history/signature/merge/blame/archive algorithms retain independent budgets, including 32 MiB fork staging. `Git transfer drained` logs I/O and cache/staging component peaks, never content/credentials or a claimed whole-isolate heap peak. See [verification](VERIFICATION-v12.md) and [scale plan](GIT-SCALE-PLAN.md).
