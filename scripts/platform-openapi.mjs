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
}
