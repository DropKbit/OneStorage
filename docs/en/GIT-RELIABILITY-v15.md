# Git write recovery and diagnostics (v0.15)

[简体中文](../GIT-RELIABILITY-v15.md) · **English**

Intermittent production writes failed in v0.12–v0.14 without enough evidence to identify the cause. This release adds stage diagnostics and bounded transient R2 recovery; it neither attributes those incidents to R2 nor claims they were fixed.

Immutable objects still use conditional R2 writes; verified closure precedes DO ref publication. Retries wrap only one R2 get/conditional put, never the entire Git request, D1 transaction, or ref publication. After an uncertain response, query remote refs before deciding to retry.

Explicit R2 codes `10001`, `10043`, `10054`, and `10058` allow two additional attempts/operation, with four additional attempts total per ObjectStore request. Exponential jitter begins at 150 ms; the first 10058 wait is at least 1.1 seconds. Unknown/auth/configuration/checksum/ref-conflict errors fail immediately. A retry retains `etagDoesNotMatch: "*"`; an existing object is read and compared in full, never overwritten. Both I/O channels drain before failure returns. DO/D1 have no new automatic retries.

Unexpected backend errors create an incident ID. Commit APIs return `incident_id` and `X-OneStorage-Incident`; native Git report-status includes it. Logs identify metadata, object-read/write/verify/index, or ref-publish, recognizable provider codes, D1 markers, retryable/overloaded flags, and compiled location. They exclude raw exception messages, SQL, headers, credentials, source, repository paths, and full stacks. Successful retries still log their stage/code/count. A stage alone is not proof of a provider root cause.

Fault injection covers response loss after successful write, conflicting content, repeated transient failure, total budgets, draining, read deduplication, uncertain ref publication without replay, diagnostic privacy, and Git protocol errors.

A separately reproduced thin-pack bug swallowed external-base storage errors as unresolved/cyclic deltas. The fix first resolves later in-pack bases, then preserves genuine external-storage exceptions with incident IDs. Missing objects/malformed deltas remain invalid packs. Its relation to historical 503s is unproven.

`test:git-reliability` performs eight commit-API writes, competing expected-ref clients, stale-ref rejection, two native incremental pushes, clone, branch comparison, and strict fsck. v0.15 passed 161 unit tests/type checking, core 43 assertions plus Git/LFS, local writes 43 and production 53 assertions, and production workflows 23 checks/150 assertions. No new 503 or R2 retries appeared in that sample; this does not establish availability or eliminate historical faults. References: [R2 errors](https://developers.cloudflare.com/r2/api/error-codes/), [R2 API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).
