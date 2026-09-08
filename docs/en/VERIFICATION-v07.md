# v0.7 verification: Fork review and line discussions

[简体中文](../VERIFICATION-v07.md) · **English**

This is a historical release report, not a claim that these checks were rerun for the current release.

On 2026-09-08, type checking/92 tests, final local and production review runs of 62 HTTP checks plus actual clone/fsck, collaboration 81, core 43/Git/LFS, and production build passed. Dependency entries matched v0.6 except project version; OpenAPI had 122 operations.

Isolated public targets/private forks tested source filtering, unrelated/private rejection, contributor write/merge denial, no self-approval, independent/current approvals, stale revisions, invalid lines/paths, replies/resolution, obsolete blocking threads, visitor non-veto, and target-config CI on a fixed source SHA. Concurrent merge/reopen could not both succeed; merge retries returned the same durable result. An unpublished private branch stayed absent from the target and clones; only the requested history was imported. Unit tests additionally covered fork-network ancestry/deletion, missing objects, reachable LFS, over-100 pagination, and HTML/patch-like source escaping. A missing-object expectation was corrected from 404 to the documented 409 before full rerun.

At release, the Mac was locked, so UI acceptance was incomplete. On the v0.13 tree later that day, isolated headless Chromium passed 60 review API/UI checks plus 201 pagination fixture requests, covering fork/branch form changes, old/new lines, Markdown/escaping, reply/thread pagination, role controls, review/CI/merge gates, and mobile. General UI passed 43 checks. A form binder was fixed to preserve explicitly assigned control IDs. Actual target refs matched durable merged_sha. This completed the recorded UI gap, not the whole platform goal.

Migration 0008 followed backup; health was 0.7.0, Cubelink was preserved then, gateway unchanged, and source/release/mirror checks were recorded privately. Production fixtures were cleaned and accounts disabled/revoked; a local review fixture was intentionally retained for inspection. Recreate with KEEP_REVIEW_FIXTURE=1 and test:reviews, then test:review-ui.

See [feature guide](REVIEWS-v07.md) and [current limits](LIMITS.md).
