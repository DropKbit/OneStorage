# v0.30 verification: Password recovery

[简体中文](../VERIFICATION-v30.md) · **English**

Historical release evidence; these are not current-release test counts.

Type checking/320 tests (eight new) covered key digest/version/lifecycle, single-use concurrency, credential/JWT/flow revocation, signing/identity preservation, MFA replay, audit rollback, generic errors/rate limits, and cross-origin/PAT denial. Fault injection exposed key registration that could survive session revocation between read and INSERT; before fix it returned 201 with one key, afterward 403 with zero. Both delegation and real Ed25519 signing-key create/delete were checked. This does not roll back every already-authorized business operation.

Final code 217c8cbb7030044cfc9dce1b2d84729007fa360b; Worker 806f75ab-893b-4ece-8b8a-a15c5ee683e5. Local 42 and production 41 explicit API/browser checks passed: real private Git content, PAT/signed JWT, desktop key generation/download/rotation/revocation, mobile recovery with/without MFA, old credential rejection, unchanged Git bytes, audit, consumed key, and admin revocation. Desktop 1440×1000/mobile 390×844 had no errors/overflow. Secrets were masked and downloads deleted. D1 confirmed no fixture projects/credentials/keys/enabled users, retaining disabled audit identities.

An initial JWT fixture lacked typ:JWT and was corrected after cleanup. After an initial production pass, the key-write race was found; final runtime was redeployed and fully rerun locally/remotely. Migration 0024 followed private backup/independent recovery preserving 67 tables/406 audit rows with no foreign-key errors; not full R2/DO disaster recovery. Only main deployed. Final assets/source/health and source push/audit/mirror fsck were verified. Email/all-second-factor-loss recovery remains outside scope.

See [feature contract](PASSWORD-RECOVERY-v30.md) and [current limits](LIMITS.md).
