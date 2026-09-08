import type { CIRun } from "./ci";
import type { Env } from "./types";
import type { CloudFiles } from "./cloud-ci";
import { workflowSchema, filePath } from "./ci-config";
import { boundedBody } from "./security";
import { base64 } from "./base64";
export type DependencyFiles = Record<string, CloudFiles>;
/** Only declared, successful siblings of the exact parent are eligible as inputs. */
export async function dependencyArtifacts(
  env: Env,
  run: CIRun,
  limit = 4 * 1024 * 1024,
): Promise<DependencyFiles> {
  const files: DependencyFiles = Object.create(null);
  if (!run.parent_id) return files;
  const parent = await env.DB.prepare(
    "SELECT * FROM ci_runs WHERE id=? AND repo_id=? AND sha=? AND status='running'",
  )
    .bind(run.parent_id, run.repo_id, run.sha)
    .first<CIRun>();
  if (!parent) throw Error("Parent workflow stopped");
  const job = workflowSchema
    .parse(JSON.parse(parent.config))
    .jobs.find((j) => j.id === run.job_key);
  if (!job) throw Error("Workflow job unavailable");
  let total = 0;
  for (const key of job.needs) {
    const dependency = await env.DB.prepare(
      "SELECT id FROM ci_runs WHERE parent_id=? AND job_key=? AND status='succeeded'",
    )
      .bind(parent.id, key)
      .first<{ id: string }>();
    if (!dependency) throw Error("Workflow dependency has not succeeded");
    const artifacts = await env.DB.prepare(
      "SELECT name,size,object_key FROM ci_artifacts WHERE run_id=? ORDER BY name",
    )
      .bind(dependency.id)
      .all<{ name: string; size: number; object_key: string }>();
    const entries: CloudFiles = Object.create(null);
    files[key] = entries;
    for (const artifact of artifacts.results) {
      filePath.parse(artifact.name);
      total += artifact.size;
      if (
        total > limit ||
        !artifact.object_key.startsWith(`ci/${run.repo_id}/${dependency.id}/`)
      )
        throw Error("Workflow inputs exceed budget or scope");
      const object = await env.OBJECTS.get(artifact.object_key);
      if (!object || object.size !== artifact.size)
        throw Error("Dependency artifact unavailable");
      const data = await boundedBody(new Response(object.body), limit);
      let content: string;
      let binary = data.includes(0) || artifact.name.endsWith(".wasm");
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(data);
      } catch {
        binary = true;
        content = "";
      }
      entries[artifact.name] = {
        content: binary ? base64(data) : content,
        binary,
      };
      if (new TextEncoder().encode(JSON.stringify(files)).length > limit * 2)
        throw Error("Encoded workflow inputs exceed budget");
    }
  }
  return files;
}
