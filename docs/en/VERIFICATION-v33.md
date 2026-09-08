# v0.33 verification: GitHub/GitLab OAuth adapters

[简体中文](../VERIFICATION-v33.md) · **English**

Historical release evidence; these are not current-release test counts.

Type checking/349 tests passed, including fixed HTTPS hosts/endpoints, PKCE, stable numeric identities, no token/admin leakage, GitHub verified-email pagination, GitLab active/confirmed account rules, malformed/redirect/oversized responses, renamed linked identities, provider revision/disablement, and existing OIDC tests.

Local Cloudflare/browser acceptance passed 38 assertions; production candidate 08c5d443-ab4e-48ec-bbfe-14dc57d117fd (9067390) passed 37. Management protocol/configuration, explicit linking, stable ID login, MFA rejection/recovery, session/PAT revocation, ordinary passwordless registration, last-login protection, local password, and mobile layout passed without errors. A temporary Worker/DO implemented a controlled GitLab OAuth contract with real redirects/network and random credentials; this was not actual commercial GitHub/GitLab application acceptance.

D1 confirmed no fixture identities/credentials/providers/flows/enabled or admin users; disabled audit identities remained. Production fixture provider 7e7f1beb-66b2-4cbf-aaaf-842713265436 was removed. Worker onestorage-oauth-proof-f426839e was deleted after all acceptance/cleanup. Desktop/mobile screenshots and overflow checks passed. No migration, schema 0026. Nineteen online assets/source files, health 0.33.0, auth semantics, and Cubelink passed. Actual provider configuration remains an administrator responsibility.

See [feature contract](OAUTH-v33.md) and [current limits](LIMITS.md).
