# Versioned CI configuration and dependency workflows (v0.14)

[简体中文](../CI-WORKFLOWS-v14.md) · **English**

OneStorage supports Git-versioned JSON configuration and dependent jobs with separate runs, leases, logs, and artifacts. Existing single-pipeline JSON and external runners remain compatible. This is OneStorage's format, not GitLab YAML. Features described as future work in this historical release have their own later guides.

## Configuration

In CI/CD choose repository JSON, default `.onestorage-ci.json`. Save `{ "source_path": ".onestorage-ci.json", "enabled": true }`, or continue using `{ "config": {...}, "enabled": true }` for inline configuration. Files must be repository-relative UTF-8 JSON, at most 128 KiB.

Push reads the event's fixed SHA; manual runs resolve a branch and pin its SHA. Merge requests use target-commit configuration to test the fixed source commit: a fork cannot replace the target's rules. Runs show code SHA, configuration path, and configuration SHA. Ordinary retries reuse the original SHA and parsed snapshot. Missing/invalid files or unapproved HTTP destinations create visible failed runs; fix the configuration and create a new run. The automatic-trigger switch controls push, while maintainers can still run saved configuration manually. Push branch filters come from that version's `branches`.

Durable Object events first project to D1 `ci_events`; Queue consumers then read configuration, avoiding callbacks into a locked repository object. Failed sends remain durable for Cron retry. Event IDs, unique job keys, and conditional updates make delivery idempotent.

## Workflow example

```json
{
  "name": "Build and publish",
  "runner": "workflow",
  "branches": ["main"],
  "timeout_seconds": 300,
  "jobs": [
    {
      "id": "build",
      "pipeline": {
        "runner": "worker",
        "steps": [
          { "type": "javascript", "entry": "build.js", "files": ["build.js"] }
        ]
      }
    },
    {
      "id": "lint",
      "pipeline": {
        "runner": "worker",
        "steps": [{ "type": "file", "path": "package.json", "format": "json" }]
      }
    },
    {
      "id": "publish",
      "needs": ["build", "lint"],
      "pipeline": {
        "runner": "worker",
        "steps": [
          {
            "type": "javascript",
            "entry": "publish.js",
            "files": ["publish.js"]
          }
        ],
        "deploy": {
          "kind": "static",
          "entry": "index.html",
          "files": ["index.html"],
          "environment": "preview"
        }
      }
    }
  ]
}
```

At most ten jobs, with IDs matching `[a-z][a-z0-9_-]{0,39}`. Empty `needs` starts immediately; all dependencies must succeed before a downstream job starts. Duplicate IDs/dependencies, missing dependencies, self-dependency, cycles, and nested workflows are rejected. Each job uses the existing Worker or external pipeline format. Worker jobs cannot execute shell commands.

Ready jobs are sent in batches. Each consumer batch executes at most two CI messages concurrently; account and Queue limits also apply. There is no immediate-start guarantee. A repository allows 20 active top-level pipelines and 100 total active runs while scheduling children.

## Artifacts

Worker scripts receive only successful, directly declared dependencies from the same parent workflow as `dependencies[jobId][fileName] = { content, binary }`. Binary content is Base64; filenames are original relative paths. Inputs are not automatically outputs.

```js
// build.js
export default async ({ sha }) => ({ artifacts: { "index.html": `<h1>${sha}</h1>` } });
// publish.js
export default async ({ dependencies }) => ({ artifacts: { "index.html": dependencies.build["index.html"].content } });
```

Input artifacts total at most 4 MiB for Workers or 16 MiB for external runners, with additional encoded-size limits. Only published artifact-index entries are read, never arbitrary R2 prefixes or undeclared jobs. The shipped runner downloads into a temporary directory, sets `ONESTORAGE_DEPENDENCIES` and `ONESTORAGE_JOB`, validates paths, and removes the directory afterward.

## Completion and deployment

The parent succeeds only when every child succeeds. Failure, cancellation, or timeout ends the parent; D1 triggers revoke queued/running child leases and prevent downstream creation. External runners stop on their next failed heartbeat. Worker code may continue until its own timeout but cannot publish artifacts or success.

Worker jobs remain limited to 110 seconds, isolated JS steps to 20 seconds, with separate CPU budgets. Parent timeouts are checked during scheduling and by the five-minute Cron; reclamation is not precisely timed. Lost leases do not automatically repeat external deployments. Retry the entire workflow explicitly.

Merge gates consider top-level results only. Deployment jobs can create immutable versions, but activation and rollback targets require a successful parent workflow. Failed workflows retain logs and artifacts for diagnosis. Archive, transfer, deletion, and runner revocation preserve lifecycle barriers.

## Historical verification

v0.14 passed type checking and 153 unit tests; local workflows passed 23 semantic checks/97 HTTP assertions, collaboration 82 and platform 64 assertions, and workflow UI 18 checks. Native Git push → versioned DAG → clone/strict fsck passed 21 local and 22 production checks. Full production workflows passed 23 checks/98 assertions. Two four-second jobs overlapped by about 3.7 seconds in one observation, not an SLA. An earlier production submission returned 503; later passing runs did not establish its cause or prove it fixed.

Migration `0014_ci_workflows.sql` was backed up, restored/tested independently, and applied locally and remotely. Fixtures and credentials were cleaned. At that historical release, the application gateway and Cubelink were unchanged. For current deployment use [deployment](DEPLOYMENT.md).
