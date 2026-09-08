# v0.25 verification: Package registry

[简体中文](../VERIFICATION-v25.md) · **English**

Historical release evidence; these are not current-release test counts.

2026-09-09. Candidate 0d3444b; Worker c3eceaf0-ff24-4cf2-ad68-fe3431c35e42. Type checking/280 tests (16 new), dry run, local packages 60 checks/48 direct requests, core 43/Git/LFS, production packages 56/46, and Git/DAG/fsck 29 passed. npm internal requests are not included.

Actual npm covered scoped/unscoped names, versions/install/tags, SHA-512, partial/full unpublish, stale revisions, immutable withdrawn versions, and private denial. Large tests transferred 15-MiB random npm content and a 64-MiB generic file. Generic tests covered HEAD/Range/suffix/416/ETag, bad SHA-256, duplicate/concurrent publication, visibility, invalid tokens, deletion, rename aliases, and archive. Desktop Chromium checked file selection/hash/upload/details/withdrawal without errors; no mobile claim was added.

Unit tests covered hidden unfinished uploads, shared generic versions, in-flight revocation/lifecycle, late cleanup, uncertain successful commits, cleanup records surviving deletion, transactional tag limits, stream cancellation, manifest authority, PAX/GNU names, malicious paths/links/truncation/checksums/decompression bombs. Migration 0020 (17 statements) preserved 60 tables after independent D1 backup recovery; not full R2/DO recovery. Compiler/gateway/resource identities stayed unchanged. D1 confirmed zero fixture spaces/projects/versions/upload records; clients/credentials were removed, user PAT retained. Release assets/source/health and mirror/fsck were checked.

See [feature contract](PACKAGES-v25.md) and [current limits](LIMITS.md).
