# Merge queue (v0.31)

[简体中文](../MERGE-QUEUE-v31.md) · **English**

The merge queue uses Durable Objects for coordination, R2 for candidate Git objects, and D1 for visible state. It reuses existing Queues and the Workers/external-runner CI system.

Configure target-branch CI inline or in the repository JSON file. Explicit enqueueing runs independently of the normal push trigger. Maintainers and owners choose fast-forward/three-way merge or squash; fast-forward-only cannot be combined with squash. The interface polls every ten seconds without resetting an active review form. A protection rule with `require_queue` rejects manual writes to the protected target branch.

Each target branch has a FIFO queue; different targets are driven round-robin. Missing reviews, conflicts, invalid configuration, or failed CI block that queue's head. Cancel or requeue it to proceed. Retrying an ordinary CI run cannot substitute for the run bound to a queue entry.

## Candidate and publication

An entry pins the source SHA, target SHA, merge-request revision, and merge options. Candidate objects are created in R2 before publication. CI tests that exact candidate SHA, and the same SHA is published. The target-SHA configuration fingerprint and the successful root workflow aggregate must match. Merge-request runs retain untrusted-source restrictions on secrets and private packages. Authorized users can read a candidate by SHA or archive, but it has no branch reference.

When the target moves, the system updates the merge request's target/revision, cancels CI, and rebuilds the candidate; old approvals become invalid. Source changes, edits, refreshes, or closure cancel the intent and require another enqueue.

Publication rechecks the queue head, permissions, lifecycle, reviews, snapshots, configuration fingerprint, and CI. The Durable Object atomically records the reference result, issue plan, and events. D1 projection is idempotent and recovered before retrying publication.

An accepted write-session/PAT intent lasts 24 hours. Logging out or revoking that one token does not cancel it. An authentication-epoch change, disabled account, archive, transfer, or deletion cancels it. Role revocation is checked on the next drive and again at publication. The source must remain readable. Internal committed-reference reads avoid cross-object lock cycles; there is no distributed lock across two repository objects.

A durable wake-up is recorded before accepting an intent. Each generation has a fixed CI event identity. Recovery handles lost responses; SQL rejects stale runs and unlinked earlier runs.

## API and limits

- `GET /api/repos/:namespace/:repo/merge-queue?mr_id=…`
- `POST /api/repos/:namespace/:repo/merges/:id/queue`: requires revision and strategy; squash is optional.
- `DELETE /api/repos/:namespace/:repo/merge-queue/:id`
- `PUT` branch protections supports `require_queue`.

At most 100 active entries per project and one per merge request; the interface shows the latest 20 completed entries. Staged processing can add roughly 15 seconds between phases, with other work adding delay; this is not an SLA. Candidates execute sequentially, not as a speculative merge train. See [verification](VERIFICATION-v31.md).
