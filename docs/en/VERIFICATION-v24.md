# v0.24 verification: Space CI variables

[简体中文](../VERIFICATION-v24.md) · **English**

Historical release evidence; these are not current-release test counts.

2026-09-09. Candidate e4df35c; Worker 0c4675b2-8514-45fb-ad09-81f0b27f974c. Type checking/264 tests (eight new), production dry run, local shared variables 49 checks/88 requests, project variables 41/64, space UI 19, project UI 16, core 43/Git/LFS, production shared 49/111, project 41/81, and Git/DAG/fsck 28 passed. Polling/request counts differ from scenario counts.

Coverage included metadata separation, project wildcard overriding space exact environment, paused overrides preventing fallback, inheritance restoration after deletion, sibling consumers, actual Worker/shipped runner, encoded/error/chunked/historical masking, leases, rotation, and MR/retry denial. SQLite checks covered distinct encryption context, owner loss despite retained project maintenance, transfer snapshot isolation, selection races, protection, manager credentials/revisions/takeover, and completed-child dependencies canceling unfinished parents.

Backup/rehearsal of migration 0019 preserved 59 tables with integrity/foreign keys valid; only D1 recovery was tested. Existing ciphertext/Git/storage identity remained; compiler/gateway were not redeployed. Fixtures/runners/accounts were cleaned/revoked, archives excluded production PATs, and release/source/mirror/fsck checks were performed. Random fixture values—not real Cloudflare deployment secrets—were passed to runners. This does not claim an actual external Wrangler deployment with a real account token. Nested groups, instance/file variables, and full YAML are excluded.

See [feature contract](CI-WORKSPACE-VARIABLES-v24.md) and [current limits](LIMITS.md).
