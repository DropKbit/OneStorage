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

  paths["/api/repos/{namespace}/{repo}/transfer"] = {
    post: {
      operationId: "transfer_project",
      tags: ["Project lifecycle"],
      summary: "Transfer or rename a project without changing its UUID",
      description:
        "Source owner and destination namespace owner required. Cross-namespace transfers cancel CI and sync, revoke runner/Git/webhook integrations and disable public applications. Same-namespace renames preserve integrations. Existing aliases are access-checked, reserved and always resolve to the current UUID. Revision conflicts roll back the entire operation.",
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
              required: ["namespace", "revision"],
              properties: {
                namespace: { type: "string" },
                name: { type: "string" },
                revision: { type: "integer", minimum: 0 },
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        200: {
          description:
            "Current project metadata including unchanged id and new lifecycle_revision",
        },
        400: { description: "Invalid input or unchanged address" },
        401: { description: "Authentication required" },
        403: {
          description:
            "Ownership required; read-only/delegated tokens rejected",
        },
        404: { description: "Project inaccessible" },
        409: {
          description:
            "Address conflict, stale revision, ownership changed, initialization or upstream reconciliation pending",
        },
      },
    },
  };
  for (const [path, item] of Object.entries(paths))
    if (path.startsWith("/api/repos/{namespace}/{repo}"))
      for (const method of ["get", "head"])
        if (item[method])
          item[method].responses[307] = {
            description:
              "Historical address: authenticated redirect to the current project. Private destinations are not disclosed without current access.",
          };
}
