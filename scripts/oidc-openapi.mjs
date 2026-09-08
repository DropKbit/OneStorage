export function addOIDCPaths(paths) {
  const string = { type: "string" };
  const proof = {
    password: { type: "string", maxLength: 128 },
    otp: { type: "string", maxLength: 64 },
  };
  const provider = {
    type: "object",
    additionalProperties: false,
    required: ["name", "issuer", "client_id", "allowed_hosts"],
    properties: {
      protocol: {
        type: "string",
        enum: ["oidc", "github", "gitlab"],
        default: "oidc",
        description:
          "Immutable. GitHub requires github.com and client_secret_post; GitLab supports POST secret or public PKCE.",
      },
      name: { type: "string", maxLength: 80 },
      issuer: { type: "string", format: "uri" },
      client_id: { type: "string", maxLength: 512 },
      client_secret: { type: "string", maxLength: 4096, writeOnly: true },
      auth_method: {
        type: "string",
        enum: ["client_secret_basic", "client_secret_post", "none"],
        default: "client_secret_basic",
      },
      allowed_hosts: {
        type: "array",
        minItems: 1,
        maxItems: 10,
        items: string,
      },
      email_domains: { type: "array", maxItems: 20, items: string },
      enabled: { type: "boolean", default: false },
      registration: { type: "boolean", default: false },
      revision: { type: "integer", minimum: 1 },
    },
  };
  const routes = [
    [
      "get",
      "/api/auth/oidc/providers",
      "Enabled public identity-provider names and IDs.",
      null,
      "public",
    ],
    [
      "post",
      "/api/auth/oidc/{id}/start",
      "Matching Origin required. Link requires browser session and local proof; reauth is bound to the current account. Returns authorization URL and sets ten-minute HttpOnly flow cookie.",
      {
        type: "object",
        properties: {
          ...proof,
          mode: {
            type: "string",
            enum: ["login", "link", "reauth"],
            default: "login",
          },
        },
      },
      "public",
    ],
    [
      "get",
      "/api/auth/oidc/callback",
      "Single-use state and browser-cookie binding. Verifies code and PKCE, then OIDC ID Token or OAuth stable user ID from the pinned user API; redirects to account, home, local MFA/registration or generic failure.",
      null,
      "public",
    ],
    [
      "get",
      "/api/auth/oidc/pending",
      "Requires the pending flow cookie. Returns stage and provider name.",
      null,
      "public",
    ],
    [
      "post",
      "/api/auth/oidc/complete",
      "Matching Origin and pending flow cookie required. Complete local MFA or choose username for an ordinary passwordless account.",
      {
        type: "object",
        properties: {
          username: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,47}$" },
          otp: proof.otp,
        },
      },
      "public",
    ],
    [
      "get",
      "/api/account/identities",
      "Browser session required. List own linked and available identities and local-password availability.",
      null,
      "session",
    ],
    [
      "post",
      "/api/account/identities/{id}/unlink",
      "Local proof and browser session required. Keep one enabled login method. Revokes this provider's sessions and derived PATs for the account.",
      { type: "object", properties: proof },
      "session",
    ],
    [
      "get",
      "/api/admin/identity-providers",
      "Administrator only. Lists configuration without client secrets and reports callback URL.",
      null,
      "admin",
    ],
    [
      "post",
      "/api/admin/identity-providers",
      "Administrator with write scope. Validates discovery and approved HTTPS hosts before inserting. Maximum twenty providers.",
      provider,
      "admin",
    ],
    [
      "put",
      "/api/admin/identity-providers/{id}",
      "Administrator with write scope and current revision. Issuer/client ID immutable; omitted secret retained. Revokes provider credentials and pending flows.",
      { ...provider, required: [...provider.required, "revision"] },
      "admin",
    ],
    [
      "delete",
      "/api/admin/identity-providers/{id}",
      "Administrator with write scope. Refuses deletion while linked accounts exist.",
      null,
      "admin",
    ],
  ];
  for (const [method, path, description, schema, kind] of routes) {
    const op = {
      operationId: method + "_" + path.replace(/[^a-z0-9]+/g, "_"),
      summary: description.split(". ")[0],
      description:
        description +
        " See docs/OIDC-v23.md and docs/OAUTH-v33.md. Existing /auth/oidc route names also serve GitHub/GitLab OAuth flows.",
      security:
        kind === "public"
          ? []
          : kind === "session"
            ? [{ sessionCookie: [] }]
            : [{ sessionCookie: [] }, { bearerAuth: [] }],
      responses: {
        200: { description: "Success" },
        400: { description: "Invalid configuration or input" },
        401: { description: "Invalid or expired authentication" },
        403: { description: "Origin, permissions or local proof rejected" },
        409: {
          description:
            "Identity, revision, current authorization or login method changed",
        },
        429: { description: "Verification attempts exceeded" },
      },
    };
    if (path.includes("{id}"))
      op.parameters = [
        { name: "id", in: "path", required: true, schema: string },
      ];
    if (path.endsWith("/callback")) {
      op.parameters = ["state", "code", "iss", "error"].map((name) => ({
        name,
        in: "query",
        schema: string,
      }));
      op.responses["303"] = {
        description: "Browser redirect; errors do not expose provider details",
      };
    }
    if (schema)
      op.requestBody = {
        required: true,
        content: { "application/json": { schema } },
      };
    if (
      method === "post" &&
      ["/api/admin/identity-providers", "/api/auth/oidc/complete"].includes(
        path,
      )
    )
      op.responses["201"] = { description: "Created" };
    (paths[path] ||= {})[method] = op;
  }
}
