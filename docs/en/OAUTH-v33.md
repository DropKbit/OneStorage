# GitHub and GitLab OAuth sign-in (v0.33)

[简体中文](../OAUTH-v33.md) · **English**

Administrators select OIDC, GitHub OAuth, or GitLab OAuth in identity management and configure name, address, client ID/secret, trusted hosts, registration, and optional email domains. Enabled providers appear on login. Existing users explicitly link an identity in account security before provider login/reauthentication.

| Provider | Address / approved hosts                                   | Scopes                                                | Client authentication                              |
| -------- | ---------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------- |
| GitHub   | `https://github.com`; `github.com,api.github.com`          | `read:user`, plus `user:email` for email restrictions | `client_secret_post`                               |
| GitLab   | `https://gitlab.com` or trusted self-hosted HTTPS instance | `read_user`                                           | `client_secret_post`, or `none` for public clients |
| OIDC     | Existing issuer/discovery configuration                    | `openid email profile`                                | Existing three methods                             |

Register the callback shown by the admin page: here `https://1s.hk/api/auth/oidc/callback`. Secrets are encrypted/write-only; blank edits preserve them. Address, client ID, and protocol are immutable. GitHub mode targets github.com, without claiming compatibility with older Enterprise Server lacking PKCE.

All adapters use authorization code and PKCE S256, not implicit/device/password grants. A one-time state, HttpOnly flow cookie, ten-minute expiry, provider revision, and current account security version constrain the flow.

## Identity and authorization

The fixed provider user endpoint's numeric user ID identifies the subject. Usernames only suggest registration names; email/name never merges accounts automatically, and remote admin/organization/project permissions are not inherited.

GitHub uses `/user`. With domain restrictions, `/user/emails` must provide an exact matching domain with `verified=true`; pagination is bounded to five pages of 100 and ignores external pagination URLs. GitLab uses `/api/v4/user`, requiring `state=active`, excluding locked/bot accounts, and checking primary `email` plus valid `confirmed_at` for domain restrictions. Public/unconfirmed email is not accepted. GitLab confirmation depends on that trusted instance's policy, not OneStorage sending verification mail.

Token/user requests reject redirects, limit responses to 64 KiB and ten seconds, and rederive approved fixed protocol endpoints. External access/refresh tokens are not stored or sent to browsers, Git, or CI. Resulting OneStorage sessions reuse local MFA, closed-registration policy, last-login-method protection, explicit password setup, unlink, and provider-revision revocation transactions.

Remote account disablement/revoked application authorization affects subsequent provider logins. Existing OneStorage sessions are not instantly revoked by unimplemented remote webhooks. Disable the local provider/account to revoke site credentials. Cloudflare Access, other OAuth providers, and directory synchronization remain outside this implementation.

## Compatibility and acceptance

Existing `/api/auth/oidc/*`, `/api/admin/identity-providers`, `/api/account/identities`, tables, and audit prefixes remain. Configuration adds `protocol=oidc|github|gitlab`, default oidc; no migration. Disable unsupported OAuth providers before rolling back to an older Worker.

`npm run check` tests adapters and account transactions. `test:oauth` uses a temporary Cloudflare Worker/DO provider for real browser redirects, single-use codes, PKCE, opaque tokens, and user API. It implements a controlled GitLab contract, not a real GitLab instance or the user's actual GitHub/GitLab application. Configure and verify actual applications separately. See [verification](VERIFICATION-v33.md).

Fixture source: `scripts/support/oauth-provider.ts`, binding `IDP` to SQLite-backed `OAuthFixture`. Set random `CLIENT_SECRET` and `TEST_PASSWORD`, with matching mode-600 ignored JSON. Client ID is `onestorage-acceptance-v33`; set `OAUTH_FIXTURE_ISSUER`, `OAUTH_FIXTURE_SECRETS`, and optionally `PLAYWRIGHT_MODULE`. Remote tests also require `ALLOW_REMOTE_ACCEPTANCE=1`, `TEST_ORIGIN`, and private `ONESTORAGE_TOKEN_FILE`. Keep the fixture's callback allowlist exact for the deployment under test. The script cleans site identities/provider; the operator removes fixture Worker/secrets after completion. Do not redeploy during acceptance/cleanup.

References: [GitHub OAuth](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps), [GitLab OAuth](https://docs.gitlab.com/api/oauth2/), [GitHub emails](https://docs.github.com/en/rest/users/emails?apiVersion=2022-11-28), [GitLab current user](https://docs.gitlab.com/api/users/#retrieve-the-current-user).
