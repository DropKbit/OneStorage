# Bounded Git object prefetch (v0.13)

[简体中文](../GIT-PREFETCH-v13.md) · **English**

v0.12 production cold clones of 5,424 objects/42 MiB random content took 6–11 minutes. v0.13 adds bounded concurrent outbound reads while retaining durable closure verification and streaming packs.

Only objects selected by current-reference authorization and reachability planning may be prefetched. Verified sizes allow four queued/in-flight/consumed objects with at most 8 MiB reserved payload. The object being compressed still occupies a slot. Unknown sizes reserve 8 MiB each and fall back to serial reads. Completion can be out of order; output follows the plan. Backpressure only completes the existing window, without scanning ahead indefinitely.

ObjectStore still checks type, length, and SHA-1; prefetch checks OID/size against the plan. Compression uses 16 KiB input blocks. Reservations and `prefetchPeakBytes`/`prefetchPeakObjects` are component budgets, not isolate memory peaks: hashes, canonical bytes, caches, compression, and reachability also consume memory.

Each read installs success/failure handlers immediately. Failure or cancellation stops new reads and drains started I/O before releasing the outer queue. Lifecycle operations cannot overtake pending cache updates. Reference transactions, visibility, immutable writes, incoming budgets, and lifecycle policy are unchanged.

## Historical verification

Type checking and 145 tests passed, covering concurrency, ordering, backpressure, byte reservations, fallback, invalid metadata, failure draining, checksums, and cancellation order. Local native Git acceptance passed 49 checks for 5,424 objects/42 MiB; production passed 47. Core Git/LFS/access regression passed 43 API assertions. Fork-review UI passed 60 checks plus 201 fixture requests; general UI passed 43.

One initial production push failed before download prefetch. Cleanup and a fully logged rerun succeeded, but historical telemetry access was denied and the original cause remains unknown.

| Operation            |      v0.12 |      v0.13 |
| -------------------- | ---------: | ---------: |
| v2 full clone        | 640,543 ms | 180,763 ms |
| v0 full clone        | 366,723 ms |  94,475 ms |
| Incremental push     |   4,192 ms |   4,146 ms |
| v2 incremental fetch |   5,519 ms |   5,211 ms |
| v0 incremental fetch |   3,496 ms |   4,175 ms |

These single successful runs had uncontrolled network/cache differences, not an SLA. Full-clone reads remained 5,423/5,424 (44,365,169/44,365,416 bytes), with 7,340,499 reserved bytes/four objects. Request-cache peaks were 7,546,743/7,546,745 bytes. Incremental fetches read zero R2 objects and reserved 514 bytes/three objects. Cancellation drained after 101 reads; subsequent ls-remote completed within 30 seconds. Fixtures were cleaned. Six push batches still took roughly 76–94 seconds each, and full streams held the main queue. See [next steps](GIT-SCALE-PLAN.md).
