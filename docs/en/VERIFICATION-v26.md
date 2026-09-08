# v0.26 verification: Deploy tokens

[简体中文](../VERIFICATION-v26.md) · **English**

Historical release evidence; these are not current-release test counts.

2026-09-09. Candidate c978e5ac8194de9cecf97a79b2b7e389ef509be5; Worker be5e545d-efdd-4dfb-a58e-9173379001d6. Type checking/289 tests (nine new), dry run, local tokens 46 checks/49 requests, packages 54/46, core 43/Git/LFS, production tokens 41/47, packages 54/44, and Git/DAG/fsck 34 passed.

Actual Git verified read/fsck, push/LFS-upload denial, downloads, rotation/revocation, archive, rename, transfer, and future space projects. Actual npm tested scoped publish/install/tags/unpublish; generic files tested independent scopes. v0.25 large-file boundaries were not repeated. Desktop/mobile Chromium covered management, one-time secrets/clearing, rotate/revoke without errors. Tests covered hash-only storage, manager races, expiry/quota, creator-independent identity, scope denial, post-queue checks, and upload/download lifecycle races.

Migration 0021 (seven statements) preserved 65 existing tables after independent D1 backup restoration; no full-service disaster-recovery claim. Compiler/gateway were unchanged. Local package/token fixtures and production spaces/projects/packages/uploads/tokens/workflows were zero after cleanup. Local core retained its documented review example with its token revoked. Production workflow 65c2fec7-f3ed-4a33-9ad3-f926ad8995a3 ran commit 5483fdb1c62cfd5416335faf38abe426cf2446ea successfully. Release/source/mirror/fsck passed; original user PAT remained.

See [feature contract](DEPLOY-TOKENS-v26.md) and [current limits](LIMITS.md).
