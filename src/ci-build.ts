import { buildStep, BUILD_LIMIT } from "./ci-build-schema";
import { sourceFiles, cloudPath, type CloudFiles } from "./cloud-ci";
import { assertVariablesActive } from "./ci-variables";
import { boundedBody } from "./security";
import { z } from "zod";
import type { Env, Repo } from "./types";
import type { CIRun } from "./ci";
import { privateBuildPackages } from "./ci-private-packages";

export async function executeBuild(
  env: Env,
  repo: Repo,
  run: CIRun,
  step: z.infer<typeof buildStep>,
  artifacts: CloudFiles,
) {
  if (!env.BUILDER)
    throw Error("Cloud build service binding is not configured");
  const paths = new Set<string>();
  const engine = env.REPOSITORIES.get(env.REPOSITORIES.idFromName(repo.id));
  for (const source of step.sources) {
    const response = await engine.fetch(
      new Request(
        "http://repository/files?recursive=true&limit=257&ref=" +
          run.sha +
          "&path=" +
          encodeURIComponent(source),
        {
          headers: {
            "x-repo-id": repo.id,
            "x-default-branch": repo.default_branch,
          },
        },
      ),
    );
    if (!response.ok) throw Error("Build source unavailable: " + source);
    const data = (await response.json()) as {
      files: { path: string; type: string }[];
      has_more: boolean;
    };
    if (data.has_more) throw Error("Cloud build source exceeds 256 files");
    for (const file of data.files) {
      if (file.type !== "blob")
        throw Error("Cloud build sources cannot contain links or submodules");
      paths.add(file.path);
    }
    if (paths.size > BUILD_LIMIT.files)
      throw Error("Cloud build source exceeds 256 files");
  }
  if (!paths.has(step.entry)) throw Error("Build entry missing from sources");
  const source = await sourceFiles(env, repo, run.sha, [...paths]);
  const files: Record<string, string> = Object.create(null);
  for (const [path, file] of Object.entries(source)) {
    if (file.binary) throw Error("Build source must be UTF-8 text: " + path);
    files[path] = file.content;
  }
  await assertVariablesActive(env, run);
  const packages = await privateBuildPackages(env, run, step, files);
  const payload = JSON.stringify({
    step: { ...step, private_registries: undefined },
    files,
    packages,
  });
  if (new TextEncoder().encode(payload).length > BUILD_LIMIT.request)
    throw Error("Cloud compiler request limit exceeded");
  const signal = AbortSignal.timeout(75000);
  let response: Response;
  for (let attempt = 0; ; attempt++) {
    response = await env.BUILDER.fetch(
      new Request("https://compiler.internal/build", {
        method: "POST",
        body: payload,
        signal,
      }),
    );
    if (response.status !== 503 || attempt >= 10) break;
    await response.body?.cancel();
    await assertVariablesActive(env, run);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const raw = new TextDecoder().decode(
    await boundedBody(response, 6 * 1024 * 1024),
  );
  if (!response.ok) {
    let error = "Cloud compiler failed: HTTP " + response.status;
    try {
      error = JSON.parse(raw).error || error;
    } catch {}
    throw Error(error);
  }
  const result = z
    .object({
      artifacts: z.record(cloudPath, z.string().max(1024 * 1024)),
      packages: z.number().int().nonnegative(),
      compiler: z.string().max(80),
    })
    .parse(JSON.parse(raw));
  await assertVariablesActive(env, run);
  for (const [path, content] of Object.entries(result.artifacts))
    artifacts[path] = { content };
  if (
    Object.keys(artifacts).length > 10 ||
    new TextEncoder().encode(JSON.stringify(artifacts)).length >
      BUILD_LIMIT.output
  )
    throw Error("Cloud artifacts exceed 10 files / 2 MiB");
  return `PASS ${result.compiler} ${step.entry} → ${step.outfile}; ${result.packages} integrity-verified npm packages\n`;
}
