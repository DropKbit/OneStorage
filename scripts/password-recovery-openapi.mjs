export function addPasswordRecoveryPaths(paths) {
  const str = { type: "string" },
    password = { type: "string", minLength: 12, maxLength: 128 };
  const proof = {
    type: "object",
    required: ["password", "version"],
    properties: {
      password: { ...str, maxLength: 128 },
      otp: { ...str, maxLength: 64 },
      version: { type: ["string", "null"], format: "uuid" },
    },
  };
  const routes = [
    [
      "get",
      "/api/account/password-recovery",
      "password_recovery_status",
      null,
      "Read own saved recovery-key metadata and the latest 20 recovery audit events. Never returns the key or hash.",
    ],
    [
      "put",
      "/api/account/password-recovery",
      "issue_password_recovery",
      proof,
      "Current browser session, local password and fresh MFA factor required. Supply the current version (null initially). Replaces the saved key and returns the new 256-bit secret ONCE, with a one-year expiry. Never log this response.",
    ],
    [
      "delete",
      "/api/account/password-recovery",
      "revoke_password_recovery",
      proof,
      "Verify password and fresh MFA factor, then atomically revoke the expected key version and audit the operation.",
    ],
    [
      "post",
      "/api/recover-password",
      "recover_password",
      {
        type: "object",
        required: ["username", "key", "new_password"],
        properties: {
          username: { ...str, maxLength: 48 },
          key: { ...str, maxLength: 100 },
          new_password: password,
          otp: { ...str, maxLength: 64 },
        },
      },
      "Anonymous saved-key password recovery. Requires a still-enabled local-password account, an unexpired unused key and a fresh MFA factor when enabled. Preserves MFA and signing identities; revokes all sessions, PATs, JWT delegation keys and pending OIDC flows. No automatic sign-in. Invalid, expired, revoked and unknown keys share an error. Ten attempts per IP and per username per ten minutes.",
    ],
  ];
  for (const [method, path, id, schema, description] of routes)
    (paths[path] ||= {})[method] = {
      operationId: id,
      summary: id.replaceAll("_", " "),
      tags: ["Account"],
      description:
        description +
        " See docs/PASSWORD-RECOVERY-v30.md. Cookie mutations require same-origin Origin.",
      security: id === "recover_password" ? [] : [{ sessionCookie: [] }],
      ...(schema
        ? {
            requestBody: {
              required: true,
              content: { "application/json": { schema } },
            },
          }
        : {}),
      responses: {
        200: {
          description: "Success; recovery requires subsequent normal sign-in",
        },
        400: { description: "Invalid input" },
        401: { description: "Invalid recovery credentials or session" },
        403: {
          description:
            "Browser session, current proof or same-origin request required",
        },
        409: {
          description:
            "Concurrent security/key change, or local password required",
        },
        429: { description: "Verification rate limit" },
      },
    };
}
