import * as esbuild from "esbuild-wasm/lib/browser.js";
import wasmModule from "esbuild-wasm/esbuild.wasm";
import { R2PublicPackageCache } from "./build-package-cache";
import { BuildFileSystem } from "./build-packages";
import { buildRequest, BUILD_LIMIT } from "./ci-build-schema";

let initialization: Promise<void> | undefined;
let busy = false;
async function body(request: Request, limit: number) {
  const reader = request.body?.getReader();
  if (!reader) throw Error("Missing build request");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw Error("Build request exceeds limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
// Private service binding only. Dedicated public package cache; no project data or credentials.
export default {
  async fetch(
    request: Request,
    env: { NPM_CACHE?: R2Bucket },
  ): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/build")
      return new Response("Not found", { status: 404 });
    if (busy)
      return new Response("Compiler busy; retry this job", { status: 503 });
    busy = true;
    const controller = new AbortController();
    let context: esbuild.BuildContext | undefined;
    try {
      const { step, files, packages } = buildRequest.parse(
        await body(request, BUILD_LIMIT.request),
      );
      if (
        Object.keys(files).length > BUILD_LIMIT.files ||
        Object.values(files).reduce(
          (n, v) => n + new TextEncoder().encode(v).length,
          0,
        ) > BUILD_LIMIT.source
      )
        throw Error("Cloud build source limit exceeded");
      if (!Object.hasOwn(files, step.entry))
        throw Error("Build entry missing from source selection");
      const fs = new BuildFileSystem(
        files,
        step.platform,
        undefined,
        controller.signal,
        packages,
        env.NPM_CACHE ? new R2PublicPackageCache(env.NPM_CACHE) : undefined,
      );
      initialization ??= esbuild
        .initialize({ wasmModule, worker: false })
        .catch((e) => {
          initialization = undefined;
          throw e;
        });
      await initialization;
      context = await esbuild.context({
        entryPoints: [step.entry],
        outfile: "/" + step.outfile,
        bundle: true,
        write: false,
        format: "esm",
        platform: "browser",
        target: "es2022",
        minify: step.minify,
        sourcemap: step.sourcemap ? "inline" : false,
        jsx: step.jsx,
        jsxImportSource: step.jsx_import_source,
        logLevel: "silent",
        metafile: true,
        plugins: [
          {
            name: "locked-npm",
            setup(build) {
              build.onResolve({ filter: /.*/ }, async (args) => ({
                path: await fs.resolve(
                  args.path,
                  args.importer,
                  args.kind === "require-call" ||
                    args.kind === "require-resolve",
                ),
                namespace: "source",
              }));
              build.onLoad({ filter: /.*/, namespace: "source" }, (args) => {
                const ext = args.path.split(".").pop()!;
                const loader: esbuild.Loader =
                  ext === "ts" || ext === "mts" || ext === "cts"
                    ? "ts"
                    : ["tsx", "jsx", "json", "css"].includes(ext)
                      ? (ext as esbuild.Loader)
                      : "js";
                return {
                  contents: fs.files[args.path],
                  loader,
                  resolveDir: "/",
                };
              });
            },
          },
        ],
      });
      const activeContext = context;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        context.rebuild(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            void activeContext.cancel();
            reject(Error("Cloud compilation timeout"));
          }, 60000);
        }),
      ]).finally(() => clearTimeout(timer));
      if (result.warnings.length)
        throw Error(
          "Compiler warning: " +
            result.warnings
              .map((w) => w.text)
              .join("; ")
              .slice(0, 1500),
        );
      if (
        Object.values(result.metafile!.outputs).some((o) =>
          o.imports.some((i) => i.external),
        )
      )
        throw Error("Unresolved external import in build output");
      const artifacts: Record<string, string> = Object.create(null);
      let total = 0;
      for (const file of result.outputFiles || []) {
        total += file.contents.length;
        if (file.contents.length > 1024 * 1024 || total > BUILD_LIMIT.output)
          throw Error("Cloud build output limit exceeded");
        artifacts[file.path.replace(/^\//, "")] = file.text;
      }
      if (!Object.keys(artifacts).length || Object.keys(artifacts).length > 10)
        throw Error("Invalid compiler output count");
      return Response.json({
        artifacts,
        packages: fs.count,
        npm_cache: fs.cacheStats,
        compiler: "esbuild-wasm/0.28.2",
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Compilation failed";
      return Response.json({ error: message.slice(0, 2000) }, { status: 422 });
    } finally {
      controller.abort();
      try {
        await context?.dispose();
      } finally {
        busy = false;
      }
    }
  },
};
