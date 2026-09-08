# Page reads during Git transfers (v0.18)

[简体中文](../GIT-READS-v18.md) · **English**

A bounded read-only snapshot channel lets common pages read committed refs and immutable objects while native Git uploads/downloads hold the main queue. It performs no ref publication, shared SQL indexing, or pack-cache collection. Full Git operations remain serialized and drain streams/I/O before releasing their barrier.

After migration/initialization, selected GETs and native transfers can open the channel. Trees, files, branches, tags, commit lists/details, and raw conditional reads share existing implementations. Each response pins ordinary or ephemeral refs, so tree and README remain at one commit even if a branch moves. Revision mismatch returns 409; deleted projects return 404. Cache hits cannot bypass checks.

Lifecycle, sync, fork, and other exclusive work close admission as soon as queued, then wait for snapshots to drain before starting. Current account/token/space/project authorization remains in the outer Worker. New requests see revocation; already-authorized in-flight semantics are unchanged. Explicit non-tip SHAs, short SHAs, and ancestor selectors retain the serialized path to avoid exposing unpublished objects.

## Budgets and fallback

Only one additional active snapshot response per isolate, even across repository DOs. Each repository queues at most four snapshots within the overall 16-request queue. Snapshot objects are at most 256 KiB, with 64 object accesses and 1 MiB cumulative returned object data/response. Cache hits count too; bytes are reserved before concurrent reads and large R2 objects fall back before consuming their bodies. No shared reachability-index updates occur.

Buffered responses are limited to 2 MiB while retaining status, Range, HEAD, and conditional semantics. Budget excess, stale lifecycle cache, or a busy isolate slot drains started reads then re-enters the main queue without imposing a new user-visible file-size rejection. Twenty-second idle timeout and complete I/O draining apply. `X-OneStorage-Read-Mode: snapshot` identifies the path but grants no access. Component budgets are not total heap claims.

## Historical acceptance

Type checking/208 tests passed, covering scheduling, concurrent writes, lifecycle waits, fallback, failure/cancellation, isolate slots, cached-byte accounting, and real repository preconditions. Expanded local transfer tests passed 68 checks; core 43 assertions/Git/LFS, archive 63, transfer 79. Production expanded transfer tests passed 57 checks and write/versioned-CI regression 43 assertions.

The production fixture had 1,108 objects/10 MiB. Native push took 74.5 seconds; during it, committed seed-tree/README snapshot reads were observed within 7.22 seconds including polling/network. Queued archive waited about 66.7 seconds, then succeeded. After restoration, a paused-download snapshot took 767 ms. First v2 clone took 41.8 seconds; cached v0/v2 clones 3.74/3.26 seconds; after an increment, first/cached clones 27.5/7.59 seconds. All passed strict fsck; snapshot diagnostics recorded no R2 writes. Fixtures/R2 prefixes were cleaned. These are single samples, not latency guarantees.

An initial production artificial paused-input probe did not produce snapshot evidence and was recorded as failed, then cleaned. A four-byte empty Git request likewise did not establish overlap while its body was paused; the responsible network component was not identified. Final production acceptance used a real large native push's R2 persistence window, while local tests retain the artificial pause case.

Full-transfer concurrency, cold imports/clones, large histories, and complex algorithms remain separate work; this does not remove all page waits. See [scale plan](GIT-SCALE-PLAN.md).
