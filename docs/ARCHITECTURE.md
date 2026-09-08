# Architecture — v0.3 baseline

The Git storage/HTTP path is extended by [v0.12 indexing and streaming](GIT-SCALE-v12.md); cloud execution and collaboration are documented in [v0.5+](CLOUD-NATIVE-v05.md).

Independent implementation inspired by public Code Storage documentation. All Git processing is JavaScript in Cloudflare Workers; no container, native Git process, SSH daemon or repository-code execution. Native Git is only the test client/oracle. Web Crypto performs hashing/signature checks, pako handles zlib, RE2JS bounds regex matching, jsdiff/node-diff3 implement text comparison/merge, OpenPGP handles armored signatures.

```mermaid
flowchart LR
  Client[Git / Browser / SDK / MCP] --> W[Worker: identity and permissions]
  W --> D1[D1: metadata, encrypted credentials, jobs]
  W --> DO[Repository Durable Object: serialized operations]
  DO --> R2[R2: immutable Git and LFS objects]
  DO --> Refs[SQLite: refs, events, reconcile marker, tombstone]
  DO --> Upstream[Approved HTTPS Git / GitHub App]
  Refs --> Q[D1 outbox / Queues / Cron / alarms]
  Q --> DO
  Q --> Hooks[Approved signed webhook delivery]
```

## Object storage and publication

R2 `repos/<UUID>/objects/<SHA1>` stores uncompressed canonical `type size\0payload` bytes. Reads verify SHA-1 and size; conditional creation verifies existing bytes rather than overwriting. No cross-repository deduplication. Trees retain binary blobs, UTF-8 paths, executable bits, symlinks and external gitlinks. Pack input supports v2/v3, OFS_DELTA/REF_DELTA/forward bases/thin packs, with checksums and explicit expansion/graph budgets. Output packs use full zlib-compressed objects.

The outer Worker resolves trusted repository UUID, role, actor, current signing keys and delegation restrictions. A promise queue in the UUID-addressed DO serializes reads/writes (16 queued/in-flight maximum). Every mutation checks expected refs, graph connectivity and policy, writes R2 objects, then atomically persists the complete `refs.v2` dictionary and `push` event records with a single DO storage put. Failure before publication leaves refs unchanged; it can leave unreachable objects. Failure after publication but before response is ambiguous to the client, which must read refs before retrying.

Normal logical heads/tags/notes and `refs/namespaces/ephemeral/` share one atomic ref store. A namespace view prevents internal-path injection and preserves other namespaces on publication. The authoritative default branch lives in DO storage with a D1 metadata projection. Git protocol v0/v2 reads only authorized reachable objects; private repos require membership/credentials. No shallow, filter, SHA-256 repository or SSH transport support.

## Git APIs and signatures

Forge APIs construct real trees/commits, Notes refs, diffs/patches and restore commits. NDJSON streams are consumed incrementally with explicit EOF and decoded limits; objects are still staged in bounded request memory and refs publish only once. Tar generation and raw downloads stream responses. Search uses RE2, traversal and output budgets. Blame traverses parents and uses conservative rename/move/copy attribution. Merge previews are immutable and never publish; three-way merge/squash validates the pinned target and returns conflicts instead of publishing conflict text. Multiple recursive merge bases are explicitly unsupported.

PAT writes retain safe default no-force behavior. Delegated JWTs use independent repository scopes and ordered first-match ref restrictions. `verify-sig` validates every newly introduced commit's SSHSSIG/OpenPGP signature against currently registered public keys; signature text/payload metadata is exposed for clients. API-generated unsigned commits cannot bypass the same central publication hook.

## Lifecycle and asynchronous durability

Fork reserves a new UUID and holds the destination DO queue throughout copying, preventing deletion/GC from racing late object writes. It copies a reachable source snapshot into independent R2 keys, validates/publishes its refs, and clears initialization status. It does not establish future synchronization. Deletion tombstones the DO before hiding/renaming D1 metadata; alarms incrementally delete Git/LFS objects and finally cascade metadata. Operations fail closed against a tombstone. Active-repository unreachable-object GC and cross-store snapshot backups are not implemented.

Ref events are recorded atomically in the DO and idempotently projected to D1 deliveries by alarms. Other collaboration events originate in D1 audit/outbox batches. Queues deliver approved HTTPS webhooks, lease attempts, sign timestamp plus body, cap attempts at five and rely on receiver deduplication. Cron replays pending work. Queue or D1 projection failure cannot lose a committed ref event; Git and collaboration metadata are still not a single distributed transaction.

## Upstreams and recovery

Generic HTTPS Git and GitHub App mode use a pure JavaScript protocol client. Pull downloads/validates the complete bounded reachable graph, persists objects, then publishes heads/tags; local Notes and ephemeral refs remain. Public GitHub mode requires manual one-way refresh. All outbound URLs are validated against known provider/operator hosts; no redirects are followed.

For bidirectional writes, policy validation and R2 flush precede a durable `sync-reconcile` marker and alarm. The server pushes upstream with advertised old SHAs, requiring atomic support for multiple refs, then publishes locally only after upstream acceptance. Any uncertain outcome retains the marker and blocks ordinary operations until a queued/DO-alarm pull reconciles actual upstream refs. Auto-recovery is bounded; manual pull retries remain available. This ordering is not a cross-provider atomic transaction, but avoids acknowledging a fabricated successful push. Ephemeral operations do not leave OneStorage.

Credentials and GitHub App private keys are encrypted in D1 with AES-256-GCM, random IV and repository/account-specific associated data; the encryption key is a Worker secret. GitHub installation JWTs request repository-narrow tokens. Signed incoming webhooks are deduplicated before enqueueing. GitHub App LFS checks batch/action hosts and SHA-256/size before caching; it never sends installation credentials to arbitrary action hosts. Generic/public upstream LFS is rejected explicitly.

## Upgrade and operational boundaries

D1 migrations 0001–0004 are additive; preserve Worker/DO class names, UUID mappings and migration history. The v0.1 tar snapshot importer remains for old local instances; it imports and validates objects before atomic refs and preserves the old snapshot. Later writes are not reflected in the old format, so do not roll back blindly.

Use README resource budgets. Platform CPU, memory and subrequests can fail earlier. No total quota, TB-scale benchmark, production SLA, SHA1DC detector, automatic full-site recovery or independent security audit is claimed. Backups require D1, R2 and DO state (including pending events/reconciliation), plus encryption-key custody. Repository code must never execute in this service.
