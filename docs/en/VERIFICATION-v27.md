# v0.27 verification: Private npm native builds

[简体中文](../VERIFICATION-v27.md) · **English**

Historical release evidence; these are not current-release test counts.

2026-09-09. Candidate 3b89d40f17688b1b7a81cad7872d671abdc994b5; compiler ce9bc429-1847-4018-a751-ce334aa852c2; main 15c05d96-4267-42bb-b132-bd6fba9dce11. Type checking/297 tests (eight new), both dry runs, local private builds 30 checks/66 requests, public builds 23/42, core 43/Git/LFS, production private 29/117 and native Git/CI 28 passed.

Real npm published a scoped private package and generated a mixed Preact lockfile. Actual WASM TSX builds produced fixed-SHA R2 JS, Dynamic Worker responses, two releases, CAS rollback/stale rejection, and browser JS/CSS/static gateway output. No runner/container participated. Wrong SRI, undeclared registry, old/revoked token, and node:fs failed without releases/artifacts; updating the selected encrypted variable after rotation restored builds. Desktop template checks passed; no extra mobile claim.

SQLite tests covered pre-R2 authorization, exact package/file/version/integrity, no secrets in compiler inputs, no private external download, expiry/in-flight revocation, parent/child dependency authorization, and atomic publication. Migration 0022 preserved 66 tables after independent D1 recovery; compiler then main deployed, gateway/storage identities retained. This was not full R2/DO recovery. Local/prod fixtures, package/upload/run/deploy/dependency rows were cleaned; documented core local example remained with token revoked. Production Git workflow 851d340b-04c3-4f8b-b64c-83a044728b1b ran d1fe8ca19dbb7978e080209a132dad7ee46a3257. Release verification and source synchronization retained private credentials outside the archive.

See [feature contract](CI-PRIVATE-PACKAGES-v27.md) and [current limits](LIMITS.md).
