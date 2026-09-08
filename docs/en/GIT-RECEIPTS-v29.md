# Git publication and durable audit receipts

[简体中文](../GIT-RECEIPTS-v29.md) · **English**

A v0.28 source push returned HTTP 500 although subsequent refs and an independent mirror's strict fsck confirmed complete publication; its audit row was missing. Historical telemetry was unauthorized and later probes did not reproduce it, so that incident's specific cause remains unproven.

Fault injection independently reproduced a defect: after a successful DO Git response, a synchronous D1 audit failure could replace success with HTTP 500. v0.29 removes that post-commit dependency and persists audit intent with refs.

## Atomic publication and recovery

A native receive-pack that changes refs atomically stores refs, per-ref push events, and one `git-receipt:` in the same DO transaction. The receipt includes random event UUID, repository UUID, authenticated actor ID, publication time, and changed-ref count. The outer Worker supplies identity; caller headers cannot override it. Multi-ref updates produce one receipt; no-op/rejected/stale-ref requests do not count as successful publications.

R2 object/closure validation still precedes publication. Writes exceeding 128 keys are split into at-most-128-key calls within one transaction, retaining atomicity and default confirmed writes. No D1 audit is required after the successful DO response.

Alarms prioritize up to 20 receipts/pass and schedule a 30-second recovery alarm before external I/O. A receipt is deleted only after D1 confirms. Lost D1 responses or failed marker deletion retry safely; unique `audit.event_id` makes audit and notification triggers idempotent. Remaining receipts continue; failure retains recovery state without removing other CI/webhook/sync work.

A repository may hold at most 512 undelivered native receipts. At capacity, new native writes are rejected before pack intake/upstream forwarding and checked again before ref publication. Pending receipts are never discarded to make room.

## API and migration

`GET /api/repos/:namespace/:repo/audit` adds nullable `event_id`. Existing/other actions retain null. New successful actions remain `git.receive_pack`, with JSON `detail.refs_updated` and actual publication time. Access rules are unchanged. Audit visibility is asynchronous; a successful push need not immediately appear in D1. Later account disablement does not erase history; deleted actors may be null. UUID identity survives transfer; project deletion removes audit and pending receipts through existing GC.

Apply `0023_git_receipts.sql` before deployment. Its nullable column/unique index remains compatible with the old Worker. It does not invent missing historical audit records.

This fixes the reproduced post-commit-audit response replacement, not every network/platform/storage failure or the unproven historical incident. Uncertain main-to-DO transport now returns incident-tagged 503 with `gateway-receive` diagnostics, without exposing raw provider messages or claiming rollback. Existing DO/report-status responses remain intact. Clients must inspect refs before replaying uncertain writes. Other editing APIs/upstream confirmation have separate reliability scope.

Tests cover audit failure, replay/deduplication, uncertain D1 commits, marker failures, atomic rollback, backlog, historical identity, batching, and large ref sets. `test:git-receipts` uses actual Git, atomic creation/deletion of two and 129 refs, no-ops, protection, asynchronous audit, mirror, strict fsck, and cleanup. See [verification](VERIFICATION-v29.md).
