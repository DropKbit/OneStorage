# Security

OneStorage is an alpha. It has not undergone independent penetration testing or production-scale reliability review. Report security issues privately to the deployment operator; this repository does not yet advertise a dedicated security mailbox.

- Git, LFS and content routes check project visibility, membership and credential scope. Internal repository IDs are derived server-side.
- The Git service runs only JavaScript in Workers. No repository-controlled code, native command, hook, filesystem path or symlink is executed.
- Pack SHA-1 and zlib checksums, object lengths, delta instructions, refs and graph connectivity are validated before publication. Decompression, graph, request and queue budgets are enforced.
- R2 objects are immutable and repository-isolated; all object writes precede atomic DO ref publication. Failed uploads cannot publish refs. Existing-object byte conflicts fail closed.
- Git IDs use Web Crypto SHA-1, **without native Git's SHA1DC collision detector**. Our object validation is not complete `git fsck` parity; passing native Git checks on test fixtures does not prove all malicious inputs are handled. Do not claim equivalent hardening to mature native Git.
- PATs/session tokens are stored as hashes. Scope, expiry, revocation and session-only PAT creation are enforced. Password changes revoke all sessions and PATs. Delegated JWT keys are managed and revoked separately in key settings.
- Project/workspace deploy tokens are separate principals with hashed secrets, mandatory expiry and independent Git-read/package scopes. They survive issuer membership changes and account disablement; current project maintainers/workspace owners must explicitly revoke them when no longer needed. Cross-space project transfer permanently revokes project tokens and changes workspace-token coverage. They cannot use general user/admin APIs or push Git. See [deployment credentials](docs/DEPLOY-TOKENS-v26.md).
- Untrusted repository text is displayed as text with a restrictive CSP. Cookie writes require the configured Origin. The web UI does not put secrets in clone URLs or localStorage. SDK credential-bearing Git URLs require explicit opt-in and must not be persisted or logged.
- Webhooks use an operator hostname allowlist, HTTPS, no redirects, timeouts and timestamped HMAC. The operator must ensure approved hostnames resolve only to intended public receivers.

Passwords use PBKDF2-SHA256 at 100,000 iterations. TOTP MFA, recovery codes and administrator-configured OIDC are supported; complete account recovery is still a separate goal. There are operation limits but no complete account/storage quotas or active-repository unreachable-object GC; authorized users can consume compute/storage over repeated requests. D1/R2/DO administrator access can compromise data. Back up all three stores together. Never deploy the public local initialization secret.

Before sensitive production use, add appropriate edge rate limits, access controls, tested recovery, protocol fuzzing, dependency updates and independent review. Only small repositories are currently supported; platform resource limits may reject a request before application limits are reached.

Delegated JWT verification uses registered SPKI keys, explicit repository/scopes, expiry and per-request revocation checks. SSH/OpenPGP signing keys are separate from API JWT keys. Policies are first-match ordered restrictions; a broad unrestricted rule placed first shadows later rules. Credential encryption requires a private 32-byte Worker secret; losing it makes stored upstream credentials unreadable. Keep an encrypted backup and do not rotate by simply replacing it.

The HTTP Git client validates provider paths/approved hosts, rejects redirects and never runs hooks. GitHub App LFS forwarding separates installation authentication from storage-action headers. Operators control hostname allowlists and are responsible for keeping those DNS targets trusted. MCP calls traverse REST authorization; an authenticated agent is still able to exercise the permissions deliberately granted to it.
