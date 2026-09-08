# Self-service password recovery (v0.30)

[简体中文](../PASSWORD-RECOVERY-v30.md) · **English**

OneStorage provides a one-use offline password recovery key through Workers/D1, without email or containers. In account security, enter your current password and enabled second factor to generate it, then save/download it immediately. It is shown once, lasts one year, and only one key exists per account; replacement immediately invalidates the old one.

From “Forgot password?” submit username, recovery key, and new password. MFA-enabled accounts still require a fresh authenticator code or unused **MFA recovery code**. Password recovery keys and MFA recovery codes are separate; neither alone bypasses enabled two-factor authentication.

## Effect and revocation

A successful D1 transaction changes the password, consumes the key, revokes all browser sessions/PATs, removes JWT delegation public keys and pending OIDC flows, and records audit. It does not sign you in. Sign in with the new password and existing second factor, then generate another recovery key.

Projects, spaces, collaboration, roles, MFA settings/remaining recovery codes, commit-signing public keys, and linked identities remain. Project/space deploy tokens are independent and remain. Already-authorized in-flight work is not automatically rolled back; subsequent requests need valid credentials.

Password changes/admin resets, MFA enable/disable, authentication-epoch changes, account disablement, and admin session revocation invalidate the key. Reenabling does not revive it. Account security supports explicit revocation and shows the latest 20 generation/revocation/use events without secrets.

Provider-only accounts need to sign in and set a local password before generating a key. Without a saved valid key, use a linked provider or contact the administrator for identity verification. Email reset/verification is not implemented. The key cannot disable MFA; losing every second factor requires separate recovery.

## Implementation and API

Keys contain 32 cryptographically random bytes, formatted as `osr_` plus grouped hexadecimal. D1 stores only a user/version-bound SHA-256 digest, timestamps, and authentication epoch. Generation/revocation require a browser session, local password, enabled second factor, and current key version. SQL rechecks session existence/expiry, enabled account, epoch, and MFA revision.

Recovery rechecks key digest/version/expiry and account/MFA state. Conditional updates admit one concurrent success; audit failure rolls back password/credential changes. Second-factor consumption occurs first and remains consumed if the later transaction fails; retry with a fresh factor. Delegation/signing-key writes also recheck the current session, preventing a pre-recovery request from restoring revoked authorization afterward.

Unknown users, invalid/expired/used keys, and disabled accounts share a 401 response. Recovery rate limits apply independently to IP and normalized username: ten attempts per ten minutes. PAT/JWT/deploy tokens cannot invoke account recovery management. Keys travel only in same-origin JSON bodies, never URLs/logs/browser persistence. Downloads are generated locally. Responses are `no-store`. After uncertain network failure, try normal login with the new password before assuming rollback.

- `GET /api/account/password-recovery`: `has_password,enabled,version,created_at,expires_at,history`.
- `PUT/DELETE` same path: `{password,otp?,version}`, initially `version:null`. Generation returns the one-time key and metadata; never log it.
- `POST /api/recover-password`: `{username,key,new_password,otp?}`; success `{ok:true,sign_in_required:true}`. Anonymous endpoint; cookie writes still require same-origin Origin.

Back up/apply `0024_password_recovery.sql`, then deploy main. Existing users are not automatically enrolled; compiler/gateway do not change. See [verification](VERIFICATION-v30.md), [OWASP guidance](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html), and [NIST lifecycle guidance](https://pages.nist.gov/800-63-4/sp800-63b/events/). References are not compliance certification.
