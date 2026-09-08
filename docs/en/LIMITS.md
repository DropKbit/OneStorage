# Scope and capacity limits

[简体中文](../LIMITS.md) · **English**

Applies to v0.38. These are application budgets; Cloudflare platform limits may be reached sooner.

| Resource                                         | Limit / behavior                                                                              |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Single Git object / LFS file                     | 8 MiB / 16 MiB                                                                                |
| Incoming / streamed outgoing pack                | 64 MiB, 25,000 objects / 512 MiB, 100,000 objects                                             |
| Request object cache / native incoming expansion | 8 MiB LRU / 256 MiB total, staged in R2, plus temporary buffers                               |
| Git index traversal / references / depth         | 100,000 / 256 / 64; other history/directory algorithms retain independent 5,000-entry budgets |
| NDJSON commits                                   | 48 MiB transferred, 32 MiB decoded, 4 MiB per chunk, 6 MiB per line                           |
| Diff / search output                             | 4 MiB; search also has a computation budget                                                   |
| Unreachable objects in active repositories       | Retained; asynchronous cleanup occurs when the repository is deleted                          |

v0.12 introduced a durable repository-DO closure index and streamed packs. Validated history no longer needs repeated R2 reads, and common-commit negotiation avoids retransmitting history during incremental fetch. Output packs have no delta compression; cold clones still read individual objects from R2. CPU, memory, or subrequest limits may be reached first. v0.16 added streamed native pack reception and temporary R2 chunks. Final object writes, cold-clone throughput, large forks, and other history algorithms still need scaling work; see [incoming pack verification and limits](GIT-RECEIVE-v16.md). There are no TB-scale benchmarks, total storage quotas, cross-service consistent backups, or production SLA.

Three-way merges report explicit conflicts for criss-cross histories with multiple merge bases. Rename detection is conservative and bounded. Blame supports line/regex/function ranges and moved/copied blocks, but does not reproduce all Git language drivers. Public GitHub sync is manual and one-way. Generic upstreams do not support LFS; GitHub App LFS is limited to 16 MiB. Private GitHub App operation requires real installation details from the operator. Verification reports distinguish simulated-provider tests from real network tests.

SSH transport, SHA-256 repositories, shallow/partial clones, and the full GitLab API are not supported. Multiple workspaces, OIDC sign-in, native JS/WASM CI, and optional external runners are available; see their feature guides. SSH **commit signatures** and SSH **transport** are different capabilities; signatures are implemented.
