# v0.9 verification: Issue workflows

[简体中文](../VERIFICATION-v09.md) · **English**

This is a historical release report, not a claim that these checks were rerun for the current release.

On 2026-09-08, type checking/117 tests passed. Coverage included 204 issues across pages, intersecting filters, literal wildcard escaping, cursor/project isolation, batch CAS/all-or-nothing rollback, pre-transaction revocation, valid assignees/labels, label limits, real Hono board routing, 205-comment pagination, and escaped cards.

Local new HTTP acceptance passed 62 checks, collaboration/cloud CI 81, core 43/Git/LFS, and CODEOWNERS/issue-closing 54. Production new checks passed 61 and CODEOWNERS regression 53. Fixtures were cleaned and accounts disabled/revoked. Insert and batch-write paths recheck current access/account state; older edit/planning routes use versioned mutations.

Initial release verification found issues.js incorrectly falling back to HTML. It was added to static routing, with a real-Hono test covering every browser module's anonymous access, MIME, bytes, and version caching. Final 13-resource/archive checks and independent mirror/strict fsck passed for bc9e160. Actual board drag/drop, filtering, bulk selection, and pagination UI remained untested at that release because the Mac was locked.

See [feature guide](ISSUES-v09.md) and [current limits](LIMITS.md).
