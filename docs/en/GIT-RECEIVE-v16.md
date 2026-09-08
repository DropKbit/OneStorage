# Streaming Git receive through R2 (v0.16)

[简体中文](../GIT-RECEIVE-v16.md) · **English**

Native HTTPS receive-pack parses incrementally rather than retaining the upload, expanded objects, and deltas together. The server uses JavaScript, with no Git subprocess, disk, or container.

Command headers have independent 128 KiB/256-command budgets. Known stale/forbidden refs are rejected before staging; publication checks them again. Compressed input is first staged in chunks up to 4 MiB, reducing fine-grained R2 writes while the HTTP upload remains open. Objects/unresolved deltas live under `repos/<repo-id>/incoming/<session-id>/`, packed into target-4-MiB/1,024-entry blocks, with oversized objects alone. Offset metadata locates entries; reads copy and revalidate one object/delta, avoiding retaining a whole block for one small cache entry.

Only after pack SHA-1, EOF, and all deltas pass are canonical objects conditionally persisted to permanent keys. The DO verifies closure/policy before refs publish. Up to 4,096 objects/16,384 edges of already-persisted session metadata reduce rereads without bypassing type, existence, reachability, or authorization. Restart/budget overflow falls back to R2 verification. Later persistence/policy failure can leave unreachable objects; this is not complete unreachable-object GC.

Before the first R2 write, the DO persists a session marker and alarm. Busy alarms reschedule 30 seconds later without waiting out their execution budget on the HTTP queue. Idle cleanup is serialized. Request completion deletes up to 1,000 temporary keys; remaining pages are reclaimed by alarm. Markers disappear only after full cleanup. Eight pending cleanup sessions block new imports until recovery; project deletion also removes them.

## Budgets

| Item                                               | Budget                         |
| -------------------------------------------------- | ------------------------------ |
| Native receive including headers                   | 64 MiB                         |
| Pack entries                                       | 25,000                         |
| Expanded data, delta instructions/results included | 256 MiB                        |
| Object / delta depth                               | 8 MiB / 64                     |
| Parser input / compressed staging block            | 16 KiB / 4 MiB                 |
| BYOB buffer                                        | 64 KiB                         |
| ObjectStore LRU                                    | 8 MiB / 1,024 entries          |
| Permanent write queue                              | 8 MiB / four concurrent writes |

Other writes retain two channels. Native input prefers BYOB; fallback reader chunks are at most 1 MiB. Twenty seconds without input progress aborts; R2 processing time is not input-idle time. Account/platform CPU, memory, request-body, and subrequest limits still apply. Payload/staging/cache metrics describe components, not total V8 memory. Logs exclude file contents and credentials. Upstream buffered parsing, fork staging, archive/history have separate limits.

## Historical acceptance

v0.16 passed type checking/182 unit tests and core 43 assertions plus native Git/LFS. `test:receive-scale` pushed 2,100 small files plus five 7-MiB random files once: 2,108 objects, production pack 36,818,954 bytes. Local passed 35 checks; production 33, covering v0/v2 clone, incremental push/fetch, strict fsck, refs, anonymous denial, and cancellation recovery.

Production times: initial push 724,553 ms; v2/v0 clone 330,094/159,425 ms; incremental push 7,424 ms; v2/v0 fetch 3,672/2,339 ms. Input used nine compressed blocks, eight temporary blocks, 2,108 permanent writes, and one additional closure read. Payload/staging/write peaks were about 7 MiB. Full clones read 2,107/2,108 objects; incremental fetches read zero. Subsequent ls-remote passed the 30-second threshold after cancellation. Separate production writes/DAG/fsck passed 57 assertions. Fixtures were removed without revoking the user's existing PAT.

An initial implementation received 502 after about 33 seconds/68 KiB/652 temporary objects, publishing no refs; provider cancellation cause was unknown. A second version hit alarm/upload wall-time limits. Coalesced staging, deferred busy alarms, four bounded writes, and persisted metadata reuse preceded the passing final run. Permanent object keys/schema did not change. Cold import/clone performance and large fork/history algorithms remain limited; see [scale plan](GIT-SCALE-PLAN.md).
