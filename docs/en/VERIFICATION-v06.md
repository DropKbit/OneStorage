# v0.6 verification: Account security and rendering

[简体中文](../VERIFICATION-v06.md) · **English**

This is a historical release report, not a claim that these checks were rerun for the current release.

On 2026-09-08, clean locked installation reported zero vulnerabilities at that time, then type checking/83 tests and production build passed. Core 43 assertions/Git/LFS, advanced features 76, native signing/Notes/remotes, 51 parity mappings, local account 41 requests, and production account 43 requests passed. OpenAPI had 113 operations with distinct cookie authentication.

Tests included RFC TOTP vectors, monotonic windows, encrypted secrets, one-use concurrent recovery codes, setup expiry/revision, password checks/rate limits, MFA rotation/disable, profile visibility, Markdown XSS/remote images, and security-version races during login/setup/PAT creation. Fresh ordinary test users verified old-session revocation, second factors, reused-code denial, PAT account-management denial, session revocation, password change, and private raster byte/MIME/cache/auth checks. Real administrator MFA was untouched. Only local rate-limit fixture state was cleared. A revoked-Bearer assertion was corrected from 200 to the correct 401 before rerunning.

An isolated browser verified OTP, account sessions/profile, rendered Markdown/tasks, actual highlight nodes, private PNG decoding, and no script errors. QR generation used a public RFC test secret. Migration 0007 followed backup; health was 0.6.0 and Cubelink remained at the root then. The allowlisted archive excluded production credentials; release/source/mirror-fsck evidence stayed in private local records. Later features do not retroactively expand this report.

See [feature guide](ACCOUNT-v06.md) and [current limits](LIMITS.md).
