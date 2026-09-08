// Platform operations supplement the Git compatibility matrix.
const base = "/api/repos/{namespace}/{repo}/ci";
export const platformOperations = [
  ["get", "/api/workspaces", "list_workspaces"],
  ["post", "/api/workspaces", "create_workspace"],
  ["get", "/api/workspaces/{slug}", "get_workspace"],
  ["patch", "/api/workspaces/{slug}", "update_workspace"],
  ["delete", "/api/workspaces/{slug}", "delete_workspace"],
  ["get", "/api/workspaces/{slug}/members", "list_workspace_members"],
  ["put", "/api/workspaces/{slug}/members", "set_workspace_member"],
  [
    "delete",
    "/api/workspaces/{slug}/members/{username}",
    "remove_workspace_member",
  ],
  ["get", "/api/admin/overview", "admin_overview"],
  ["get", "/api/admin/users", "admin_users"],
  ["patch", "/api/admin/users/{id}", "admin_update_user"],
  ["get", "/api/admin/workspaces", "admin_workspaces"],
  ["put", "/api/admin/workspaces/{id}/owner", "admin_recover_workspace"],
  ["get", "/api/admin/repositories", "admin_repositories"],
  ["patch", "/api/admin/repositories/{id}", "admin_update_repository"],
  ["delete", "/api/admin/repositories/{id}", "admin_delete_repository"],
  ["get", "/api/admin/audit", "admin_audit"],
  ["get", base + "/caches", "ci_list_caches"],
  ["post", base + "/caches/clear", "ci_clear_caches"],
  ["get", "/api/runner/runs/{id}/caches/{slot}", "runner_restore_cache"],
  ["put", "/api/runner/runs/{id}/caches/{slot}", "runner_upload_cache"],
  ["get", base + "/variables", "ci_list_variables"],
  ["post", base + "/variables", "ci_create_variable"],
  ["put", base + "/variables/{variable}", "ci_update_variable"],
  ["delete", base + "/variables/{variable}", "ci_delete_variable"],
  [
    "post",
    base + "/variables/{variable}/take-ownership",
    "ci_take_variable_ownership",
  ],
  ["get", "/api/runner/runs/{id}/variables", "runner_variables"],
  ["get", base + "/schedules", "ci_list_schedules"],
  ["post", base + "/schedules", "ci_create_schedule"],
  ["put", base + "/schedules/{schedule}", "ci_update_schedule"],
  ["delete", base + "/schedules/{schedule}", "ci_delete_schedule"],
  [
    "post",
    base + "/schedules/{schedule}/take-ownership",
    "ci_take_schedule_ownership",
  ],
  ["get", base + "/config", "ci_config"],
  ["put", base + "/config", "ci_save_config"],
  ["get", base + "/runs", "ci_list_runs"],
  ["post", base + "/runs", "ci_run"],
  ["get", base + "/runs/{id}", "ci_get_run"],
  ["post", base + "/runs/{id}/cancel", "ci_cancel"],
  ["post", base + "/runs/{id}/retry", "ci_retry"],
  ["get", base + "/runs/{id}/artifacts/{artifact}", "ci_download_artifact"],
  ["get", base + "/runners", "ci_runners"],
  ["post", base + "/runners", "ci_register_runner"],
  ["delete", base + "/runners/{runner}", "ci_revoke_runner"],
  ["post", "/api/runner/claim", "runner_claim"],
  ["post", "/api/runner/runs/{id}/heartbeat", "runner_heartbeat"],
  ["get", "/api/runner/runs/{id}/source", "runner_source"],
  ["get", "/api/runner/runs/{id}/inputs", "runner_dependency_inputs"],
  ["post", "/api/runner/runs/{id}/logs", "runner_logs"],
  ["put", "/api/runner/runs/{id}/artifacts/{name}", "runner_artifact"],
  ["post", "/api/runner/runs/{id}/complete", "runner_complete"],
];
platformOperations.push(
  ["get", "/api/repos/{namespace}/{repo}/protections", "list_protections"],
  ["put", "/api/repos/{namespace}/{repo}/protections", "set_protection"],
  ["delete", "/api/repos/{namespace}/{repo}/protections", "remove_protection"],
  ["get", "/api/repos/{namespace}/{repo}/merges/{id}", "get_merge_request"],
  [
    "patch",
    "/api/repos/{namespace}/{repo}/merges/{id}",
    "update_merge_request",
  ],
  [
    "post",
    "/api/repos/{namespace}/{repo}/merges/{id}/reviews",
    "review_merge_request",
  ],
  [
    "post",
    "/api/repos/{namespace}/{repo}/merges/{id}/merge",
    "merge_reviewed_request",
  ],
  ["get", "/api/repos/{namespace}/{repo}/planning", "repository_planning"],
  ["post", "/api/repos/{namespace}/{repo}/labels", "create_label"],
  ["delete", "/api/repos/{namespace}/{repo}/labels/{id}", "delete_label"],
  ["post", "/api/repos/{namespace}/{repo}/milestones", "create_milestone"],
  [
    "patch",
    "/api/repos/{namespace}/{repo}/milestones/{id}",
    "update_milestone",
  ],
  ["put", "/api/repos/{namespace}/{repo}/issues/{id}/planning", "assign_issue"],
  ["get", "/api/repos/{namespace}/{repo}/releases", "list_releases"],
  ["post", "/api/repos/{namespace}/{repo}/releases", "create_release"],
  ["delete", "/api/repos/{namespace}/{repo}/releases/{id}", "delete_release"],
  ["get", "/api/repos/{namespace}/{repo}/deployments", "list_deployments"],
  [
    "put",
    "/api/repos/{namespace}/{repo}/environments/{name}",
    "activate_deployment",
  ],
  ["get", "/api/repos/{namespace}/{repo}/wiki", "wiki_pages"],
  ["get", "/api/repos/{namespace}/{repo}/wiki/{page}", "wiki_page"],
  ["put", "/api/repos/{namespace}/{repo}/wiki/{page}", "write_wiki"],
  ["get", "/api/repos/{namespace}/{repo}/social", "repository_social"],
  ["put", "/api/repos/{namespace}/{repo}/star", "star_repository"],
  ["delete", "/api/repos/{namespace}/{repo}/star", "unstar_repository"],
  ["put", "/api/repos/{namespace}/{repo}/watch", "watch_repository"],
  ["delete", "/api/repos/{namespace}/{repo}/watch", "unwatch_repository"],
  ["get", "/api/notifications", "list_notifications"],
  ["post", "/api/notifications/read", "read_notifications"],
);
export function addPlatformPaths(paths) {
  for (const [method, path, id] of platformOperations) {
    const parameters = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => ({
      name: m[1],
      in: "path",
      required: true,
      schema: { type: "string" },
    }));
    if (path.startsWith("/api/runner/runs/"))
      parameters.push({
        name: "X-Run-Lease",
        in: "header",
        required: true,
        schema: { type: "string" },
      });
    (paths[path] ||= {})[method] = {
      operationId: id,
      summary: id.replaceAll("_", " "),
      tags: [
        path.includes("/runner/")
          ? "Runner"
          : path.includes("/ci/")
            ? "CI/CD"
            : path.includes("/admin/")
              ? "Administration"
              : "Workspaces",
      ],
      description:
        "See docs/PLATFORM-v04.md and docs/CLOUD-NATIVE-v05.md in the source archive. Platform management requires a user session or PAT; delegated JWTs are not accepted. Runner routes require a separate repository-scoped runner token.",
      parameters,
      security: [{ bearerAuth: [] }],
      responses: {
        200: { description: "Successful response" },
        201: { description: "Created" },
        400: { description: "Invalid input" },
        401: { description: "Authentication required" },
        403: { description: "Insufficient role" },
        404: { description: "Not found" },
        409: { description: "State conflict" },
      },
    };
    const operation = paths[path][method];
    if (id.includes("cache")) {
      operation.description =
        "Shared repository CI cache; see docs/CI-CACHES-v21.md. Metadata requires project read role; clear requires maintain role and current generation. Contents only flow through the configured task slot under runner token and X-Run-Lease. Keys derive from immutable key files; repository, branch/protection generation and runner format are isolated. Only successful jobs/parents are reusable. Clear invalidates pending writes and schedules R2 collection. Up to four slots/job, 64 MiB compressed/entry, 512 MiB and 100 entries/project, seven-day TTL. Runner archives must contain ordinary files only, expanded <=256 MiB and 25000 entries.";
      if (id === "ci_clear_caches")
        operation.requestBody = {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                properties: { generation: { type: "integer", minimum: 0 } },
                required: ["generation"],
              },
            },
          },
        };
      if (id === "runner_upload_cache") {
        operation.parameters.push(
          {
            name: "Content-Length",
            in: "header",
            required: true,
            schema: { type: "integer", minimum: 1, maximum: 67108864 },
          },
          {
            name: "X-Cache-SHA256",
            in: "header",
            required: true,
            schema: { type: "string", pattern: "^[a-f0-9]{64}$" },
          },
        );
        operation.requestBody = {
          required: true,
          content: {
            "application/gzip": {
              schema: { type: "string", format: "binary" },
            },
          },
        };
      }
      if (id === "runner_restore_cache")
        operation.description +=
          " A miss returns JSON {hit:false}; a hit is application/gzip with Content-Length and X-Cache-SHA256. All responses are no-store.";
    }
    if (id === "ci_save_config" || id === "ci_config") {
      operation.description =
        "Worker execution steps also support type=build: entry, sources (recursive file/directory selection), outfile, platform (worker/browser), minify, sourcemap, jsx and jsx_import_source. Builds run esbuild WASM in a private Cloudflare service; npm dependencies require matching package-lock v2/v3 with SHA-512 registry tarballs. Private OneStorage packages use private_registries [{project_id,token_variable}], maximum 8 distinct projects. Each token_variable must be selected in job variables and stored as a secret deployment token with package read scope. Main Worker verifies immutable R2 package bytes and current authority; compiler never receives credentials. See docs/CI-PRIVATE-PACKAGES-v27.md. Does not run shell/npm lifecycle scripts. See docs/CI-BUILDS-v22.md for limits and deploy artifact configuration.";
    }
    if (id.includes("variable")) {
      operation.description =
        "Project CI variables: see docs/CI-VARIABLES-v20.md. Management requires maintain role and returns metadata only; values are write-only and encrypted. Updating/revoking a bound variable cancels active runs. Secrets/protected variables reject MR origins including retries; first use requires current branch SHA. Exact environment overrides *. Runner retrieval requires repository runner token plus X-Run-Lease and returns private variables/patterns with no-store.";
      if (method !== "get") {
        const full = id === "ci_create_variable" || id === "ci_update_variable";
        const properties = full
          ? {
              key: { type: "string", pattern: "^[A-Z_][A-Z0-9_]{0,79}$" },
              environment: { type: "string", default: "*" },
              value: {
                type: "string",
                minLength: 1,
                maxLength: 8192,
                writeOnly: true,
              },
              secret: { type: "boolean", default: true },
              protected: { type: "boolean", default: true },
              enabled: { type: "boolean", default: true },
              refs: {
                type: "array",
                minItems: 1,
                maxItems: 20,
                items: { type: "string" },
              },
              revision: { type: "integer", minimum: 0 },
            }
          : { revision: { type: "integer", minimum: 0 } };
        operation.requestBody = {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                properties,
                required:
                  id === "ci_create_variable"
                    ? ["key", "value"]
                    : full
                      ? ["key", "revision"]
                      : ["revision"],
              },
            },
          },
        };
      }
    }
    if (id.includes("schedule")) {
      operation.description =
        "Persistent scheduled pipeline; see docs/CI-SCHEDULES-v19.md. Member read access required; writes require maintainer. Cron uses five fields and IANA timezone, weekday 0/7=Sunday. Cloudflare scans every five minutes and coalesces missed occurrences. Editing or revoking a schedule cancels its unfinished runs. Takeover leaves it paused. Revision is required for existing schedule mutations.";
      if (method !== "get") {
        const fields = {
          name: { type: "string", minLength: 1, maxLength: 80 },
          ref: { type: "string" },
          cron: { type: "string", maxLength: 100 },
          timezone: { type: "string", default: "UTC" },
          enabled: { type: "boolean", default: true },
          revision: { type: "integer", minimum: 0 },
        };
        const full = id === "ci_create_schedule" || id === "ci_update_schedule";
        operation.requestBody = {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                properties: full
                  ? Object.fromEntries(
                      Object.entries(fields).filter(
                        ([k]) => k !== "revision" || method === "put",
                      ),
                    )
                  : { revision: fields.revision },
                required: full
                  ? [
                      "name",
                      "ref",
                      "cron",
                      ...(method === "put" ? ["revision"] : []),
                    ]
                  : ["revision"],
              },
            },
          },
        };
      }
    }
    if (id === "ci_save_config") {
      operation.description +=
        " Repository files are fixed to the pushed/manual SHA; merge requests select the target SHA configuration. See docs/CI-WORKFLOWS-v14.md for task schemas, dependency artifacts and limits.";
      operation.requestBody = {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                source_path: {
                  type: "string",
                  minLength: 1,
                  maxLength: 500,
                  description:
                    "Relative UTF-8 JSON configuration file, up to 128 KiB. Takes precedence over inline config.",
                },
                config: {
                  type: "object",
                  description:
                    "Worker/external steps, or runner=workflow with up to ten uniquely named jobs and acyclic needs dependencies.",
                },
                enabled: { type: "boolean", default: true },
              },
              anyOf: [{ required: ["source_path"] }, { required: ["config"] }],
            },
          },
        },
      };
    }
    if (id === "ci_get_run")
      operation.description +=
        " Includes config_path/config_sha/config_error, parent_id/job_key, and child jobs for a workflow. Lease hashes are never returned. Only top-level runs appear in ci_list_runs or satisfy merge gates.";
    if (id === "runner_dependency_inputs")
      operation.description +=
        " Returns dependencies[job][relativePath] = {content,binary}; binary content is Base64. Only declared successful siblings are included, up to 16 MiB raw data. Runner and lease authorization are checked again after storage reads.";
    if (id === "ci_retry")
      operation.description +=
        " Child jobs and invalid repository configuration records cannot be retried directly; retry the parent workflow or start a new run after fixing configuration. Ordinary retries preserve the original config snapshot.";
    if (id === "activate_deployment")
      operation.description +=
        " For workflow jobs, both the deployment job and the parent workflow must have succeeded.";
  }
  for (const suffix of [
    "/variables",
    "/variables/{variable}",
    "/variables/{variable}/take-ownership",
  ]) {
    const operations = structuredClone(paths[base + suffix]);
    for (const operation of Object.values(operations)) {
      operation.operationId = "workspace_" + operation.operationId;
      operation.summary = "Workspace " + operation.summary;
      operation.description =
        "Workspace owner and live write session/PAT required for mutations; metadata only. Project definitions override inherited workspace values. Paused winning definitions block fallback. Rotation or owner revocation cancels bound runs across projects. See docs/CI-WORKSPACE-VARIABLES-v24.md.";
      operation.parameters = (operation.parameters || [])
        .filter((p) => p.name !== "repo")
        .map((p) => (p.name === "namespace" ? { ...p, name: "slug" } : p));
    }
    paths["/api/workspaces/{slug}/ci" + suffix] = operations;
  }
  paths[base + "/variables"].get.description +=
    " Response includes inherited workspace metadata separately in inherited; variables remains the project definitions. See docs/CI-WORKSPACE-VARIABLES-v24.md.";
}
