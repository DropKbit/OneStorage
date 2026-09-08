import { z } from "zod";
import type { Env, Repo } from "./types";
import { digest, fail, hex } from "./security";
import { unguardDatabase } from "./project-db";
export const deployScopes = [
  "read_repository",
  "read_package_registry",
  "write_package_registry",
  "delete_package_registry",
] as const;
export type DeployScope = (typeof deployScopes)[number];
export const deployScopeSchema = z
  .array(z.enum(deployScopes))
  .min(1)
  .max(4)
  .refine((a) => new Set(a).size === a.length, "Duplicate deploy scope");
export const deployInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    username: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,79}$/)
      .optional(),
    scopes: deployScopeSchema,
    days: z.number().int().min(1).max(365).default(90),
    otp: z.string().max(64).default(""),
  })
  .strict();
export const deployRefSchema = z
  .object({
    id: z.uuid(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    revision: z.number().int().positive(),
  })
  .strict();
export type DeployTokenRef = z.infer<typeof deployRefSchema>;
export interface DeployToken extends DeployTokenRef {
  repo_id: string | null;
  workspace_id: string | null;
  username: string;
  created_by: string;
  scopes: DeployScope[];
  expires_at: number;
  last_used_at: number | null;
}
export const deployAccessSQL = (write = false) =>
  `EXISTS(SELECT 1 FROM repositories r JOIN deploy_tokens d ON (d.repo_id=r.id OR (d.workspace_id IS NOT NULL AND d.workspace_id=r.workspace_id)) WHERE r.id=? AND r.lifecycle_revision=? AND r.deleted_at IS NULL ${write ? "AND r.archived_at IS NULL" : ""} AND d.id=? AND d.hash=? AND d.revision=? AND d.revoked_at IS NULL AND d.expires_at>? AND EXISTS(SELECT 1 FROM json_each(d.scopes) WHERE value=?))`;
export const deployAccessArgs = (
  repo: Pick<Repo, "id" | "lifecycle_revision">,
  token: DeployTokenRef,
  scope: DeployScope,
) => [
  repo.id,
  repo.lifecycle_revision || 0,
  token.id,
  token.hash,
  token.revision,
  Date.now(),
  scope,
];
export async function assertDeployAccess(
  env: Env,
  repo: Pick<Repo, "id" | "lifecycle_revision">,
  token: DeployTokenRef,
  scope: DeployScope,
  write = false,
) {
  const allowed = await unguardDatabase(env.DB)
    .prepare(`SELECT 1 allowed WHERE ${deployAccessSQL(write)}`)
    .bind(...deployAccessArgs(repo, token, scope))
    .first();
  if (!allowed)
    fail(
      403,
      "Deploy token scope, expiry, revision or project boundary no longer permits this request",
    );
}
export async function resolveDeployToken(
  env: Env,
  secret: string,
  basicUsername?: string,
) {
  if (!/^odt_[a-f0-9]{64}$/.test(secret)) fail(401, "Invalid deploy token");
  const hash = await digest(secret),
    row = await unguardDatabase(env.DB)
      .prepare(
        "SELECT * FROM deploy_tokens WHERE hash=? AND revoked_at IS NULL AND expires_at>?",
      )
      .bind(hash, Date.now())
      .first<any>();
  if (!row || (basicUsername !== undefined && basicUsername !== row.username))
    fail(401, "Invalid, revoked or expired deploy token");
  return {
    ...row,
    scopes: deployScopeSchema.parse(JSON.parse(row.scopes)),
  } as DeployToken;
}
export const newDeploySecret = () =>
  "odt_" + hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
/** A token is never a user session and is accepted only on explicitly supported protocols. */
export function deployRequestAllowed(path: string) {
  return (
    /^\/api\/repos\/[^/]+\/[^/]+\/packages(?:\/|$)/.test(path) ||
    /^\/[^/]+\/[^/]+\.git\/(?:info\/refs$|git-upload-pack$|info\/lfs\/objects(?:\/|$))/.test(
      path,
    )
  );
}
/** Runs in the DO after its request gate and again before returning any prepared body. */
export async function assertDeployGitRequest(env: Env, request: Request) {
  const raw = request.headers.get("x-deploy-token");
  if (!raw) return;
  let token: DeployTokenRef;
  try {
    token = deployRefSchema.parse(JSON.parse(raw));
  } catch {
    fail(403, "Invalid deployment principal");
  }
  const url = new URL(request.url),
    path = url.pathname;
  if (!(
    (request.method === "GET" &&
      path === "/git/info/refs" &&
      url.searchParams.get("service") === "git-upload-pack") ||
    (request.method === "POST" && path === "/git/git-upload-pack") ||
    (request.method === "GET" && /^\/internal\/lfs\/[a-f0-9]{64}$/.test(path))
  ))
    fail(403, "Deploy tokens cannot write Git or use internal APIs");
  const id = request.headers.get("x-repo-id") || "",
    revision = Number(request.headers.get("x-lifecycle-revision"));
  if (
    !/^[a-f0-9-]{36}$/.test(id) ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  )
    fail(403, "Invalid deployment project snapshot");
  await assertDeployAccess(
    env,
    { id, lifecycle_revision: revision },
    token,
    "read_repository",
  );
}
