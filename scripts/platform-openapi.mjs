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
  ["post", "/api/runner/runs/{id}/logs", "runner_logs"],
  ["put", "/api/runner/runs/{id}/artifacts/{name}", "runner_artifact"],
  ["post", "/api/runner/runs/{id}/complete", "runner_complete"],
];
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
        "See docs/PLATFORM-v04.md in the source archive. Platform management requires a user session or PAT; delegated JWTs are not accepted. Runner routes require a separate repository-scoped runner token.",
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
  }
}
