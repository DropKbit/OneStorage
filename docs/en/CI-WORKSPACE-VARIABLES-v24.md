# Space CI variables and secrets (v0.24)

[简体中文](../CI-WORKSPACE-VARIABLES-v24.md) · **English**

Space owners manage shared definitions in space settings. Projects explicitly select names through task `variables` and `environment`. Project CI shows inherited names, environment/branch restrictions, version, source space, and availability, never values. Project maintainers cannot edit space definitions; administrator status does not bypass ownership.

Selection order for each name is project exact environment, project `*`, space exact environment, space `*`. A paused, unauthorized, or branch-disallowed highest-priority definition fails rather than falling through. Deleting an override restores the next definition for new jobs.

Configuration, Worker input, external-runner environment, protection requirements, and MR restrictions match [project variables](CI-VARIABLES-v20.md). For example, space-level `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` can be explicitly selected by projects. Owners must trust every eligible project's build code with shared secrets.

Each space allows 100 definitions, independently of each project's 100. Jobs still select at most 30 names/64 KiB total values. Exact environments/branches and `*` are supported. Spaces are single-level: no nested groups, instance-level variables, GitLab file variables, or full YAML expansion.

## Changes and revocation

Values use space-specific authenticated encryption context and are copied only into a job's encrypted first-use snapshot, not into project definitions. Snapshots bind each job/version; completed historical masking survives definition deletion.

Management transactions recheck current owner role, enabled account, and valid write session/PAT. A variable's original owner must remain a space owner; project maintenance rights alone are insufficient. Taking ownership increments revision and pauses the definition until explicitly enabled.

Editing, rotation, pause, takeover, deletion, or owner revocation cancels bound unfinished jobs and parent workflows across projects and invalidates leases. Projects transferred out cannot read former-space values or use a sibling project's membership to authorize old snapshots. New runs use destination rules. Archive, deletion, and protection changes retain their cancellation gates.

First binding atomically checks selection priority, version, space, role, protection, and lease, preventing a newly inserted higher-priority override from being bypassed. After binding, the pinned snapshot remains until revoked; merely creating another override affects new jobs. Values already delivered to code cannot be recovered; masking is not protection against deliberate transformed output.

## API and deployment

- `GET/POST /api/workspaces/:slug/ci/variables`: owner metadata/list/create.
- `PUT/DELETE …/:variable`: current `revision`; omitted `value` preserves it.
- `POST …/:variable/take-ownership`: revision; takeover pauses.
- Project `GET …/ci/variables` keeps project `variables` and adds `inherited` metadata.

Migration `0019_workspace_ci_variables.sql` adds independent tables/views and revocation triggers without rewriting old ciphertext or snapshots. Export and restore-test D1, rehearse migration/integrity/foreign keys/counts, and retain `CREDENTIAL_ENCRYPTION_KEY`. Deploy only the main Worker; Git/R2/DO formats and compiler/gateway do not change.

`npm run check` includes real SQLite inheritance/revocation tests. `test:workspace-variables` exercises real Workers and the shipped runner; `test:workspace-variable-ui` covers owner CRUD, inherited metadata, and mobile layout. Remote acceptance requires explicit opt-in and cleans temporary projects/spaces. See [verification](VERIFICATION-v24.md). The project-over-group precedence draws on [GitLab variables](https://docs.gitlab.com/ci/variables/); OneStorage's snapshot/revocation contract is defined here.
