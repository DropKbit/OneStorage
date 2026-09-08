# v0.23 verification: OIDC sign-in

[简体中文](../VERIFICATION-v23.md) · **English**

Historical release evidence; these are not current-release test counts.

2026-09-09. Candidate e5fbb63; Worker f47e2cfd-52c5-4219-ac47-976f2b7f4cf0. Type checking/256 tests (11 OIDC), production dry run, local OIDC 38, account 44, core 43/Git/LFS, general UI 43, production OIDC 37/account 43, and native Git→DAG→fsck 22 checks passed. PAT-based production omits local admin login.

Real browser flows covered provider management/write-only secrets, explicit linking/login, local MFA rejection/recovery, provider-derived PATs, disablement revocation, ordinary passwordless registration, last-login-method protection, admin denial, and local-password setup. SQLite tests covered state/browser binding/replay/CSRF, PKCE, JWT claims, verified domains, security revisions, expired flows, discovery-time admin revocation, reauthentication, independent local credentials, and registration recovery. An initial local UI 429 was fixed by an isolated localhost-only test source, not relaxed production limits.

D1 backup restoration and migration 0018 preserved 56 existing tables' counts with integrity/foreign keys valid. This was not R2/DO disaster recovery. A random-password-protected temporary Cloudflare ES256/PKCE identity fixture exercised real network flows; secrets stayed in private files and out of archives. Links/providers were removed, users disabled, and the fixture Worker deleted. Compiler/gateway/storage layout/domains were unchanged. Commercial Google/Microsoft accounts were not configured or verified.

See [feature contract](OIDC-v23.md) and [current limits](LIMITS.md).
