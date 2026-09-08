# v0.12 verification: Durable indexing, streaming packs, and negotiation

[简体中文](../VERIFICATION-v12.md) · **English**

This is a historical release report, not a claim that these checks were rerun for the current release.

On 2026-09-08, type checking/140 tests passed, including index recovery, closure transaction failure, forged/missing R2 objects, unpublished isolation, cross-UUID rejection, 5,412-object traversal, large exclusions, checksums/backpressure/cancellation/idle draining, and invisible-have denial.

Local native scale acceptance passed 49 checks: six pushes, 5,424 objects/42 MiB, v0/v2 clone, incremental push/fetch, strict fsck, anonymous denial, and cancellation recovery. Local clone times around 2.88/2.81 seconds and component cache peaks do not establish production performance. Transfer 80, collaboration 82, and core 43/Git/LFS regressions passed.

Initial production saw two commit-API 503s and one native persistence failure, with unknown cause. Cleanup and independent cold-start writes then passed, with transfer 83/collaboration 80, without a Git runtime change; success did not prove a fix. Production scale rerun passed 47 checks. v2/v0 clone: 640,543/366,723 ms; incremental push 4,192 ms; v2/v0 fetch 5,519/3,496 ms. Full downloads read 5,423/5,424 objects and 44,365,169/44,365,416 bytes; object-cache peak 7,546,745 bytes, not total isolate memory. Incremental fetches reused 514 cached bytes with zero R2 reads. Cancelled download stopped after 79 R2 reads and later Git access worked.

Health 0.12.0, 13 assets/archive/auth headers, Cubelink, and independent Git/fsck were checked. Isolated Chromium passed 43 actual UI checks: authentication errors, admin/users, spaces/roles, projects/highlighting/escaping, issues/board, cloud CI, archive/restore/rename/alias, mobile, reader denial, and anonymous private denial. Fixes constrained mobile/code overflow and removed Basic challenges from API 401s while retaining Git/LFS challenges, preventing browser auth dialogs from stalling fetch. Desktop sidebar scrolling and 390px layout passed. Fixtures were cleaned; production dry run passed.

See [feature guide](GIT-SCALE-v12.md) and [current limits](LIMITS.md).
