# v0.4 verification: Spaces, permissions, administration, and CI/CD

[简体中文](../VERIFICATION-v04.md) · **English**

This is a historical release report, not a claim that these checks were rerun for the current release.

On 2026-09-08, baseline 8b5653c (v0.3.1). Type checking/66 tests passed; local platform 62 HTTP assertions, core 43 plus native Git/concurrency/LFS, advanced features 76, native signing/Notes/ephemeral remotes, and all three SDKs passed. Production build/content-hashed imports and actual browser space/admin/CI/highlight checks passed. A macOS /var versus /private/var runner-path bug was corrected. Hot-reload timeout and local login-rate-limit runs were rerun without counting failures as passes.

D1 export succeeded after an initial authentication failure; a private backup preceded migration 0005. Initial Worker: 95e2158e-65bc-4be4-926a-bc672005ad54. Production temporary space accept_v04_89cc6d1a passed 26 core checks using actual Queue/D1/R2/DO, including Worker CI, external npm test, logs/artifacts/fixed SHA, revocation, and admin metadata. An initial 30-second cleanup window was shorter than existing 60-second GC; cleanup later succeeded and the script now waits up to 120 retries before PASS.

The runner was tested locally/remotely, but no permanent user build host or actual arbitrary target deployment credentials were configured. Wrangler templates need the operator's target configuration/secrets; the operator's own Wrangler session was never copied into a runner.

See [feature guide](PLATFORM-v04.md) and [current limits](LIMITS.md).
