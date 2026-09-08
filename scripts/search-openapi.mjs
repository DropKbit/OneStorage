export function addSearchPaths(paths) {
  const string = { type: "string" };
  paths["/api/search"] = {
    get: {
      operationId: "searchCollaboration",
      tags: ["Search"],
      summary:
        "Search accessible projects, issues, merge requests and current Wiki pages",
      description:
        "Literal title/body substring search; ASCII case-insensitive, other Unicode exact. Current D1 permission checks and live credential validation. Anonymous public search, session or PAT supported; delegated JWT and deploy tokens denied. No implicit administrator access. No Git code/comments/Wiki history. Ordered by type, immutable project ID and string item ID; cursor pagination is a live view, not an export snapshot. No fixed project cap. State filters omit projects/Wiki. No index migration or per-project Git RPC; SQL scans matching accessible documents, so latency depends on corpus size.",
      security: [{}, { sessionCookie: [] }, { bearerAuth: [] }],
      parameters: [
        [
          "q",
          { ...string, minLength: 1, maxLength: 128 },
          "Required single-line literal text, trimmed",
          true,
        ],
        [
          "type",
          {
            ...string,
            enum: ["all", "project", "issue", "merge", "wiki"],
            default: "all",
          },
          "Content type",
        ],
        [
          "namespace",
          { ...string, maxLength: 64 },
          "Current space slug, empty means all accessible spaces",
        ],
        [
          "state",
          {
            ...string,
            enum: ["all", "open", "closed", "merged"],
            default: "all",
          },
          "Issue/merge state",
        ],
        [
          "archived",
          {
            ...string,
            enum: ["include", "exclude", "only"],
            default: "include",
          },
          "Archive filter",
        ],
        [
          "limit",
          { type: "integer", minimum: 1, maximum: 50, default: 30 },
          "Page size",
        ],
        [
          "cursor",
          { ...string, maxLength: 4096 },
          "Opaque cursor bound to filters and principal; retain filters on next request",
        ],
      ].map(([name, schema, description, required]) => ({
        name,
        in: "query",
        schema,
        description,
        required: !!required,
      })),
      responses: {
        200: {
          description: "Live authorized results; private no-store response",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["results", "has_more", "next_cursor"],
                properties: {
                  results: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        type: {
                          ...string,
                          enum: ["project", "issue", "merge", "wiki"],
                        },
                        repo_id: string,
                        id: {
                          ...string,
                          description:
                            "Empty for project, decimal string for Issue/MR, slug for Wiki",
                        },
                        namespace: string,
                        name: string,
                        title: string,
                        excerpt: { ...string, maxLength: 320 },
                        state: { type: ["string", "null"] },
                        archived_at: { type: ["string", "null"] },
                        date: string,
                      },
                    },
                  },
                  has_more: { type: "boolean" },
                  next_cursor: { type: ["string", "null"] },
                },
              },
            },
          },
        },
        400: { description: "Invalid input or mismatched cursor" },
        401: { description: "Invalid, expired or revoked credential" },
        403: { description: "Unsupported credential type" },
      },
    },
  };
}
