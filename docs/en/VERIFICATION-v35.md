# v0.35 verification: Public npm cache

[简体中文](../VERIFICATION-v35.md) · **English**

Historical release evidence; these are not current-release test counts.

Type checking/358 tests passed, including cross-instance hits, repeated SRI checks, corruption fallback/repair, I/O errors/timeouts, bad registry bytes never cached, private bypass, shared budgets, cancellation, URL/SRI isolation, and seven-day expiry. Existing tar/lock/private authorization tests passed.

Local real builds passed 25 checks/43 requests: initial Preact 10.29.3 downloaded/cached 408,457 bytes; the next hit once with zero registry download/write. Releases/rollback/static JS/CSS passed; bad SRI/native imports published nothing. Fixture D1 counts were zero. The dedicated bucket and seven-day npm-v1/ rule/private access were read back via Wrangler; this did not mean waiting seven days to observe deletion. Schema stayed 0027 and Git/gateway/Cubelink were unchanged.

Production main 6872c843-a3f1-4f88-b892-f03e7704a9b0/compiler 75f072a0-905e-4048-83ba-0531051f8427 passed 25 public-build checks/47 requests with the same cold/warm bytes. Direct R2 readback matched size/SHA-512. Nineteen assets/source, health 0.35.0, auth/Cubelink, and cleanup passed.

The same production runtime passed private-build regression 30 checks/89 requests: two verified packages, only the public dependency counted as one cache hit, zero download, private bytes supplied by the control plane. Undeclared/old/revoked credentials failed without outputs; updating the variable restored builds. Application/static/rollback passed; all private fixture rows were zero after asynchronous cleanup. Disposable public cache remained under retention and original user credentials remained valid.

See [feature contract](CI-NPM-CACHE-v35.md) and [current limits](LIMITS.md).
