# Complete Git pack cache (v0.17)

[简体中文](../GIT-PACK-CACHE-v17.md) · **English**

A disposable R2 full-pack cache reduces repeated clone reads while retaining permanent loose objects, ref formats, and fork/background compatibility. No database migration or container is needed.

Every request first checks current credentials/project access, lifecycle/deletion, want reachability, and the exact visible object set. Only full transfers without known haves use the cache; incremental negotiation reads permanent objects. Keys include repository UUID, sorted exact OIDs, and output-format version. A cache locator grants no access.

Cached bytes are non-delta PACK v2; protocol ACK/sideband framing is separate. Namespace, branch, or include-tag changes must select the right object set. Incoming packs are never reused because they may contain unreferenced objects or external delta bases. Compression/output changes must update `pack-v2-full-zlib-v1` for deterministic recovery.

Packs use up to 128 four-MiB chunks within the 512-MiB outbound limit. One write chunk is buffered in addition to existing object/prefetch budgets. Conditional writes and SHA-256 protect chunks; reads validate length/hash before sending bytes. Only a complete pack gets an atomic DO descriptor/retention marker. Each repository has one slot; old cache cleanup precedes replacement. Cleanup failure allows normal Git transfer without adding cache data.

Retention is 24 hours. A durable cleanup marker/alarm precedes writes, recovering incomplete/cancelled builds. Project deletion removes cache and metadata. Missing/corrupt/read-failed chunks invalidate the descriptor and regenerate from permanent objects. If verified prefix bytes were already sent, deterministic regeneration skips that prefix and continues the same response. Permanent-object read errors still fail. Cancellation drains I/O/generators before queue release; cache cleanup cannot block event/sync recovery.

## Historical verification

`test:pack-cache` used 1,105 objects/10 MiB random content with cold/repeated v0/v2 clones, incremental changes, strict fsck, cancellation, and anonymous denial. v0.17 passed 195 unit tests/type checking, 45 local checks, core 43 assertions/Git/LFS, 43 production checks, and 49 production write/versioned-CI assertions.

| Production operation (2026-09-08) |            Time | Permanent R2 reads | Pack chunks |
| --------------------------------- | --------------: | -----------------: | ----------- |
| Initial push                      |        94.364 s |                  1 | none        |
| First v2 clone                    |        56.049 s |                959 | write 3     |
| Repeated v0 clone                 |         9.768 s |                  0 | read 3      |
| Repeated v2 clone                 |         4.957 s |                  0 | read 3      |
| Incremental push                  |         5.131 s |                  — | none        |
| Incremental v2/v0 fetch           | 5.436 / 3.330 s |             0 each | none        |
| First clone after change          |        41.774 s |              1,106 | rebuild 3   |
| Repeated clone after change       |         7.226 s |                  0 | read 3      |

Initial pack was 10,544,939 bytes. “First” means no matching full-pack cache, not a cold/restarted Cloudflare node. All clone/fetch operations passed strict fsck/ref checks. Cache-hit object/prefetch metrics were zero with at most a four-MiB current chunk; these are not total heap measurements. Cancelled download requests drained and subsequent ls-remote passed 30 seconds. Fixtures and R2 prefixes were cleaned. A separate 13-ms cleanup alarm cancellation had no exception and did not prevent cleanup.

These single network samples do not establish global throughput/SLA. Cold import/clone, alternating object sets, and serialized complete transfers remain areas for improvement. See [read concurrency](GIT-READS-v18.md) and [scale plan](GIT-SCALE-PLAN.md).
