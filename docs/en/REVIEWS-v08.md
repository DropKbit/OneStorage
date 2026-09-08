# v0.8 code owners, issue linkage, and Git I/O

[简体中文](../REVIEWS-v08.md) · **English**

## CODEOWNERS

Enable CODEOWNERS approval in Branch protection or set require_codeowners:true in PUT protections. This is independently enforced even with zero normal approvals or require_mr:false; ordinary pushes, web edits, and direct merges cannot bypass an MR.

Read the first file found at the reviewed target commit: CODEOWNERS, .gitlab/CODEOWNERS, docs/CODEOWNERS, .github/CODEOWNERS. Contributor changes do not alter the current gate; refreshing either SHA invalidates old approvals. Missing, nonregular, invalid UTF-8, or malformed files block merging. Cover the rules file itself so rule changes also require approval.

```text
# Default owners also cover this configuration
* @project-owner
[Backend][2] @alice @bob @carol
/src/
[Docs] @docs-workspace
/docs/**/*.md
[Security] @@maintainer @@owner
/auth/
^[Advice] @alice
*.md
```

- @username names a user. @workspace covers existing developer-or-higher members of the target project’s own workspace. Nested spaces, external team invitations, and email identities are unsupported.
- @@developer, @@maintainer, @@owner match the user’s **highest effective target role**, including inheritance. Roles match exactly; maintainers do not automatically satisfy @@developer. This differs from GitLab direct-role semantics.
- Authors cannot self-approve. Disabled, removed, or downgraded members stop counting immediately. Mentioning a name grants no access; administrators have no implicit review authority.
- Patterns support root paths, filenames at any depth, *, ?, **, **/, directory descendants, and escaped spaces. RE2 avoids backtracking exhaustion.
- Last matching rule wins within each section. Sections and matching rules count separately; owners form candidate sets. [Section][2] requires two independent approvals for each matched rule; one person may satisfy several rules. Repeated section names merge case-insensitively using the higher required count.
- ^[Section] is optional. !path clears that section’s requirement. Paths without explicit owners inherit section defaults; empty defaults can explicitly remove coverage.
- Only full-line # comments are supported. Inline comments, character classes, emails, nested groups, and other unsupported syntax fail explicitly.
- Tree comparison covers deletions, both rename endpoints, executable bits, symlinks, and submodules without reading every blob. Target-only changes may also need approval because comparison conservatively uses two snapshots.

MR gate.codeowners includes file, target SHA, errors, and per-rule requirements. Counts cover all matches; display is capped at 20 paths, 50 candidates, and 10 approvers per rule, with path_count/eligible_count/approved_count. Budgets: 128 KiB / 1,000 rule lines, 1,000 candidate members, and 250,000 path-rule comparisons. Exceeding them fails explicitly; Git object/depth limits also apply.

## Close issues on merge

Only merging into the **default branch at merge time** activates Closes/Fixes/Resolves #123 and supported singular/plural/tense variants in the MR body and newly introduced commit messages. Commas and and lists work. Only numeric IDs in the target repository are accepted; cross-project references, URLs, ordinary mentions, code blocks, inline code, quotes, and HTML comments do not close issues. Direct pushes, custom regex, and cross-project closure are unsupported.

Details return closing_issues and links. The UI submits MR revision; stale body/snapshot changes cause 409 and reload. APIs can send revision too. Nondefault targets do not close issues, and messages already in target history are not replayed. Limits are 100 references and 1 MiB of new commit messages. No-code-change merges still record results and process body instructions.

DO publication atomically stores references, merge result, issue plan, and pending projection. A D1 transaction updates the MR and unique (mr_id,issue_id) records drive closure, system comments, audit, and notifications. DO alarms/client retries repair D1 failure. Processed records neither duplicate comments nor reclose manually reopened issues. Recovery uses the original default-branch condition and actor, not later settings.

## Git I/O

Graph reads and immutable writes use up to two concurrent operations; identical in-flight OID reads in a request share one R2 request. Every edge still checks expected type, duplicate writes compare bytes, and SHA-1/graph/object budgets remain. At this release, limits were 8 MiB/object and 32 MiB expanded data. On failure, already-started I/O completes before returning; references never publish before validation.

This reduces cold-cache serialization, not guaranteed twofold speedups. History chains, DO queuing, networking, and large objects may dominate. Browser interaction and real large-repository throughput need separate measurement.

## Deployment and acceptance

Back up D1, apply `0009_codeowners.sql`, and deploy the Worker. The app gateway is unchanged.

```sh
npm run check
node scripts/e2e-codeowners.mjs
npm run test:reviews
npm run test:collaboration
```

Production scripts require explicit TEST_ORIGIN, ALLOW_REMOTE_ACCEPTANCE=1, and a local-only ONESTORAGE_TOKEN_FILE. They create isolated workspaces/repositories and clean repositories, spaces, and user credentials afterward. Current primary URL: https://1s.hk.

References: [GitLab CODEOWNERS](https://docs.gitlab.com/user/project/codeowners/reference/), [automatic issue closure](https://docs.gitlab.com/user/project/issues/managing_issues/). These are OneStorage contracts and differences, not full GitLab API/syntax compatibility.
