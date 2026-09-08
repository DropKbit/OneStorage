# v0.7 cross-fork reviews and code discussions

[简体中文](../REVIEWS-v07.md) · **English**

This increment continues Cloudflare-native collaboration with Workers JavaScript, R2 objects, and DO reference coordination; no container or Git server process is added.

## Cross-fork merge requests

Choose source repository/branch in the target’s Merge requests page. Candidates are repositories in the same fork network where the user has developer access, including parent, child, and sibling forks. Public targets do not require contributor write access; private targets require read access. Same-repository requests still require developer access. Target maintainers merge and run target CI.

Creation resolves a fixed ordinary-branch commit in the source DO. Inside its own queue, the target DO reads, validates, and stores reachable source Git objects and existing LFS content from R2. The entire contributed branch history is disclosed to target readers, not just a diff. Other branches, tokens, and source configuration are not copied. The UI explains this deliberate code sharing.

Copying does not update target branches, grant target roles, or run source CI. The target does not call the source DO while holding its own queue, avoiding reciprocal cross-DO deadlocks. Deletion shares the queue, preventing late imports after target cleanup.

Requests record source repository ID/name, branch, source/target SHAs, and revision. Details/history read the retained snapshot. Source advancement marks a request stale; refreshing recalculates approvals and CI for the new SHA. Updating private sources requires source developer access; target maintainers may refresh public sources. Disclosed snapshots remain readable after source deletion, but new merges require restoring the source or a new request; missing source is not implicit approval.

Merge preflight reads the current source branch. The target queue validates its version, target reference, reviews, and CI before fast-forward, three-way, or squash merge. Source commits arriving after preflight do not alter the approved snapshot or enter this merge. Target updates still use DO CAS; results persist for idempotent retries.

## Reviews and discussions

Diff line numbers start old/new-side discussions; general discussions are also supported. The server validates paths, real text lines, and both SHAs. Binary files use general discussions. Threads support replies, resolve/reopen, and outdated markers; refreshing never overwrites historical discussions.

Target developers may approve or request changes independently; authors cannot approve themselves. Thread authors, MR authors, or target developers may resolve threads. Signed-in public visitors may discuss, but their feedback alone is not a merge veto. The require-resolved protection counts unresolved threads, including outdated ones, started by currently active target developers. Pagination cannot hide blockers.

Request updates/closure, reviews, discussions, resolution, and merges share the target DO queue. A concurrent merge/reopen race allows one winner: a completed merge rejects later thread mutation; reopening first blocks the merge. PATCH revision rejects stale updates with 409; omission preserves legacy compatibility.

Discussions paginate 100 at a time using numeric after; replies also paginate 100. Details use discussions_after. Every read rechecks target access.

## Target repository CI

Maintainers run CI for a fixed source SHA using saved target configuration. Source-fork configuration, tokens, and deployment settings are not inherited. Gates accept only the latest successful target-repository pipeline for that SHA; source-run success cannot substitute.

Cloud JS/WASM steps remain isolated without bindings or external network. Explicit external-runner configuration means manually giving contributed code to that runner; it is not cloud isolation. This release neither automatically starts fork CI nor supplies main-service credentials to jobs.

## API and deployment

- GET `/api/repos/:namespace/:repo/merge-sources`: eligible sources.
- POST merges: `{title,body?,source,target,source_repo?}`; source_repo accepts ID or namespace/name and defaults to the same repository.
- PATCH merges/:id: `{refresh?,state?,title?,body?,revision?}`.
- POST merges/:id/pipeline: maintainer-triggered fixed-version CI.
- GET/POST merges/:id/discussions: page/create; creation uses `{source_sha,target_sha,body,path?,side?,line?}`.
- GET/PATCH merges/:id/discussions/:discussion: replies or `{resolved:true|false}`.
- POST merges/:id/discussions/:discussion/comments: `{body}`.
- PUT protections adds require_resolved.

Back up D1, apply `0008_fork_reviews.sql`, and deploy the main Worker. The gateway is unchanged. At this release, snapshot budgets were 8 MiB/object, 32 MiB expanded objects/operation, and 5,000 traversed objects; these do not establish large-repository readiness. See current [limits](LIMITS.md).

CODEOWNERS, merge queues, issue closure, SSO, DAG/cache/secret builds, lifecycle, and packages were subsequent goals. References: [cross-fork collaboration](https://docs.gitlab.com/user/project/merge_requests/allow_collaboration/), [discussions](https://docs.gitlab.com/user/discussions/). OneStorage exposes independent APIs, not drop-in GitLab compatibility.
