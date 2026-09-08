# Verification — v0.3.0

[简体中文](../VERIFICATION.md) · **English**

Date: 2026-09-08, Asia/Singapore. Baseline v0.2 commit `e72e52d`. Runtime: local workerd and Cloudflare Workers, with the same container-free JavaScript Git engine. Native Git is a client/oracle only.

## Reference and acceptance scope

Reviewed the public Code Storage docs index, 101 unique Markdown pages and OpenAPI. `parity.json` maps 40 preferred operations and 11 cross-cutting capabilities to implementation files and test evidence. `test:parity` validates the manifest; it is not a substitute for behavioral tests or a claim of cloud verification. API paths, SDK packages, storage architecture and capacity differ from the reference.

## Local results

- `npm run check`: TypeScript and **57 passing tests**, including Git objects/protocol, corruption rejection, immutable storage/ref failures, signatures, merge/patch/blame, JWT/SDK, sync persistence, GitHub App crypto and LFS forwarding, deletion and webhook leases/outbox.
- `npm run test:e2e`: **43 HTTP assertions** plus native Git v0/v2, binary/modes/tags/thin pushes, concurrent CAS, LFS, roles, Issues, pinned fast-forward MRs, CSRF and revocation. Fixture: `owner/e2e_f58f9952`.
- `npm run test:features`: **65 advanced HTTP checks** against real workerd/D1/R2/DO: scopes/revocation, policy, namespace isolation, NDJSON, Notes/tags, raw ranges/conditions, fork/default branch/deletion, credentials, MCP permissions.
- `npm run test:git-features`: actual native Git SSH-signed push accepted; unsigned and revoked-key pushes rejected; grouped repository names, ephemeral/import remotes and Git Notes interoperable.
- `npm run test:sdks`: TypeScript, Python and Go use generated short-lived signing keys against workerd; binary streaming, Notes, ephemeral refs, fork, UUID URL resolution, archive sinks and seven agent workflows passed. Keys revoked after the run. Python 3.12.14/cryptography 50.0.1, Go 1.27.1; no external service credentials involved.
- Native Git independently accepts generated text/binary patches, including literal/delta, mode changes, rename/copy and UTF-8 quoted paths. Merge fixtures cover three-way changes, conflicts, rename/edit and ambiguous multiple bases. Blame covers ranges and moved/copied blocks.
- Public GitHub import has been exercised through the local Queue and JavaScript HTTP Git client against `octocat/Hello-World`; the final clean rerun also passed. One earlier rerun timed out after a dev hot reload interrupted queue work; no failing run is counted as a pass.
- Browser: local key and Git workbench screens inspected; created `ui-check` in the ephemeral namespace from normal `main`, observed its real SHA, then deleted it and confirmed zero ephemeral branches. No full accessibility/cross-browser audit claimed.

## Failure and external-service coverage

Injected R2/ref writes cannot publish missing objects. SQLite-backed tests exercise persistent sync jobs, leases, event projection/replay and deleted-repository cleanup. Fork copies while holding the destination queue so deletion cannot clean up before a late copy. Upstream-first publication retains its recovery marker until the following sync job is durable. Pending uncertain outcomes fail closed and retry actual upstream fetches.

A local native Git HTTP backend is an independent upstream protocol fixture for bidirectional push/fetch. GitHub App token and signed incoming webhook tests use real RSA/HMAC cryptography with a simulated provider. LFS batch/action forwarding and cache digest checks are tested with a simulated provider. **No real private GitHub App installation or external private upstream credential was supplied**; that deployment-specific integration is not cloud verified. Outgoing Webhook tests use controlled receivers, not real third-party messages.

## Release verification

Production runtime deployed as version `096eea88-8894-42e2-ae86-a0b6c8920240` on **https://git.1s.hk**. D1 migration 0004 applied after an operator-local D1 export; the existing `1shk/nb` mirror was backed up and passed native `git fsck --full --strict`. A fresh 32-byte credential-encryption secret was uploaded without including it in source. Existing account and repository identity were preserved.

`node --import tsx scripts/verify-cloud.mjs` passed **14 groups of checks** on generated, operator-owned private repositories using a temporary process copy of the authorized PAT. It exercised all 40 mapped REST operations: grouped names, URL lookup/listing, streamed binary commits, raw GET/HEAD/Range/ETag, archive, files/metadata/history/grep/blame, branch and ephemeral refs, diff patch, merge preview/merge, restore/reset, Notes/tags CRUD, default branch/fork, encrypted credential CRUD/detach, and pull-upstream. MCP tools discovery and anonymous denial, llms.txt and the 40-operation OpenAPI also passed.

Public `octocat/Hello-World` import passed through **actual remote Queue, Worker Git client/pack parser, R2 and DO refs**. All generated acceptance repos were deleted, and reads confirmed tombstone/hidden state. Deletion schedules physical cleanup; unit tests separately cover its incremental algorithm. The original private `1shk/nb` was not used for destructive acceptance.

The runtime received one subsequent bounded grep-cursor correction (covered by a new regression test and an actual two-page cloud query). Complete source commit `908c916b95a3a87e4782c731ffec41ae13b288d8` was pushed to the existing private `1shk/nb`; a fresh HTTPS mirror clone returned that exact SHA and passed `git fsck --full --strict`. The deployed source archive's SHA-256 exactly matched the local generated archive.

Two initial full-source push attempts returned an object/ref persistence failure and left the remote at `e72e52d`; a later unchanged retry succeeded. The underlying exception was not reproduced after adding structured server diagnostics to the Git publication error path, so this is recorded as successful recovery, not a proven root-cause fix. Unexpected storage failures keep the existing safe client error and now provide operator logs. The final follow-up commit contains these diagnostics and the completed verification record. `1s.hk` returned HTTP 200 with the Cubelink page after deployment. No root-domain route or Cubelink resource changed. Source archive audit excluded `.data`, `.wrangler`, dependencies, cached bytecode, PATs and embedded private keys.

`cloud_verified` means the listed acceptance cases passed, not that every local security fixture or all supported providers were repeated remotely. In particular, JWT/signature policies and generic bidirectional/GitHub App behavior retain their explicit local/mock verification scope. Historical v0.2 cloud/upgrade evidence remains in [VERIFICATION-v0.2.md](VERIFICATION-v0.2.md); its unclaimed-administrator statements are historical, not current state.

## Limits not validated as production guarantees

No load/region-failure/complete disaster-recovery exercise, independent security audit, SHA1DC equivalence, native git-lfs CLI or TB-scale claim. No real private GitHub App installation test. The merge/blame/rename and protocol limits in README/API are intentional exposed boundaries; future scale, quotas, active-object GC, backup tooling and full GitLab organization/CI features are outside this Code Storage feature mapping.
