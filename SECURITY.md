# Security

OneStorage v0.2 is an alpha. It has not undergone independent penetration testing or production-scale reliability review. Report security issues privately to the deployment operator; this repository does not yet advertise a dedicated security mailbox.

- Git, LFS and content routes check project visibility, membership and credential scope. Internal repository IDs are derived server-side.
- The Git service runs only JavaScript in Workers. No repository-controlled code, native command, hook, filesystem path or symlink is executed.
- Pack SHA-1 and zlib checksums, object lengths, delta instructions, refs and graph connectivity are validated before publication. Decompression, graph, request and queue budgets are enforced.
- R2 objects are immutable and repository-isolated; all object writes precede atomic DO ref publication. Failed uploads cannot publish refs. Existing-object byte conflicts fail closed.
- Git IDs use Web Crypto SHA-1, **without native Git's SHA1DC collision detector**. Our object validation is not complete `git fsck` parity; passing native Git checks on test fixtures does not prove all malicious inputs are handled. Do not claim equivalent hardening to mature native Git.
- PATs/session tokens are stored as hashes. Scope, expiry, revocation and session-only PAT creation are enforced. Password changes revoke all credentials.
- Untrusted repository text is displayed as text with a restrictive CSP. Cookie writes require the configured Origin. Secrets are never placed in clone URLs or localStorage.
- Webhooks use an operator hostname allowlist, HTTPS, no redirects, timeouts and timestamped HMAC. The operator must ensure approved hostnames resolve only to intended public receivers.

Passwords use PBKDF2-SHA256 at 100,000 iterations. There is no MFA/SSO or complete account recovery UI. There are operation limits but no complete account/storage quotas or automatic Git GC; authorized users can consume compute/storage over repeated requests. D1/R2/DO administrator access can compromise data. Back up all three stores together. Never deploy the public local initialization secret.

Before sensitive production use, add appropriate edge rate limits, access controls, tested recovery, protocol fuzzing, dependency updates and independent review. Only small repositories are currently supported; platform resource limits may reject a request before application limits are reached.
