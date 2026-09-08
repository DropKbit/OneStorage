# OpenID Connect sign-in (v0.23)

[简体中文](../OIDC-v23.md) · **English**

Workers implements Authorization Code with PKCE S256 and validates ID tokens using Web Crypto/Jose. D1 stores identity mappings, versioned provider configuration, and one-time flows. Provider secrets and short-lived flow data use `CREDENTIAL_ENCRYPTION_KEY`. No separate authentication server/database or container is required. [GitHub/GitLab OAuth](OAUTH-v33.md) was added in v0.33; JWT rules here apply only to OIDC.

## Configuration and use

1. An administrator opens `/admin/identity` and registers a web client with the identity provider. Register the exact callback `https://1s.hk/api/auth/oidc/callback` for this instance.
2. Enter name, exact issuer, client ID/secret, client authentication method, and approved endpoint hosts. Methods: `client_secret_basic`, `client_secret_post`, `none`. Explicit hosts must cover discovery, authorization, token, and JWKS; no wildcards.
3. Saving fetches discovery and validates issuer, code flow, endpoints, and authentication. Enabling adds a login button. Account creation is off by default; explicitly enable it and optional exact verified-email domain restrictions.
4. Existing users sign in normally and link in `/settings/account` using current password and enabled MFA. Identity matches provider ID plus `sub`, never automatic email/name merging.
5. New identities choose a username and receive an ordinary account without a local password or automatic admin/space rights. They may explicitly set their first local password.

Password accounts still require it for sensitive operations. Passwordless accounts need provider authentication within five minutes and can reauthenticate. Local MFA still applies to provider sign-in and sensitive actions. Password changes revoke all sessions. Administrators can use the existing password-reset path for recovery.

Secrets are write-only; blank edits retain them. Issuer/client ID are immutable: create a new provider and relink to change them. Maximum 20 providers. Configuration changes immediately revoke that provider's browser sessions, PATs derived from those sessions, and unfinished flows. Unlink revokes only that user's provider-derived credentials and requires another enabled identity or local password. Providers with linked accounts cannot be deleted; disable them first. Empty-provider deletion checks revision/current admin rights.

Local-login credentials, repository delegation keys, and remote provider sessions are not removed by provider-specific revocation. Account disablement still revokes all site credentials. Backchannel logout, SCIM, SAML, and direct Cloudflare Access JWT reception are not implemented. An OAuth access token is not an OIDC ID token.

## Security and consistency

A separate HttpOnly/SameSite=Lax flow cookie binds browser state across the external callback; normal sessions remain Strict. Start/finish require matching Origin. State is atomically single-use and valid ten minutes. A 67-character verifier and nonce are encrypted in short-lived flow data, deleted on completion/failure/cleanup. External access/refresh/ID tokens are not retained.

ID tokens check signature, issuer, audience, azp, sub, nonce, iat, and exp; RS256/ES256/EdDSA and at most 30 seconds clock skew. Unverified/disallowed-domain email is rejected. Server requests require explicitly approved public HTTPS hosts, no redirects/query-bearing endpoints, at most 64 KiB responses and ten seconds; JWKS allows 16 public keys.

Final account linking/session issuance rechecks provider version, account/password epoch, original session, and MFA version. Admin writes recheck authorization after discovery. Reauthentication accepts only the original identity and revokes the prior session after saving the replacement. Registration retries recover the same created account. Audit excludes secrets/callback parameters.

## Deployment and testing

Back up and independently rehearse `0018_oidc.sql`, retain the encryption key, then deploy main. Existing users default to local-password accounts; old credentials have no provider association. Git/R2/DO formats and compiler/gateway are unchanged. D1 export is not a full-service backup.

`npm run check` includes cryptographic/transaction tests. `test:oidc` uses an isolated, password-protected Cloudflare fixture and real Playwright cross-origin flows for admin, linking, MFA, PAT revocation, registration, and first-password setup. Cleanup removes links/providers, disables users, and deletes fixture Worker/local secrets. Remote testing requires explicit opt-in and a private token file. Fixture source is `scripts/support/oidc-provider.ts`; use random client/test/ES256 secrets in mode-600 ignored files. A controlled provider passing is not evidence of real Google/Microsoft account acceptance. See [verification](VERIFICATION-v23.md), [OIDC Core](https://openid.net/specs/openid-connect-core-1_0.html), and [PKCE](https://www.rfc-editor.org/rfc/rfc7636).
