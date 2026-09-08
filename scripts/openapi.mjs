import { addReviewPaths } from "./review-openapi.mjs";
import { addAccountPaths } from "./account-openapi.mjs";
import { addPlatformPaths } from "./platform-openapi.mjs";
import { readFile, writeFile } from "node:fs/promises";
const parity = JSON.parse(
  await readFile(new URL("../docs/parity.json", import.meta.url), "utf8"),
);
const queryFields = {
  list_repos: "q,page,limit,cursor",
  get_repo_url_by_id: "",
  get_repo: "",
  get_branch: "branch,ephemeral",
  list_branches: "limit,cursor,ephemeral",
  get_tag: "name,ephemeral",
  list_tags: "limit,cursor,ephemeral",
  get_commit: "sha,ref,ephemeral",
  list_commits: "ref,path,limit,cursor,ephemeral",
  get_commit_diff: "sha,ref,base,path,ephemeral",
  get_branch_diff: "branch,source,base,target,path,ephemeral",
  get_file: "path,ref,ephemeral",
  head_file: "path,ref,ephemeral",
  list_files: "path,ref,recursive,limit,cursor,ephemeral",
  list_files_metadata: "path,ref,recursive,limit,cursor,ephemeral",
  blame: "path,ref,range,ranges,detect_moves,ephemeral",
  notes_read: "sha,notes_ref,ephemeral",
  list_notes_refs: "ephemeral",
  preview_merge:
    "source_ref,source_branch,target_branch,source_is_ephemeral,target_is_ephemeral,include_content,allow_unrelated_histories",
  delete_tag: "ephemeral",
};
const string = { type: "string" },
  boolean = { type: "boolean" };
const object = (properties, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const identity = object(
  { name: string, email: string, timestamp: { type: "integer" } },
  ["name", "email"],
);
const schemas = {
  create_branch: object(
    {
      target_branch: string,
      base_ref: string,
      base_branch: string,
      base_is_ephemeral: boolean,
      ephemeral: boolean,
      expected_target_sha: { type: ["string", "null"] },
    },
    ["target_branch"],
  ),
  delete_branch: object(
    { branch: string, expected_sha: string, ephemeral: boolean },
    ["branch"],
  ),
  create_tag: object(
    { name: string, ref: string, sha: string, ephemeral: boolean },
    ["name"],
  ),
  notes_write: object(
    {
      sha: string,
      note: string,
      notes_ref: string,
      operation: { enum: ["create", "append"] },
      expected_ref_sha: { type: ["string", "null"] },
      ephemeral: boolean,
      author: identity,
    },
    ["sha", "note"],
  ),
  notes_delete: object(
    {
      sha: string,
      notes_ref: string,
      expected_ref_sha: { type: ["string", "null"] },
      ephemeral: boolean,
      author: identity,
    },
    ["sha"],
  ),
  archive: object({
    ref: string,
    include_globs: { type: "array", items: string },
    exclude_globs: { type: "array", items: string },
    max_blob_size: { type: "integer", minimum: 0 },
    archive: object({ prefix: string }),
    ephemeral: boolean,
  }),
  merge_branch: object(
    {
      source_ref: string,
      source_branch: string,
      target_branch: string,
      source_is_ephemeral: boolean,
      target_is_ephemeral: boolean,
      expected_target_sha: string,
      strategy: { enum: ["merge", "ff_only", "ff_prefer"] },
      squash: boolean,
      allow_unrelated_histories: boolean,
      commit_message: string,
      author: identity,
      committer: identity,
    },
    ["target_branch"],
  ),
  update_repo: object({
    description: string,
    visibility: { enum: ["public", "private"] },
    default_branch: string,
  }),
  create_generic_git_credential: object(
    {
      username: string,
      password: { type: "string", minLength: 1, maxLength: 10000 },
    },
    ["password"],
  ),
  update_generic_git_credential: object(
    {
      username: string,
      password: { type: "string", minLength: 1, maxLength: 10000 },
    },
    ["password"],
  ),
};
const paths = {};
for (const feature of parity.features) {
  if (!feature.implementation_path) continue;
  const path = feature.implementation_path,
    method = feature.method.toLowerCase();
  const binary =
      feature.id === "archive" ||
      ["get_file", "head_file"].includes(feature.id),
    stream = [
      "commit_pack",
      "diff_commit",
      "restore_commit",
      "reset_commits",
    ].includes(feature.id);
  const scope =
    feature.id === "list_repos"
      ? "org:read"
      : [
            "create_repo",
            "delete_repo",
            "update_repo",
            "unset_base_repo",
          ].includes(feature.id) || feature.id.includes("credential")
        ? "repo:write"
        : method === "get" ||
            method === "head" ||
            ["archive", "grep"].includes(feature.id)
          ? "git:read"
          : "git:write";
  const parameters = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => ({
    name: m[1],
    in: "path",
    required: true,
    schema: { type: "string" },
    description:
      m[1] === "repo"
        ? "URL-encoded repository name; grouped names occupy one path segment."
        : undefined,
  }));
  const op = {
    operationId: feature.id,
    summary: feature.name,
    description:
      feature.note ||
      "See the OneStorage API contract in the source archive (docs/API.md).",
    parameters,
    security: [{ bearerAuth: [] }],
    "x-required-scope": scope,
    responses: {
      [method === "post" &&
      [
        "create_repo",
        "commit_pack",
        "diff_commit",
        "restore_commit",
        "reset_commits",
        "create_branch",
        "create_tag",
        "notes_write",
        "create_generic_git_credential",
      ].includes(feature.id)
        ? "201"
        : feature.id === "pull_upstream"
          ? "202"
          : "200"]: {
        description: "Operation succeeded",
        ...(method === "head"
          ? {}
          : {
              content: {
                [feature.id === "archive"
                  ? "application/gzip"
                  : binary
                    ? "application/octet-stream"
                    : "application/json"]: {
                  schema: binary
                    ? { type: "string", format: "binary" }
                    : { type: "object", additionalProperties: true },
                },
              },
            }),
      },
      default: {
        description: "Validation, permission, conflict or capacity error",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/Error" },
          },
        },
      },
    },
  };
  if (Object.hasOwn(queryFields, feature.id))
    parameters.push(
      ...queryFields[feature.id]
        .split(",")
        .filter(Boolean)
        .map((name) => ({
          name,
          in: "query",
          required:
            ["get_file", "head_file", "blame"].includes(feature.id) &&
            name === "path",
          schema: [
            "ephemeral",
            "recursive",
            "detect_moves",
            "source_is_ephemeral",
            "target_is_ephemeral",
            "include_content",
            "allow_unrelated_histories",
          ].includes(name)
            ? { type: "boolean" }
            : ["limit", "page"].includes(name)
              ? { type: "integer" }
              : name === "range" || name === "ranges"
                ? { type: "array", items: { type: "string" } }
                : { type: "string" },
        })),
    );
  if (
    method !== "get" &&
    method !== "head" &&
    (method !== "delete" ||
      ["delete_branch", "notes_delete"].includes(feature.id))
  )
    op.requestBody = {
      required: feature.id !== "pull_upstream",
      content: {
        [stream ? "application/x-ndjson" : "application/json"]: {
          schema: stream
            ? {
                type: "string",
                description: ["restore_commit", "reset_commits"].includes(
                  feature.id,
                )
                  ? "Exactly one metadata line with target_branch, base_ref, commit_message and author; no content chunks."
                  : "First line {metadata:...}; subsequent blob_chunk or diff_chunk lines. Explicit EOF required.",
              }
            : schemas[feature.id] || {
                type: "object",
                additionalProperties: true,
              },
        },
      },
    };
  (paths[path] ||= {})[method] = op;
}
addPlatformPaths(paths);
addAccountPaths(paths);
addReviewPaths(paths);
await writeFile(
  new URL("../public/openapi.json", import.meta.url),
  JSON.stringify(
    {
      openapi: "3.1.0",
      info: {
        title: "OneStorage",
        version: "0.7.0",
        description:
          "Container-free Git hosting on Cloudflare Workers. Independent API; not wire-compatible with third-party SDKs.",
      },
      servers: [{ url: "/" }],
      paths,
      components: {
        securitySchemes: {
          sessionCookie: {
            type: "apiKey",
            in: "cookie",
            name: "onestorage_session",
            description:
              "Browser session; same-origin Origin header required for mutations.",
          },
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            description: "PAT or client-signed JWT; scopes are independent.",
          },
        },
        schemas: {
          Error: {
            type: "object",
            required: ["error"],
            properties: {
              error: { type: "string" },
              details: { type: "array", items: { type: "object" } },
            },
          },
        },
      },
    },
    null,
    2,
  ) + "\n",
);
