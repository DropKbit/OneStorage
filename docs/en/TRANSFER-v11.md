# Project transfers and renaming (v0.11)

[简体中文](../TRANSFER-v11.md) · **English**

A project owner can rename a project or transfer it to a personal/team namespace they own. Platform administrators cannot bypass ownership. Read-only PATs and repository JWTs cannot transfer projects.

`POST /api/repos/:namespace/:repo/transfer` accepts `namespace`, optional `name`, and the current lifecycle `revision`. The repository UUID remains unchanged, preserving Git objects, issues, reviews, releases, LFS, and history. Direct members remain; inherited namespace permissions are recalculated. Archived projects stay archived.

Across namespaces, transfer cancels CI and synchronization, revokes runner Git connections, removes webhooks/deliveries and upstream configuration, and disables automatic/public deployment settings. HTTP requests already sent cannot be recalled. Configure connections again in the destination. Personal PATs and JWTs are not globally revoked; every subsequent request still checks current permissions and paths.

A rename within the same namespace preserves connections, active runs, and public applications, while updating job revisions. Git URLs change; application identity based on the UUID does not.

Projects that are initializing or reconciling return `409`. Pending merge projections must be recovered first. Old paths become UUID-based aliases pointing directly to the current path, without redirect chains. Authorized browser/API reads receive `307`; private destinations are not disclosed to unauthorized callers. API writes must use the new path. Native Git POST requests to old URLs are authorized again and processed directly.

Former namespace members lose inherited access. Other projects cannot claim reserved aliases; the same project can return to a previous path. Deletion and garbage collection remove aliases.

The Durable Object queue and a D1 transaction coordinate ownership, names, revisions, connection changes, and audit records. A request-scoped D1 wrapper batches revision checks with reads/writes, including `RETURNING`; it never mutates shared environment bindings. Global outbox work uses its separate binding.

Durable Object reads check the lifecycle revision after entering the queue. Lifecycle changes invalidate the marker first; D1 recovery repairs the cache or fails closed. Synchronization jobs with old revisions become inert. See [architecture](ARCHITECTURE.md) and [v0.11 verification](VERIFICATION-v11.md) for reference publication and lifecycle checks.
