export function addDeployTokenPaths(paths) {
  const days = { type: "integer", minimum: 1, maximum: 365, default: 90 },
    revision = { type: "integer", minimum: 1 },
    otp = { type: "string", maxLength: 64 },
    scope = {
      type: "string",
      enum: [
        "read_repository",
        "read_package_registry",
        "write_package_registry",
        "delete_package_registry",
      ],
    };
  for (const base of [
    "/api/repos/{namespace}/{repo}/deploy-tokens",
    "/api/workspaces/{slug}/deploy-tokens",
  ]) {
    const workspace = base.includes("/workspaces/");
    for (const [method, suffix, summary, properties, required] of [
      [
        "get",
        "",
        "List deployment credentials without secret or hash; 50 per page.",
      ],
      [
        "post",
        "",
        "Create a scoped deploy token; plaintext returned once.",
        {
          name: { type: "string", minLength: 1, maxLength: 80 },
          username: {
            type: "string",
            pattern: "^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,79}$",
          },
          scopes: {
            type: "array",
            minItems: 1,
            maxItems: 4,
            uniqueItems: true,
            items: scope,
          },
          days,
          otp,
        },
        ["name", "scopes"],
      ],
      [
        "post",
        "/{id}/rotate",
        "Rotate a live or expired token; old secret immediately invalid; revoked tokens cannot be renewed.",
        { revision, days, otp },
        ["revision"],
      ],
      [
        "delete",
        "/{id}",
        "Permanently revoke the exact observed token revision.",
        { revision },
        ["revision"],
      ],
    ]) {
      const path = base + suffix,
        parameters = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => ({
          name: m[1],
          in: "path",
          required: true,
          schema: { type: "string" },
        }));
      if (method === "get")
        parameters.push({
          name: "offset",
          in: "query",
          schema: { type: "integer", minimum: 0, maximum: 100000, default: 0 },
        });
      const operation = {
        tags: ["Deploy tokens"],
        summary,
        description: `${workspace ? "Current workspace owner" : "Current project maintainer"} with browser session or PAT required; mutations require write credentials, session create/rotate also require configured MFA. Maximum 100 active tokens per scope. Secrets authenticate only Git/LFS reads and independently selected package operations, never management APIs. Tokens are independent of issuer membership and disabled status. Cross-space transfer revokes project tokens; workspace tokens follow current project membership. Archive permits management and reads, not package writes. Dates are epoch milliseconds. See https://1s.hk/docs/en/DEPLOY-TOKENS-v26.html.`,
        parameters,
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        responses: {
          [method === "post" && !suffix ? 201 : 200]: {
            description:
              method === "get"
                ? "tokens (metadata only), next_offset, available_scopes and limit"
                : method === "post"
                  ? "Token metadata and one-time plaintext token"
                  : "Revoked token metadata",
          },
          400: { description: "Invalid scopes, lifetime or request schema" },
          401: { description: "User authentication or MFA required" },
          403: { description: "Insufficient manager role, write scope or MFA" },
          404: { description: "Project/workspace unavailable" },
          409: {
            description:
              "Stale revision, revoked token, quota or current manager authorization changed",
          },
        },
      };
      if (properties)
        operation.requestBody = {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties,
                required,
                additionalProperties: false,
              },
            },
          },
        };
      (paths[path] ||= {})[method] = operation;
    }
  }
}
