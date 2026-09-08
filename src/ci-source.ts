import { pipelineSchema, filePath, type Pipeline } from "./ci-config";
import type { Env, Repo } from "./types";
import { boundedBody, fail } from "./security";
import { webhookURL } from "./webhooks";

export interface SavedPipeline {
  config: string;
  source_path?: string | null;
}
export interface ConfigOrigin {
  schedule_tick_id?: string;
  config_path?: string | null;
  config_sha?: string | null;
  error?: string;
}
export function validateDestinations(config: Pipeline, env: Env) {
  const steps =
    config.runner === "workflow"
      ? config.jobs.flatMap((j) => j.pipeline.steps)
      : config.steps;
  for (const step of steps)
    if (step.type === "http") {
      try {
        webhookURL(step.url, env.CI_ALLOWED_HOSTS);
      } catch {
        fail(
          400,
          "HTTP checks require an operator-approved CI_ALLOWED_HOSTS destination",
        );
      }
    }
}
export async function resolvePipeline(
  env: Env,
  repo: Repo,
  saved: SavedPipeline,
  sha: string,
) {
  let raw = saved.config;
  if (saved.source_path) {
    filePath.parse(saved.source_path);
    const response = await env.REPOSITORIES.get(
      env.REPOSITORIES.idFromName(repo.id),
    ).fetch(
      new Request(
        "http://repository/file?ref=" +
          sha +
          "&path=" +
          encodeURIComponent(saved.source_path),
        {
          headers: {
            "x-repo-id": repo.id,
            "x-default-branch": repo.default_branch,
          },
        },
      ),
    );
    if (!response.ok) {
      await response.body?.cancel();
      fail(409, "Repository pipeline file unavailable: " + saved.source_path);
    }
    raw = new TextDecoder("utf-8", { fatal: true }).decode(
      await boundedBody(response, 128 * 1024),
    );
  }
  const config = pipelineSchema.parse(JSON.parse(raw));
  validateDestinations(config, env);
  return {
    config,
    config_path: saved.source_path || null,
    config_sha: saved.source_path ? sha : null,
  };
}
