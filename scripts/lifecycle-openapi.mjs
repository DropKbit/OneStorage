export function addLifecyclePaths(paths) {
  paths["/api/repos/{namespace}/{repo}/lifecycle"] = {
    put: {
      operationId: "set_project_archive",
      tags: ["Project lifecycle"],
      summary:
        "Archive or restore a project with current ownership and revision checks",
      description:
        "Owner only; write PAT or session required. Archival freezes Git/LFS and collaboration writes and atomically cancels CI leases and pending upstream tasks. Reads, clone/fetch and existing published applications remain available. Restoration does not restart canceled runs. Git delegation tokens are not accepted.",
      parameters: ["namespace", "repo"].map((name) => ({
        name,
        in: "path",
        required: true,
        schema: { type: "string" },
      })),
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["archived", "revision"],
              properties: {
                archived: { type: "boolean" },
                revision: { type: "integer", minimum: 0 },
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        200: {
          description: "State changed atomically",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  archived_at: { type: ["string", "null"] },
                  lifecycle_revision: { type: "integer", minimum: 1 },
                },
              },
            },
          },
        },
        400: { description: "Invalid input" },
        401: { description: "Sign in required" },
        403: {
          description:
            "Current project owner required; read-only/delegated tokens rejected",
        },
        404: { description: "Repository not accessible" },
        409: {
          description:
            "Stale lifecycle revision, ownership changed, initialization or upstream reconciliation pending",
        },
      },
    },
  };
}
