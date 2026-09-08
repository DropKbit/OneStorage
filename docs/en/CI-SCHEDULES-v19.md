# Scheduled pipelines (v0.19)

[简体中文](../CI-SCHEDULES-v19.md) · **English**

Create, edit, pause, take ownership of, and delete schedules in project CI/CD. Schedules reuse Worker/external/DAG execution, logs, artifacts, cancellation, and deployment gates. Cloudflare Cron checks D1; Queues consume durable events; isolated JS/WASM executes in Dynamic Workers without containers.

Save inline or repository JSON configuration first. A schedule specifies a name, branch, five-field Cron expression, and IANA timezone. For example, `0 9 * * 1-5` with `Asia/Singapore` means 09:00 weekdays in Singapore. Unix weekdays use 0/7 for Sunday and 1 for Monday. Deterministic cron-parser expressions are supported; seconds, random `H`, `?`, and aliases such as `@daily` are rejected. cron-parser/Luxon handles timezone and daylight-saving transitions. The interface displays the next time in the schedule's timezone.

These expressions are distinct from Cloudflare's single UTC `*/5 * * * *` trigger. OneStorage computes individual due times. Checks occur every five minutes; queues and capacity can add delay. Missed occurrences coalesce into one event, with no historical catch-up run for every tick. Minute-frequency expressions do not increase polling frequency. Limits: 20 schedules per project, 50 due schedules scanned and 100 durable events retried per scan. A pending event must dispatch before that schedule creates another.

Schedule enablement is independent of push triggers and push `branches` filters. On processing, the branch is resolved and its code SHA/configuration snapshot pinned, rather than reconstructing a historical reference. MR selection rules are unchanged.

## Durability and permissions

D1 atomically inserts a unique time-slot event and advances the schedule. Repeated scheduling/delivery cannot duplicate a pipeline. Queue failures retry through Cron. At the 20-active-pipeline limit, the event retains its pinned inputs. Invalid configuration creates a failed run; missing branch/configuration records a schedule error, allowing a later period to try again.

Execution uses the owner's current maintenance rights, without storing a session or PAT. Revoking the creation PAT does not delete a schedule. Disabling the owner or removing their last maintenance role pauses it, cancels pending events/runs, and revokes leases. Other qualifying direct/inherited roles prevent unnecessary cancellation. Administrator status alone is insufficient.

Archive, deletion, and cross-space transfer stop schedules. Restoring access or a project does not resume them automatically. Editing, pausing, taking ownership, or deleting cancels unfinished runs. Taking ownership requires maintenance rights and leaves the schedule paused. Mutations require the current `revision`; stale writes return `409`. D1 rechecks permissions and lifecycle at the transaction boundary. Existing history survives deletion.

## API

Prefix: `/api/repos/{namespace}/{repo}/ci/schedules`. User sessions/PATs only; no delegated JWTs.

- `GET /`: members read ownership, next time, latest run, and dispatch errors.
- `POST /`: maintainers submit `{name,ref,cron,timezone,enabled}`; defaults UTC/true.
- `PUT /{schedule}`: full configuration plus `revision`; enabling requires a qualified owner.
- `POST /{schedule}/take-ownership`: `{revision}`; assigns the caller and pauses.
- `DELETE /{schedule}`: `{revision}`; removes the schedule and cancels unfinished work.

Runs record `trigger: schedule`, owner `actor_id`, and `schedule_tick_id`. Processed events remain at least 30 days; events attached to runs remain longer. Deletion removes schedule relationships, preserving run history.

## Deployment and historical verification

Back up/restore-test D1, apply `0015_ci_schedules.sql`, then deploy the main Worker. This release did not change R2/DO formats or the application gateway.

v0.19 passed type checking/216 unit tests, local schedules 14 checks/91 assertions, schedule UI 14 checks, core 43 assertions plus native Git/LFS, workflows 23 checks/97 assertions, general UI 42 checks, workflow UI 18, and Git → DAG → fsck 21. Production schedules passed 14 checks/87 assertions with actual Cloudflare Cron confirmed in tail, followed by a two-stage Dynamic Worker workflow. Commit: `c19f539d08398a041f6cc8352631d2421c852771`. A THU/random-H validation bug was fixed and both local/production tests rerun. Independent production Git/DAG regression passed 21 checks. Backups, migration rehearsal, integrity/foreign-key checks, and fixture/R2 cleanup passed.

References: [Cloudflare Cron](https://developers.cloudflare.com/workers/configuration/cron-triggers/), [cron-parser](https://github.com/harrisiirak/cron-parser). See [roadmap](ROADMAP.md) for current scope.
