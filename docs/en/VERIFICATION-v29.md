# v0.29 verification: Durable Git audit receipts

[简体中文](../VERIFICATION-v29.md) · **English**

Historical release evidence; these are not current-release test counts.

Historical v0.28 push ab1a2053f43c30ff972090216e57cc5d99aeedb9 returned HTTP 500 but refs/fetch/strict mirror fsck proved publication; audit was absent. Historical logs returned 403 and three later isolated pushes did not reproduce it. Independent fault injection proved post-success D1 audit could replace Git success with 500 before the fix, but does not identify that historical incident's cause.

Type checking/312 tests (seven new), build, and migration 0023 passed. Independent D1 restoration preserved 67 tables/399 audit rows, integrity and foreign keys; not R2/DO recovery. Tests covered trusted actor, atomic refs/receipt, delivery recovery/uncertain commits/marker failures, notification deduplication, backlog, rollback/no-op/history, 20-record batches, over-128-key transactions, and private incident diagnostics.

Local native acceptance passed 29 API checks, production 14, including three pushes; atomic create/delete of two and 129 refs with exactly one audit per transaction; no fake audit for no-op/protected rejection; independent mirror/ref/strict fsck. Production final SHA 185d08a5e060df570320f35a4a188ace2aa6ca9f had seven unique successful transaction events. Thirty-nine filtered Git log events showed no 5xx/runtime exception in that fixture, not global availability.

Git→DAG→fsck passed local 22 and production 28; production workflow 590044e8-408b-4cf3-b815-85982bb6eb87 pinned 4cbe34f044b3feb67a2b62bfd1c36c5b106e8c01. Cleanup exited zero and confirmed no fixture spaces/projects/workflows/audit. Candidate d471a7d3bcea71a5eddb600e32244c09d5324f7a; main 232090de-5ac3-4e5c-87c9-cc26dfa20549. Only main deployed; original PAT retained. Other edit-API audits, upstream confirmation, and historical faults remain separate concerns.

See [feature contract](GIT-RECEIPTS-v29.md) and [current limits](LIMITS.md).
