# Project archival (v0.10)

[简体中文](../ARCHIVE-v10.md) · **English**

Project owners can archive as read-only or unarchive in Settings. Workspace projects require the workspace’s current owner; the original creator cannot bypass ownership. Administrator status alone does not grant archival rights, though existing repository deletion and workspace ownership recovery remain available.

`PUT /api/repos/{namespace}/{repo}/lifecycle` accepts `{"archived":true,"revision":0}`. Use lifecycle_revision from project details. Archiving and restoring increment it; stale revisions return 409 instead of overwriting another operator. Read-only PATs and delegated Git JWTs cannot change lifecycle state.

## Archival contract

- Preserve UUID, Git references, R2 objects, issues/MRs/comments, wiki history, releases, CI history, and artifacts. Authorized reads, clone/fetch, search, source archives, and fork export remain available.
- Reject ordinary/ephemeral/import pushes, LFS upload, web/API file writes, branches/tags/notes, merges/reviews, collaboration writes, wiki/releases, upstream configuration/sync, pipeline configuration/new jobs, deployment versions, and environment changes.
- One D1 transaction cancels queued/running CI, clears leases, and cancels pending sync. Runners cannot claim archived jobs. Restoration neither revives cancelled runs nor old leases. Already-started functions/processes may run until timeout or cancellation detection, but cannot publish artifacts or success.
- Public apps keep their last active version. Activation/rollback is blocked while archived. Disable public access before archiving, or restore the project first.
- Access management, runner credential revocation, personal stars/watches, and reading notifications remain available. Archiving is not permanent credential revocation; valid credentials follow current permissions after restoration.
- Deletion and garbage collection still work. Restoration does not retry CI or sync automatically.

## Write consistency

Lifecycle changes share the repository DO queue with reference publication. Durable D1 archival state is reread inside the queue, rejecting Git/LFS writes that passed earlier outer authorization. The barrier survives DO restarts. Archival state, revision, cancellations, current ownership checks, and audit share one transaction.

Database triggers check archival state at actual collaboration INSERT/UPDATE/DELETE, closing authorization races. Published merge results pending D1 projection reconcile before archival. Uncertain upstream writes or fork initialization cause 409 until recovery completes. Events and webhooks for already-completed operations can still deliver.

Cloud artifact/environment publication rechecks unarchived state and run leases in D1. Archival invalidates uploads in flight; objects are reclaimed when nonpublication is confirmed. External runners must continue following heartbeat/lease rules.

[v0.11 transfer and rename](TRANSFER-v11.md) preserves archival state. Archival does not remove existing Git graph or memory budgets.
