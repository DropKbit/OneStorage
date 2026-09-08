# v0.8 verification: CODEOWNERS and issue-closing merges

[简体中文](../VERIFICATION-v08.md) · **English**

This is a historical release report, not a claim that these checks were rerun for the current release.

On 2026-09-08, type checking/107 tests passed. Coverage included owner-rule precedence, target snapshots, self-approval denial, inherited roles/revocation, stale reviews, file/directory changes, issue directives/cross-project filtering, D1 recovery, and idempotence after manual reopen. R2 tests covered deduplication, two-channel bounds/draining, no early refs, graph types, and 32-MiB staging.

Local new acceptance passed 54 HTTP checks, fork reviews 63 plus clone/fsck, collaboration 81, core 43/Git/LFS, and 51 parity mappings. Production new checks passed 53, fork review 61 plus clone/fsck, preserving unpublished private branches. Test spaces owners_v08_73553bba and review_v07_58fbb4e8 were cleaned; users disabled/credentials revoked. Migration 0009 followed a private backup. Health was 0.8.0; HTML/six assets matched and Cubelink remained then.

The Mac was locked, so this release did not complete actual v0.8 browser interaction acceptance; pure rendering tests were not presented as clicks. v0.7's later UI supplement is recorded separately.

See [feature guide](REVIEWS-v08.md) and [current limits](LIMITS.md).
