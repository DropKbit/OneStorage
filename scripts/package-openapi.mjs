export function addPackagePaths(paths) {
  const base = "/api/repos/{namespace}/{repo}/packages";
  const routes = [
    [
      "get",
      "",
      "List active package versions (50 per page), next_offset, usage and limits. Query offset defaults to zero.",
    ],
    [
      "get",
      "/versions/{id}",
      "Read immutable package version metadata, file digests and npm tags.",
    ],
    [
      "delete",
      "/versions/{id}",
      "Maintainer: retire a version and all files. Names/versions cannot be reused; asynchronous R2 cleanup.",
    ],
    [
      "put",
      "/generic/{name}/{version}/{file}",
      "Developer: stream an immutable 1 B..64 MiB file. Content-Length and X-Package-SHA256 required.",
    ],
    [
      "get",
      "/generic/{name}/{version}/{file}",
      "Download generic file. Single Range, ETag, SHA-256; visibility follows current repository.",
    ],
    [
      "head",
      "/generic/{name}/{version}/{file}",
      "Generic file length and digest without body.",
    ],
    [
      "put",
      "/npm/{name}",
      "Developer: native npm publish JSON; one version and one gzip tarball. Encoded scoped name; 16 MiB tarball / 24 MiB JSON.",
    ],
    [
      "get",
      "/npm/{name}",
      "npm packument with versions, rewritten tarball URLs, SRI, dist-tags and revision.",
    ],
    [
      "get",
      "/npm/{name}/-/{file}",
      "Download npm tarball; supports Range and ETag.",
    ],
    [
      "head",
      "/npm/{name}/-/{file}",
      "npm tarball length and digest without body.",
    ],
    [
      "get",
      "/npm/-/ping",
      "npm registry connectivity check with project access.",
    ],
    [
      "get",
      "/npm/-/whoami",
      "Current authenticated package registry username.",
    ],
    ["get", "/npm/-/package/{name}/dist-tags", "npm tag-to-version mapping."],
    [
      "put",
      "/npm/-/package/{name}/dist-tags/{tag}",
      "Developer: assign tag to a live version; request body is a JSON version string.",
    ],
    [
      "delete",
      "/npm/-/package/{name}/dist-tags/{tag}",
      "Developer: remove npm distribution tag.",
    ],
    [
      "put",
      "/npm/{name}/-rev/{revision}",
      "Maintainer: native npm unpublish partial document. Removes versions only, exact current _rev required.",
    ],
    [
      "delete",
      "/npm/{name}/-rev/{revision}",
      "Maintainer: unpublish whole npm package, exact current _rev required.",
    ],
    [
      "delete",
      "/npm/{name}/-/{file}/-rev/{revision}",
      "Maintainer: libnpmpublish cleanup acknowledgment for a tarball already retired by metadata update.",
    ],
  ];
  for (const [method, suffix, summary] of routes) {
    const path = base + suffix,
      parameters = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => ({
        name: m[1],
        in: "path",
        required: true,
        schema: { type: "string" },
      }));
    if (!suffix)
      parameters.push({
        name: "offset",
        in: "query",
        required: false,
        schema: { type: "integer", minimum: 0, maximum: 100000 },
      });
    const operation = {
      tags: ["Packages"],
      summary,
      description:
        "Cloudflare Workers/R2/D1 package registry. Browser session, PAT or scoped project/workspace deploy token; delegated Git JWTs rejected. User credentials require current membership; deploy tokens require the exact current project/workspace scope. Public reads may be anonymous. Archived projects are read-only. Deploy scopes: read_package_registry for reads; write_package_registry for publish and dist-tag changes (including tag deletion); delete_package_registry for version retirement and npm unpublish. Native npm may also need read scope for metadata requests.",
      parameters,
      security: [
        { deployToken: [] },
        { bearerAuth: [] },
        { sessionCookie: [] },
        ...(["get", "head"].includes(method) && !suffix.endsWith("whoami")
          ? [{}]
          : []),
      ],
      responses: {
        200: { description: "Success" },
        400: { description: "Invalid package, checksum or protocol input" },
        401: { description: "Authentication required or invalid credential" },
        403: { description: "Insufficient current role or token scope" },
        404: { description: "Not found or private resource unavailable" },
        409: {
          description:
            "Version exists, revision/authorization changed, or quota exceeded",
        },
        413: { description: "Package limit exceeded" },
      },
    };
    if (method === "put") {
      const generic = suffix.startsWith("/generic/");
      operation.requestBody = {
        required: true,
        content: {
          [generic ? "application/octet-stream" : "application/json"]: {
            schema: generic
              ? { type: "string", format: "binary" }
              : suffix.includes("dist-tags")
                ? { type: "string" }
                : { type: "object", additionalProperties: true },
          },
        },
      };
      if (generic)
        parameters.push(
          {
            name: "Content-Length",
            in: "header",
            required: true,
            schema: { type: "integer", minimum: 1, maximum: 67108864 },
          },
          {
            name: "X-Package-SHA256",
            in: "header",
            required: true,
            schema: { type: "string", pattern: "^[a-f0-9]{64}$" },
          },
        );
      if (generic || suffix === "/npm/{name}")
        operation.responses[201] = {
          description: "Published immutable package",
        };
    }
    if (["get", "head"].includes(method) && suffix.endsWith("/{file}")) {
      parameters.push(
        {
          name: "Range",
          in: "header",
          required: false,
          schema: { type: "string" },
        },
        {
          name: "If-None-Match",
          in: "header",
          required: false,
          schema: { type: "string" },
        },
      );
      operation.responses[206] = { description: "Partial bytes" };
      operation.responses[304] = { description: "Matching ETag" };
      operation.responses[416] = { description: "Unsatisfiable range" };
    }
    paths[path] ||= {};
    paths[path][method] = operation;
  }
}
