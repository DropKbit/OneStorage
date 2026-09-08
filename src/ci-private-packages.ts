import { lockPackages } from "./build-packages";
import { BUILD_LIMIT, type BuildStep } from "./ci-build-schema";
import {
  loadRunVariables,
  assertVariablesActive,
  variableLive,
} from "./ci-variables";
import { resolveDeployToken, assertDeployAccess } from "./deploy-tokens";
import { base64 } from "./base64";
import { boundedBody, fail } from "./security";
import type { Env, Repo } from "./types";
import type { CIRun } from "./ci";

export function privatePackageAddress(url: URL, origin: string) {
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return null;
  const m =
    /^\/api\/repos\/([^/]+)\/([^/]+)\/packages\/npm\/([^/]+)\/-\/([^/]+)$/.exec(
      url.pathname,
    );
  if (!m) return null;
  try {
    const [namespace, project, name, file] = m.slice(1).map(decodeURIComponent);
    if (
      ![namespace, project, file].every(
        (s) => s && !/[\/\\\x00-\x1f]/.test(s),
      ) ||
      !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)
    )
      return null;
    return { namespace, project, name, file };
  } catch {
    return null;
  }
}

/** Only the trusted control plane reads credentials and R2; the compiler gets verified bytes. */
export async function privateBuildPackages(
  env: Env,
  run: CIRun,
  step: BuildStep,
  files: Record<string, string>,
) {
  const locked = lockPackages(
      files,
      (u) => !!privatePackageAddress(u, env.APP_ORIGIN),
    ),
    privateEntries = Object.entries(locked).filter(
      ([, p]) => new URL(p.resolved).origin !== "https://registry.npmjs.org",
    );
  const supplied: Record<string, string> = Object.create(null);
  if (!privateEntries.length) return supplied;
  if (privateEntries.length > BUILD_LIMIT.packages)
    fail(413, "Private npm package count limit exceeded");
  const { variables } = await loadRunVariables(env, run);
  let size = 0;
  for (const [path, p] of privateEntries) {
    const address = privatePackageAddress(new URL(p.resolved), env.APP_ORIGIN)!;
    const repo = await env.DB.prepare(
      "SELECT * FROM repositories WHERE namespace=? AND name=? AND deleted_at IS NULL",
    )
      .bind(address.namespace, address.project)
      .first<Repo>();
    const setting = step.private_registries?.find(
      (r) => r.project_id === repo?.id,
    );
    if (!repo || !setting || !Object.hasOwn(variables, setting.token_variable))
      fail(
        403,
        "Private registry requires an explicitly selected project and credential",
      );
    const secret = await env.DB.prepare(
      "SELECT secret FROM ci_run_variables WHERE run_id=? AND key=?",
    )
      .bind(run.id, setting.token_variable)
      .first<{ secret: number }>();
    if (!secret?.secret)
      fail(403, "Private registry credentials must be secret CI variables");
    const token = await resolveDeployToken(
      env,
      variables[setting.token_variable],
    );
    await assertDeployAccess(env, repo, token, "read_package_registry");
    const file = await env.DB.prepare(
      "SELECT f.id,f.object_key,f.size,f.sha512,v.version FROM package_files f JOIN package_versions v ON v.id=f.version_id WHERE v.repo_id=? AND v.kind='npm' AND v.name=? AND f.filename=? AND v.deleted_at IS NULL AND f.deleted_at IS NULL",
    )
      .bind(repo.id, address.name, address.file)
      .first<{
        id: string;
        object_key: string;
        size: number;
        sha512: string;
        version: string;
      }>();
    if (
      !file ||
      file.version !== p.version ||
      p.integrity !== "sha512-" + file.sha512 ||
      address.name !== path.split("node_modules/").at(-1)
    )
      fail(
        409,
        "Private package lock does not match immutable registry content",
      );
    if (Object.hasOwn(supplied, p.resolved)) continue;
    size += file.size;
    if (size > BUILD_LIMIT.compressed)
      fail(413, "Private npm compressed byte limit exceeded");
    await env.DB.prepare(
      `INSERT OR IGNORE INTO ci_run_packages(run_id,file_id,project_id,lifecycle_revision,token_id,token_hash,token_revision) SELECT ?,?,?,?,?,?,? WHERE ${variableLive}`,
    )
      .bind(
        run.id,
        file.id,
        repo.id,
        repo.lifecycle_revision || 0,
        token.id,
        token.hash,
        token.revision,
        run.id,
        run.lease_hash,
        Date.now(),
      )
      .run();
    await assertVariablesActive(env, run);
    const object = await env.OBJECTS.get(file.object_key);
    if (!object) fail(503, "Private package temporarily unavailable");
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      await assertDeployAccess(env, repo, token, "read_package_registry");
      await assertVariablesActive(env, run);
      bytes = (await boundedBody(new Response(object.body), file.size)).slice();
    } catch (e) {
      await object.body.cancel().catch(() => {});
      throw e;
    }
    if (
      bytes.length !== file.size ||
      "sha512-" +
        base64(new Uint8Array(await crypto.subtle.digest("SHA-512", bytes))) !==
        p.integrity
    )
      fail(409, "Private package SHA-512 integrity mismatch");
    await assertVariablesActive(env, run);
    supplied[p.resolved] = base64(bytes);
  }
  return supplied;
}
