import { cacheFilesSchema, CLOUD_CACHE_LIMIT } from "./ci-cache-schema";
import { loadRunVariables, assertVariablesActive } from "./ci-variables";
import { redact } from "./ci-redaction";
import { z } from "zod";
import type { Env, Repo } from "./types";
import type { CIRun } from "./ci";
import { base64 } from "./base64";
import { boundedBody } from "./security";
import type { DependencyFiles } from "./ci-inputs";
export const cloudPath = z
  .string()
  .min(1)
  .max(240)
  .regex(/^[a-zA-Z0-9_@.\-/]+$/)
  .refine(
    (s) =>
      !s.startsWith("/") &&
      !s.split("/").some((x) => !x || x === "." || x === "..") &&
      !s.startsWith("__onestorage"),
  );
export const cloudStep = z.object({
  type: z.literal("javascript"),
  entry: cloudPath,
  files: z.array(cloudPath).min(1).max(32),
  cpu_ms: z.number().int().min(10).max(10000).default(1000),
});
export const deployConfig = z.object({
  environment: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,39}$/)
    .default("production"),
  kind: z.enum(["worker", "static"]),
  entry: cloudPath.default("index.js"),
  files: z.array(cloudPath).min(1).max(32),
});
export type CloudFiles = Record<string, { content: string; binary?: boolean }>;
export function modulesFor(
  files: CloudFiles,
): WorkerLoaderWorkerCode["modules"] {
  const modules: WorkerLoaderWorkerCode["modules"] = Object.create(null);
  for (const [name, file] of Object.entries(files)) {
    cloudPath.parse(name);
    if (name.endsWith(".wasm")) {
      if (!file.binary) throw Error("WASM must contain binary data");
      modules[name] = {
        wasm: Uint8Array.from(atob(file.content), (c) => c.charCodeAt(0)),
      };
    } else if (/\.(m?js)$/.test(name) && !file.binary)
      modules[name] = file.content;
    else modules[name] = { text: file.content };
  }
  return modules;
}
export async function sourceFiles(
  env: Env,
  repo: Repo,
  sha: string,
  paths: string[],
): Promise<CloudFiles> {
  const files: CloudFiles = Object.create(null);
  let size = 0;
  for (const path of new Set(paths)) {
    cloudPath.parse(path);
    const response = await env.REPOSITORIES.get(
      env.REPOSITORIES.idFromName(repo.id),
    ).fetch(
      new Request(
        "http://repository/file?ref=" +
          sha +
          "&path=" +
          encodeURIComponent(path),
        {
          headers: {
            "x-repo-id": repo.id,
            "x-default-branch": repo.default_branch,
          },
        },
      ),
    );
    if (!response.ok) throw Error("Source file unavailable: " + path);
    const data = await boundedBody(response, 1024 * 1024);
    size += data.length;
    if (size > 4 * 1024 * 1024) throw Error("Cloud source exceeds 4 MiB");
    const binary = data.includes(0) || path.endsWith(".wasm");
    files[path] = {
      content: binary
        ? base64(data)
        : new TextDecoder("utf-8", { fatal: true }).decode(data),
      binary,
    };
  }
  return files;
}
export async function executeJavaScript(
  env: Env,
  repo: Repo,
  run: CIRun,
  step: z.infer<typeof cloudStep>,
  artifacts: CloudFiles,
  dependencies: DependencyFiles = {},
  caches: Record<string, CloudFiles> = {},
) {
  if (!env.LOADER)
    throw Error("Cloudflare Dynamic Workers binding is not configured");
  if (!step.files.includes(step.entry))
    throw Error("JavaScript entry must be included in files");
  const files = await sourceFiles(env, repo, run.sha, step.files),
    modules = modulesFor(files);
  const { variables, patterns } = await loadRunVariables(env, run);
  modules["__onestorage_ci.js"] =
    `import job from ${JSON.stringify("./" + step.entry)};
export default { async fetch(request) { try { const input = await request.json(); const captured=[];for(const k of ["log","info","warn","error","debug"])console[k]=(...args)=>{if(captured.length<32)captured.push(args.map(v=>typeof v==="string"?v:JSON.stringify(v)).join(" ").slice(0,65536));}; const result = await job(input); if(!result || typeof result!=="object" || Array.isArray(result)) throw Error("Job must return an object"); return Response.json({...result,logs:[...captured,...(result?.logs||[])]}); } catch(e) { return Response.json({error: String(e?.stack || e)}, {status: 500}); } } };`;
  const worker = env.LOADER.load({
    compatibilityDate: "2026-09-01",
    mainModule: "__onestorage_ci.js",
    modules,
    globalOutbound: null,
    limits: { cpuMs: step.cpu_ms, subRequests: 0 },
  });
  await assertVariablesActive(env, run);
  const response = await worker.getEntrypoint().fetch(
    new Request("https://ci.invalid/run", {
      method: "POST",
      body: JSON.stringify({
        sha: run.sha,
        ref: run.ref,
        job: run.job_key || null,
        files,
        artifacts,
        dependencies,
        variables,
        caches,
      }),
      signal: AbortSignal.timeout(20000),
    }),
  );
  const raw = new TextDecoder().decode(
    await boundedBody(response, 6 * 1024 * 1024),
  );
  if (!response.ok)
    throw Error(
      "Isolated JavaScript failed: " +
        redact(
          (() => {
            try {
              const e = JSON.parse(raw);
              return typeof e.error === "string" ? e.error : raw;
            } catch {
              return raw;
            }
          })(),
          patterns,
        ).slice(0, 1000),
    );
  const result = z
    .object({
      caches: z.record(z.string(), cacheFilesSchema).optional(),
      logs: z.array(z.string().max(4096)).max(32).default([]),
      artifacts: z.record(cloudPath, z.string().max(1024 * 1024)).default({}),
    })
    .parse(
      (() => {
        const result = JSON.parse(raw);
        if (Array.isArray(result.logs))
          result.logs = result.logs.map((s: unknown) =>
            typeof s === "string" ? redact(s, patterns).slice(0, 4096) : s,
          );
        return result;
      })(),
    );
  if (result.caches) {
    if (
      new TextEncoder().encode(JSON.stringify(result.caches)).length >
      CLOUD_CACHE_LIMIT
    )
      throw Error("Cloud caches exceed 4 MiB");
    for (const [slot, files] of Object.entries(result.caches)) {
      if (!Object.hasOwn(caches, slot))
        throw Error("Unconfigured cache output");
      caches[slot] = files;
    }
  }
  for (const [name, content] of Object.entries(result.artifacts))
    artifacts[name] = { content };
  if (
    Object.keys(artifacts).length > 10 ||
    new TextEncoder().encode(JSON.stringify(artifacts)).length > 2 * 1024 * 1024
  )
    throw Error("Cloud artifacts exceed 10 files / 2 MiB");
  return result.logs.join("\n");
}
export async function saveCloudOutput(
  env: Env,
  repo: Repo,
  run: CIRun,
  artifacts: CloudFiles,
  deploy?: z.infer<typeof deployConfig>,
) {
  const statements: D1PreparedStatement[] = [],
    objects: string[] = [];
  const live =
    "EXISTS(SELECT 1 FROM ci_runs c JOIN repositories r ON r.id=c.repo_id WHERE c.id=? AND c.status='running' AND c.lease_hash=? AND c.lease_until>? AND r.deleted_at IS NULL AND r.archived_at IS NULL)";
  let publishing = false;
  try {
    for (const [name, file] of Object.entries(artifacts)) {
      const id = crypto.randomUUID(),
        key = `ci/${repo.id}/${run.id}/${id}`;
      await env.OBJECTS.put(key, file.content);
      objects.push(key);
      statements.push(
        env.DB.prepare(
          `INSERT INTO ci_artifacts(id,run_id,name,size,object_key) SELECT ?,?,?,?,? WHERE ${live}`,
        ).bind(
          id,
          run.id,
          name,
          new TextEncoder().encode(file.content).length,
          key,
          run.id,
          run.lease_hash,
          Date.now(),
        ),
      );
    }
    if (deploy) {
      if (!env.APPS_ORIGIN)
        throw Error("Cloud application gateway is not configured");
      const missing = deploy.files.filter((p) => !Object.hasOwn(artifacts, p));
      const source = await sourceFiles(env, repo, run.sha, missing),
        files: CloudFiles = Object.create(null);
      for (const path of deploy.files)
        files[path] = artifacts[path] || source[path];
      if (!Object.hasOwn(files, deploy.entry))
        throw Error("Deployment entry missing from files");
      const id = crypto.randomUUID(),
        key = `ci/${repo.id}/deployments/${id}.json`;
      const bundle = JSON.stringify({
        kind: deploy.kind,
        entry: deploy.entry,
        files,
      });
      if (new TextEncoder().encode(bundle).length > 4 * 1024 * 1024)
        throw Error("Deployment exceeds 4 MiB");
      await env.OBJECTS.put(key, bundle);
      objects.push(key);
      statements.push(
        env.DB.prepare(
          `INSERT INTO deployments(id,repo_id,run_id,environment,sha,object_key) SELECT ?,?,?,?,?,? WHERE ${live}`,
        ).bind(
          id,
          repo.id,
          run.id,
          deploy.environment,
          run.sha,
          key,
          run.id,
          run.lease_hash,
          Date.now(),
        ),
      );
      // A deployment is immutable; activation is explicit and uses a CAS to avoid overwriting another operator's release.
      statements.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO environments(repo_id,name) SELECT ?,? WHERE ${live}`,
        ).bind(repo.id, deploy.environment, run.id, run.lease_hash, Date.now()),
      );
    }
    statements.push(
      env.DB.prepare(
        "UPDATE ci_runs SET status='succeeded',finished_at=datetime('now'),lease_hash=NULL,lease_until=NULL WHERE id=? AND status='running' AND lease_hash=? AND lease_until>?",
      ).bind(run.id, run.lease_hash, Date.now()),
    );
    publishing = true;
    const result = await env.DB.batch(statements);
    if (!result.at(-1)?.meta.changes)
      for (const key of objects) await env.OBJECTS.delete(key);
  } catch (e) {
    if (!publishing) for (const key of objects) await env.OBJECTS.delete(key);
    throw e;
  }
}
