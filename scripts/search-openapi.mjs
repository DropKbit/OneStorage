export function addSearchPaths(paths) {
  const string = { type: "string" };
  paths["/api/search"] = {
    get: {
      operationId: "searchCollaboration",
      tags: ["Search"],
      summary:
        "Search accessible collaboration content or indexed default-branch code",
      description:
        "For type=code, mode=text (default) uses literal matching; mode=semantic uses Workers AI bge-m3 and Vectorize, while mode=hybrid merges both and explicitly falls back to text if AI is disabled, unavailable or over budget. Semantic modes return ranked top results without cursors, up to 128 visible projects; narrow namespace when scope_limited. Vectors are resolved through live ACLs and current indexed snapshots. AI queries are limited to 20 per minute per user (anonymous requests share a bucket), plus a configurable daily character budget. Semantic-only requests may return 429 or 503. Literal substring search; ASCII case-insensitive, other Unicode exact. Live D1 permissions and credentials; anonymous public search, session/PAT supported; delegated JWT/deploy tokens denied. No implicit administrator access. type=all includes project/issue/merge/wiki only, without comments or Wiki history. type=code uses ordinary D1 trigram postings and an asynchronously published immutable default-branch snapshot (migrations 0026/0027; unchanged blobs reuse repository-scoped content postings); results include SHA, line, time and stale flag plus visible-project coverage. No full body returned, no per-project Git RPC or fixed project cap. Code needs 3 Unicode codepoints, no regex/history/other branches. Cursor pagination is a live view, not an export snapshot. Collaboration content still uses SQL substring scans.",
      security: [{}, { sessionCookie: [] }, { bearerAuth: [] }],
      parameters: [
        [
          "mode",
          { enum: ["text", "semantic", "hybrid"], default: "text" },
          "Code search mode; semantic/hybrid do not accept cursors",
        ],
        [
          "q",
          { ...string, minLength: 1, maxLength: 128 },
          "Required single-line literal text, trimmed; code requires at least 3 Unicode codepoints",
          true,
        ],
        [
          "type",
          {
            ...string,
            enum: ["all", "project", "issue", "merge", "wiki", "code"],
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
          "path",
          { ...string, maxLength: 1000 },
          "Code-only literal path substring",
        ],
        [
          "extension",
          { ...string, maxLength: 32, pattern: "^[a-zA-Z0-9_-]*$" },
          "Code-only extension without dot",
        ],
        [
          "state",
          {
            ...string,
            enum: ["all", "open", "closed", "merged"],
            default: "all",
          },
          "Issue/merge state; ignored by code search",
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
          { ...string, maxLength: 8192 },
          "Opaque cursor bound to filters and principal; retain filters. Code max8192, collaboration max4096",
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
                          enum: ["project", "issue", "merge", "wiki", "code"],
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
                        excerpt: {
                          ...string,
                          description:
                            "Collaboration <=320 characters; code <=query length +300 Unicode codepoints",
                        },
                        state: { type: ["string", "null"] },
                        archived_at: { type: ["string", "null"] },
                        date: string,
                        path: string,
                        line: { type: "integer", minimum: 1 },
                        indexed_sha: string,
                        blob_sha: string,
                        indexed_branch: string,
                        indexed_at: {
                          type: "integer",
                          description: "Unix milliseconds",
                        },
                        stale: { type: "boolean" },
                        status: string,
                      },
                    },
                  },
                  coverage: {
                    type: "object",
                    description:
                      "Code-only counts across visible projects; path/extension do not narrow project coverage",
                    properties: Object.fromEntries(
                      [
                        "projects",
                        "indexed_projects",
                        "pending_projects",
                        "partial_projects",
                        "failed_projects",
                      ].map((k) => [k, { type: "integer" }]),
                    ),
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
  const parameters = ["namespace", "repo"].map((name) => ({
    name,
    in: "path",
    required: true,
    schema: string,
  }));
  paths["/api/repos/{namespace}/{repo}/code-index"] = {
    get: {
      operationId: "getCodeIndex",
      tags: ["Search"],
      summary: "Read current code-index status and published coverage",
      parameters,
      security: [{}, { sessionCookie: [] }, { bearerAuth: [] }],
      responses: {
        200: {
          description:
            "Status, indexed_sha/branch/time, build counters, published coverage, stale and safe retry error. Coverage index_version=2 includes reused_files, created_contents and written_postings for the published build. Logical postings still count each file; written_postings counts only newly inserted content grams. Missing state returns queued.",
        },
        403: { description: "Read permission required" },
        404: { description: "Project not visible" },
      },
    },
  };
  paths["/api/repos/{namespace}/{repo}/code-index/rebuild"] = {
    post: {
      operationId: "rebuildCodeIndex",
      tags: ["Search"],
      summary: "Schedule a default-branch code-index rebuild",
      description:
        "Current maintainer/owner and live session or write PAT required. Archived projects allowed. Durable D1 intent with DO/cron recovery; overlapping pending requests coalesce. No Git modification.",
      parameters,
      security: [{ sessionCookie: [] }, { bearerAuth: [] }],
      responses: {
        202: { description: "Rebuild scheduled" },
        403: {
          description:
            "Current maintain authority and write credential required",
        },
        404: { description: "Project not visible" },
      },
    },
  };
  paths["/api/admin/semantic"] = {
    get: {
      operationId: "getSemanticSettings",
      tags: ["Admin"],
      summary:
        "Read semantic settings, today's usage and up to 200 project index states",
      security: [{ sessionCookie: [] }, { bearerAuth: [] }],
      responses: {
        200: {
          description: "Administrator-only metadata; no private code contents",
        },
      },
    },
    patch: {
      operationId: "setSemanticSettings",
      tags: ["Admin"],
      summary:
        "Pause/resume semantic search and set a shared daily character budget",
      security: [{ sessionCookie: [] }, { bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["enabled", "daily_chars"],
              properties: {
                enabled: { type: "boolean" },
                daily_chars: {
                  type: "integer",
                  minimum: 1000,
                  maximum: 50000000,
                },
              },
            },
          },
        },
      },
      responses: {
        200: {
          description:
            "Updated; current administrator write credentials required",
        },
      },
    },
  };
  paths["/api/admin/semantic/rebuild"] = {
    post: {
      operationId: "rebuildSemanticIndex",
      tags: ["Admin"],
      summary:
        "Regenerate a project's default-branch embeddings in the background",
      security: [{ sessionCookie: [] }, { bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["repo_id"],
              properties: { repo_id: { type: "string", maxLength: 128 } },
            },
          },
        },
      },
      responses: {
        202: {
          description: "Scheduled; regeneration consumes the daily budget",
        },
      },
    },
  };
}
