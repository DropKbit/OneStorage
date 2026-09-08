import type { Env } from "./types";
import { modulesFor, type CloudFiles } from "./cloud-ci";
// Separate workers.dev origin: application HTML/code never executes on the Git authentication origin.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url),
        match = /^\/apps\/([0-9a-f-]{36})\/([a-z][a-z0-9-]{0,39})(\/.*)?$/.exec(
          url.pathname,
        );
      if (
        !match ||
        !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(
          request.method,
        )
      )
        return new Response("Application not found", { status: 404 });
      const row = await env.DB.prepare(
        "SELECT d.id,d.object_key FROM environments e JOIN deployments d ON d.id=e.deployment_id AND d.repo_id=e.repo_id JOIN repositories r ON r.id=e.repo_id WHERE e.repo_id=? AND e.name=? AND e.public=1 AND r.deleted_at IS NULL",
      )
        .bind(match[1], match[2])
        .first<{ id: string; object_key: string }>();
      if (!row)
        return new Response("Application not published", { status: 404 });
      const object = await env.OBJECTS.get(row.object_key);
      if (!object)
        return new Response("Deployment unavailable", { status: 503 });
      const bundle = await object.json<{
        kind: string;
        entry: string;
        files: CloudFiles;
      }>();
      let response: Response;
      const path = match[3] || "/";
      if (bundle.kind === "static") {
        if (!["GET", "HEAD"].includes(request.method))
          return new Response("Method not allowed", { status: 405 });
        const name = decodeURIComponent(path.slice(1)) || bundle.entry;
        const file = Object.hasOwn(bundle.files, name)
          ? bundle.files[name]
          : null;
        if (!file) return new Response("Not found", { status: 404 });
        const type: Record<string, string> = {
          html: "text/html",
          css: "text/css",
          js: "text/javascript",
          json: "application/json",
          txt: "text/plain",
          svg: "image/svg+xml",
          png: "image/png",
          jpg: "image/jpeg",
          wasm: "application/wasm",
        };
        response = new Response(
          request.method === "HEAD"
            ? null
            : file.binary
              ? Uint8Array.from(atob(file.content), (c) => c.charCodeAt(0))
              : file.content,
          {
            headers: {
              "content-type":
                (type[name.split(".").pop()!] || "application/octet-stream") +
                "; charset=utf-8",
            },
          },
        );
      } else {
        if (!env.LOADER)
          return new Response("Execution unavailable", { status: 503 });
        const worker = env.LOADER.get(row.id, () => ({
          compatibilityDate: "2026-09-01",
          mainModule: bundle.entry,
          modules: modulesFor(bundle.files),
          globalOutbound: null,
          limits: { cpuMs: 1000, subRequests: 0 },
        }));
        const headers = new Headers(request.headers);
        headers.delete("cookie");
        headers.delete("authorization");
        url.pathname = path;
        const forwarded = new Request(url, {
          method: request.method,
          headers,
          body: ["GET", "HEAD"].includes(request.method)
            ? undefined
            : request.body,
          signal: AbortSignal.timeout(15000),
        });
        response = await worker.getEntrypoint().fetch(forwarded);
      }
      const out = new Response(response.body, response);
      out.headers.delete("set-cookie");
      out.headers.delete("access-control-allow-credentials");
      out.headers.set("access-control-allow-origin", "*");
      out.headers.set("cache-control", "no-store");
      out.headers.set("x-content-type-options", "nosniff");
      out.headers.set(
        "content-security-policy",
        "sandbox allow-scripts allow-forms; frame-ancestors 'none'",
      );
      out.headers.set("x-onestorage-deployment", row.id);
      return out;
    } catch {
      return new Response("Application execution failed", { status: 502 });
    }
  },
};
