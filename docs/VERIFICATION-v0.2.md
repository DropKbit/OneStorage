# Verification record — v0.2.0

Date: 2026-09-08 (Asia/Singapore). Development: macOS, Node 26, native Git, Wrangler 4.129.1. Service execution: Cloudflare workerd locally and Cloudflare Workers/Durable Objects remotely, with the same JavaScript Git engine. No native Git subprocess or Container runs on the server.

## Local results

- `npm run check`: TypeScript and **28 passing tests**.
- `npm run test:e2e`: **43 API status assertions**, plus native Git/protocol/content/concurrency/LFS assertions. Final full fixture: `owner/e2e_2b6ac048`.
- Production Worker build and deployment succeeded; bundle approximately 998 KiB / 173 KiB gzip, excluding static assets.
- JavaScript source download archive uses an explicit file allowlist, includes source/config/tests/license and excludes local credentials/state.

### Git compatibility and corruption cases

Canonical blob/tree IDs match native Git. Native OFS_DELTA and REF_DELTA packs decode to the exact expected object set. A native thin-pack fixture requires and resolves external bases. Native `git index-pack --strict --stdin` accepts generated packs. Forward REF deltas, annotated tags, multi-chunk incompressible data, binary blobs, symlinks and executable modes are covered.

Regression tests reject corrupt/truncated packs, wrong SHA-1 trailer, invalid object type/size, trailing data, bad zlib checksum, expansion overflow, delta copy bounds/zero op, missing bases, excessive delta chain depth, malformed pkt-lines, unsorted trees and duplicate commit author headers. SHA1 collision detection and complete native fsck parity are not claimed.

Real native clients exercise v0/v2, clone/push/pull, incremental thin pushes, tags, branch creation and forced chunked HTTP (`http.postBuffer=128`). The flush-only authentication probe is accepted without modifying refs. Protocol v2 include-tag emits attached annotated tags.

### Persistence and upgrades

Injected R2 and DO write failures cannot advance refs; orphan uploads may remain. Atomic ref batches, stale compare-and-swap, missing graph targets, default-branch deletion, forbidden history rewrites, and unreachable/cross-repository wants are covered. Existing R2 objects with conflicting bytes reject publication.

Both packed test archives and the actual v0.1 local `owner/onestorage` snapshot migrate in JavaScript. macOS AppleDouble metadata is handled. The actual migrated main SHA is `da3fcc97ec2f4a2fab5618c2768fd64cafca06ae` and README content remained unchanged. After stopping/restarting the complete local workerd process, the migrated refs/content still matched, and a native clone plus `git fsck --full --strict` of the new-engine E2E repository passed.

### Existing collaboration and security

The E2E covers password login, scoped tokens, private/public access, membership lifecycle, reader write denial, issue discussions/states, immutable-SHA fast-forward merge and retry, simultaneous edits, stale edits, path traversal rejection, literal code search, CSRF, credential revocation and password-change invalidation. Browser HTML security headers and LFS SHA-256/binary/isolation endpoints are checked.

Webhook tests independently verify HMAC, success/duplicate handling, failure cap, SQLite-backed delivery leases, outbox replay eligibility and revoked egress allowlist. No real third-party messages are sent.

## Cloud results

Deployed **https://git.1s.hk**, also reachable at `https://onestorage.xbitfun.workers.dev`. Resources are real remote D1, R2, SQLite Durable Objects and Queues. All three D1 migrations applied remotely. No Container bindings/images exist. `1s.hk` still returns the Cubelink page.

A dedicated temporary, non-admin account/PAT and repository exercised the custom domain:

- HTTPS health and private authorization; administrator setup remains unclaimed for the operator.
- Empty clone, push with forced HTTP chunking, incremental history and annotated tag push.
- Protocol v0 and v2 clone; exact SHA/binary comparison and native `git fsck --full --strict`.
- Concurrent API edits using the same old SHA: exactly one succeeded, the other returned 409.
- Remote R2 LFS SHA-256 upload/download byte match.
- Public anonymous clone and strict native integrity check.

Acceptance revoked/deleted the temporary credentials, account and D1 repository metadata. Small unreachable R2 objects and DO refs remain because no GC exists. The private initialization secret was uploaded to Worker secrets and saved locally with mode 0600, outside source control. No production administrator/password was chosen on the operator's behalf.

At initial validation, Cloudflare and Google public DNS resolved the new domain while the machine's local resolver retained NXDOMAIN. Cloud acceptance used the public DNS IP with the real hostname and **TLS verification enabled**; it did not disable certificate checks or change local DNS settings.

## Not covered

Production load and exhaustion testing; region failure; coordinated D1/R2/DO recovery; independent security review; live external Webhook deliveries; native `git-lfs` CLI (its HTTP endpoints were tested directly); shallow/partial clone, SSH, SHA-256 Git repositories or GitLab feature parity.

The prior UI was manually exercised locally for login, private project creation, README editing and persisted content. This iteration changed the backend and domain/version/source links; a new remote browser interaction audit, mobile/cross-browser and accessibility audit are not claimed.
