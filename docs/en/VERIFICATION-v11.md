# v0.11 verification: Project transfer and rename

[简体中文](../VERIFICATION-v11.md) · **English**

This is a historical release report, not a claim that these checks were rerun for the current release.

On 2026-09-08, type checking/134 tests passed. Coverage included inherited/direct access changes, UUID/collaboration/CI history preservation, connection/lease revocation, app shutdown, conflict rollback, source/destination revocation, archive preservation, aliases/return migration, same-space connection retention, request-scoped D1 RETURNING/batch/immutable bindings, stale-read rejection, no-write read snapshots, DO GET/HEAD barriers, and cold/cache recovery.

Local transfer acceptance passed 79 checks across personal/team/archived/rename cases, native clone/fetch/push/fsck, LFS, aliases/JWT/PAT roles, and real isolated CI application creation. Archive 63, issues 62, and collaboration 81 regressions passed. After read protection, production transfer passed 81, archive 61, and issues 61, including accessible application before transfer and 404 afterward. An earlier production round had 83 checks; polling affects totals. Fixtures/apps/spaces were cleaned and users disabled/revoked.

Thirteen resources/source hashes/MIME/cache checks passed with health 0.11.0 and Cubelink retained then. Full UI acceptance remained pending while the Mac was locked.

See [feature guide](TRANSFER-v11.md) and [current limits](LIMITS.md).
