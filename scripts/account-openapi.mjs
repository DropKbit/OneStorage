const object = (properties, required = []) => ({
    type: "object",
    properties,
    required,
  }),
  str = (maxLength = 128) => ({ type: "string", maxLength });
const proof = object({ password: str(), otp: str(64) }, ["password", "otp"]);
export function addAccountPaths(paths) {
  const routes = [
    [
      "get",
      "/api/account/security",
      "account_security",
      null,
      "Read authenticator status and remaining recovery-code count.",
    ],
    [
      "post",
      "/api/account/mfa/setup",
      "setup_authenticator",
      object({ password: str() }, ["password"]),
      "Verify current password and return a ten-minute enrollment secret and otpauth URI. Never log the response.",
    ],
    [
      "post",
      "/api/account/mfa/enable",
      "enable_authenticator",
      object(
        {
          version: { type: "string", format: "uuid" },
          otp: { type: "string", pattern: "^[0-9]{6}$" },
        },
        ["version", "otp"],
      ),
      "Confirm possession. Returns ten recovery codes once and revokes other browser sessions.",
    ],
    [
      "post",
      "/api/account/mfa/recovery",
      "rotate_recovery_codes",
      proof,
      "Verify password and fresh factor, invalidate old recovery codes, return ten new codes once.",
    ],
    [
      "post",
      "/api/account/mfa/disable",
      "disable_authenticator",
      proof,
      "Verify password and fresh factor, disable MFA and revoke other browser sessions.",
    ],
    [
      "get",
      "/api/account/sessions",
      "list_sessions",
      null,
      "List up to 100 active browser sessions, without credential hashes.",
    ],
    [
      "delete",
      "/api/account/sessions/{id}",
      "revoke_session",
      null,
      "Revoke one session owned by the current user.",
    ],
    [
      "get",
      "/api/profile",
      "read_own_profile",
      null,
      "Read editable public profile fields.",
    ],
    [
      "put",
      "/api/profile",
      "update_profile",
      object({
        display_name: str(80),
        bio: str(2000),
        location: str(100),
        website: str(1000),
      }),
      "Replace public profile fields. Website must use HTTP(S), without embedded credentials.",
    ],
    [
      "get",
      "/api/profiles/{username}",
      "public_profile",
      null,
      "Read public profile and up to 50 repositories/activity entries visible to the viewer. Disabled users return 404.",
    ],
    [
      "get",
      "/api/repos/{namespace}/{repo}/preview",
      "preview_image",
      null,
      "Read a Git blob as PNG, JPEG, GIF or WebP using byte signatures. Requires repository read access; private no-store, 5 MiB maximum.",
    ],
  ];
  for (const [method, path, id, schema, description] of routes) {
    const publicProfile = id === "public_profile",
      image = id === "preview_image";
    const parameters = [...path.matchAll(/\{(\w+)\}/g)].map(([, name]) => ({
      name,
      in: "path",
      required: true,
      schema: str(),
    }));
    if (publicProfile)
      parameters.push({
        name: "before",
        in: "query",
        schema: { type: "integer", minimum: 1 },
      });
    if (image)
      for (const name of ["ref", "path"])
        parameters.push({
          name,
          in: "query",
          required: name === "path",
          schema: str(1000),
        });
    (paths[path] ||= {})[method] = {
      operationId: id,
      summary: id.replaceAll("_", " "),
      description:
        description +
        " See docs/ACCOUNT-v06.md. Cookie-authenticated mutations require a same-origin Origin header.",
      tags: [image ? "Repository" : "Account"],
      parameters,
      security: publicProfile
        ? [{}, { sessionCookie: [] }]
        : image
          ? [{ sessionCookie: [] }, { bearerAuth: [] }]
          : [{ sessionCookie: [] }],
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
        400: { description: "Invalid input" },
        401: { description: "Sign in required" },
        403: { description: "Session, role or verification required" },
        404: { description: "Not found" },
        409: { description: "Concurrent account change or expired setup" },
        429: { description: "Verification rate limit" },
      },
    };
  }
}
