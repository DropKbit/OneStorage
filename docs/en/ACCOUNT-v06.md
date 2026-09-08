# OneStorage v0.6: account security and content rendering

[简体中文](../ACCOUNT-v06.md) · **English**

An incremental release toward a Cloudflare-native GitLab/Gogs platform, using Workers, D1, R2, and Durable Objects without containers or an external authentication service.

## Two-factor authentication

Open Account security and enter your current password. QR codes are generated locally in the browser. Scan with a TOTP authenticator or enter the key, then submit a six-digit code. Unverified setup expires after ten minutes. Save the ten recovery codes immediately; each works once and is not shown again after leaving the page.

TOTP uses RFC 6238 SHA-1, six digits, and 30-second windows, accepting the current and adjacent time steps. A time step can be consumed only once; later sensitive actions need a new code or recovery code. Shared D1 allows ten verification attempts per account per ten minutes, including successes, independently of client IP. Current-password verification has a separate equivalent quota.

Once enabled, password sign-in, PAT creation, and password changes require a fresh verification or recovery code. Regenerating recovery codes or disabling MFA requires the current password and a valid second factor. Enabling/disabling revokes other browser sessions but preserves the current one. Password changes revoke all sessions and PATs. Individual sessions can be revoked on the security page.

Git HTTPS, SDKs, and MCP continue using PAT/JWT; do not append OTPs to Git passwords. Enabling MFA does not revoke existing PATs, so review unused tokens separately. Account-security APIs require browser sessions; PATs and delegated JWTs cannot call them.

Secrets use AES-GCM in D1 with CREDENTIAL_ENCRYPTION_KEY and AAD bound to the user/enrollment version. Recovery codes store only context-bound SHA-256 digests. Conditional D1 writes/deletes consume codes atomically; an account authentication version prevents sessions being issued against stale password/MFA state during sign-in.

Administrator password resets do not remove MFA. This release has no email recovery or automatic MFA recovery. Use recovery codes if the authenticator is lost. Losing both requires operator identity verification and database-level recovery; password reset is not an MFA bypass. Back up D1 and the original encryption key together. Later password recovery support is documented in [v0.30](PASSWORD-RECOVERY-v30.md).

## Profiles and content

Profiles support display names, Markdown bios, location, and HTTP(S) websites. `/profile?user=<username>` is public, but projects and activity are filtered by viewer permissions. Private repositories and audit details remain hidden. Disabled users return 404. Profiles show up to 50 projects and 50 activity records per page using a before cursor.

README, Markdown files, issue bodies/comments, merge request bodies/reviews, release notes, wiki, and bios support tables, task lists, highlighted code blocks, heading anchors, and relative links. The Markdown module loads on demand; over 200,000 characters falls back to escaped text. Raw HTML never executes; dangerous URL schemes are rejected. External images become explicit links to avoid passive tracking requests.

PNG/JPEG/GIF/WebP images in README or file pages use an authorized `/preview` endpoint, detect type from bytes, and are limited to 5 MiB with private, no-store and nosniff. Relative README links pin the current Git reference. Raw downloads retain their existing semantics. This release did not preview SVG, PDF, or notebooks; notebooks were added in [v0.37](NOTEBOOK-v37.md).

## Self-hosting and APIs

Back up D1 and the encryption key, apply `0007_account_security.sql` with `npm run db:remote`, then `npm run deploy`. No gateway update is required. Existing accounts default to MFA disabled; repositories and PATs are unaffected.

OpenAPI adds 11 account/profile/image operations and explicitly declares cookie authentication:

- `POST /api/login`: `{username,password,otp?}`; 401 with mfa_required:true when a second factor is required.
- `POST /api/account/mfa/setup`: `{password}` → `{version,secret,uri,expires_at}`.
- `POST /api/account/mfa/enable`: `{version,otp}` → `{enabled,recovery_codes}`.
- `POST /api/account/mfa/recovery` and `/disable`: `{password,otp}`.
- `POST /api/tokens`: existing fields plus otp?; `POST /api/password`: `{current_password,new_password,otp?}`.
- `GET /api/account/security`, `GET /api/account/sessions`, `DELETE /api/account/sessions/:id`.
- `GET/PUT /api/profile`, `GET /api/profiles/:username?before=<cursor>`.

Never put setup responses, OTPs, recovery codes, or credentials in logs, public reports, or URLs. Cookie-authenticated browser writes require a same-origin Origin header.

## Continuing scope

This release delivered basic 2FA, session management, profiles/activity, Markdown, and safe raster previews. Cross-fork reviews, CODEOWNERS, merge queues, SSO, lifecycle, boards, DAG builds, and packages were subsequent goals, now documented in their own guides. Full GitLab YAML/API compatibility and arbitrary Linux builds were not claimed.

References: [RFC 6238](https://www.rfc-editor.org/rfc/rfc6238), [markdown-it](https://github.com/markdown-it/markdown-it), [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator). Browser dependency licenses: `public/THIRD_PARTY_LICENSES.txt`.
