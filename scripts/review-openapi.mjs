const base = "/api/repos/{namespace}/{repo}",
  string = { type: "string" },
  sha = { type: "string", pattern: "^[a-f0-9]{40}$" },
  body = { type: "string", maxLength: 20000 };
const object = (properties, required = []) => ({
  type: "object",
  properties,
  required,
});
export function addReviewPaths(paths) {
  const entries = [
    [
      "get",
      base + "/merge-sources",
      "list_merge_sources",
      null,
      "List up to 100 writable repositories in the same fork family. Requires sign-in and target read access.",
    ],
    [
      "get",
      base + "/merges",
      "list_merge_requests",
      null,
      "List the latest 100 merge requests visible in the target repository.",
    ],
    [
      "post",
      base + "/merges",
      "create_merge_request",
      object(
        {
          title: { type: "string", minLength: 1, maxLength: 240 },
          body,
          source: string,
          target: string,
          source_repo: {
            type: "string",
            description:
              "Source repository ID or namespace/name; omit for same-repository branches.",
          },
        },
        ["title", "source", "target"],
      ),
      "Publish a fixed source branch snapshot into the target. Requires source write and target read permission. Cross-fork requests must share fork ancestry. Source history and reachable LFS objects are disclosed to target readers. Other source branches remain private.",
    ],
    [
      "post",
      base + "/merges/{id}/pipeline",
      "run_merge_pipeline",
      null,
      "Target maintainer explicitly runs the target configuration against the reviewed source SHA. Source pipeline settings are not copied.",
    ],
    [
      "get",
      base + "/merges/{id}/discussions",
      "list_merge_discussions",
      null,
      "Page discussions by numeric after cursor; 100 per page. Unresolved review gates consider all discussions regardless of pagination.",
    ],
    [
      "post",
      base + "/merges/{id}/discussions",
      "create_merge_discussion",
      object(
        {
          source_sha: sha,
          target_sha: sha,
          body,
          path: string,
          side: { enum: ["old", "new"] },
          line: { type: "integer", minimum: 1 },
        },
        ["source_sha", "target_sha", "body"],
      ),
      "Create a general or file-line discussion bound to both reviewed SHAs. Path, side and line must be supplied together.",
    ],
    [
      "get",
      base + "/merges/{id}/discussions/{discussion}",
      "read_merge_discussion",
      null,
      "Read discussion and up to 100 comments; numeric after cursor retrieves subsequent comments.",
    ],
    [
      "patch",
      base + "/merges/{id}/discussions/{discussion}",
      "resolve_merge_discussion",
      object({ resolved: { type: "boolean" } }, ["resolved"]),
      "Resolve or reopen a thread. Requires discussion author, merge author or target developer. Serialized with merge publication.",
    ],
    [
      "post",
      base + "/merges/{id}/discussions/{discussion}/comments",
      "reply_merge_discussion",
      object({ body }, ["body"]),
      "Reply to an open merge request discussion.",
    ],
  ];
  for (const [method, path, id, schema, description] of entries) {
    const parameters = [...path.matchAll(/\{(\w+)\}/g)].map(([, name]) => ({
      name,
      in: "path",
      required: true,
      schema: string,
    }));
    if (id === "list_merge_discussions" || id === "read_merge_discussion")
      parameters.push({
        name: "after",
        in: "query",
        schema: { type: "integer", minimum: 0 },
      });
    (paths[path] ||= {})[method] = {
      operationId: id,
      summary: id.replaceAll("_", " "),
      description: description + " See docs/REVIEWS-v07.md.",
      tags: ["Merge requests"],
      parameters,
      security:
        method === "get" && id !== "list_merge_sources"
          ? [{}, { sessionCookie: [] }, { bearerAuth: [] }]
          : [{ sessionCookie: [] }, { bearerAuth: [] }],
      ...(schema
        ? {
            requestBody: {
              required: true,
              content: { "application/json": { schema } },
            },
          }
        : {}),
      responses: {
        200: { description: "Success" },
        201: { description: "Created" },
        400: { description: "Invalid input" },
        401: { description: "Sign in required" },
        403: { description: "Insufficient role or read-only token" },
        404: { description: "Not found or inaccessible" },
        409: {
          description: "Review version, branch or discussion state conflict",
        },
        429: { description: "Pipeline capacity exceeded" },
      },
    };
  }
  const update = paths[base + "/merges/{id}"].patch;
  update.requestBody = {
    required: true,
    content: {
      "application/json": {
        schema: object({
          state: { enum: ["open", "closed"] },
          refresh: { type: "boolean" },
          title: string,
          body,
          revision: { type: "integer", minimum: 0 },
        }),
      },
    },
  };
  paths[base + "/merges/{id}"].get.parameters.push({
    name: "discussions_after",
    in: "query",
    schema: { type: "integer", minimum: 0 },
  });
  const merge = paths[base + "/merges/{id}/merge"].post;
  merge.requestBody = {
    content: {
      "application/json": {
        schema: object({
          strategy: { enum: ["ff_prefer", "ff_only", "merge"] },
          squash: { type: "boolean" },
          revision: {
            type: "integer",
            minimum: 0,
            description:
              "Reject if the MR description or snapshots changed since this revision was displayed.",
          },
        }),
      },
    },
  };
  const protection = paths[base + "/protections"].put;
  protection.requestBody = {
    required: true,
    content: {
      "application/json": {
        schema: object(
          {
            branch: string,
            require_mr: { type: "boolean" },
            approvals: { type: "integer", minimum: 0, maximum: 10 },
            require_ci: { type: "boolean" },
            require_codeowners: {
              type: "boolean",
              description:
                "Enforce target-snapshot CODEOWNERS rules. Missing or invalid rules fail closed.",
            },
            require_resolved: {
              type: "boolean",
              description:
                "Require all unresolved discussions by current target developers to be resolved, including older versions.",
            },
          },
          ["branch"],
        ),
      },
    },
  };
}
