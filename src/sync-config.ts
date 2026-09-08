import { z } from "zod";
import type { Env, Repo } from "./types";
import { fail } from "./security";
import { base64, unbase64 } from "./git/signatures";
export const upstreamSchema = z.object({
  provider: z
    .enum([
      "github",
      "gitlab",
      "bitbucket",
      "gitea",
      "forgejo",
      "codeberg",
      "sr.ht",
      "sourcehut",
    ])
    .default("github"),
  owner: z.string().min(1).max(200),
  name: z.string().min(1).max(100),
  upstream_host: z.string().max(253).optional(),
  default_branch: z.string().max(200).optional(),
  mode: z.enum(["public", "app", "generic"]).optional(),
});
export type Upstream = z.infer<typeof upstreamSchema>;
const publicHosts: Record<string, string> = {
  github: "github.com",
  gitlab: "gitlab.com",
  bitbucket: "bitbucket.org",
  codeberg: "codeberg.org",
  "sr.ht": "git.sr.ht",
  sourcehut: "git.sr.ht",
};
export function upstreamURL(value: unknown, allowed = "") {
  const b = upstreamSchema.parse(value),
    host = b.upstream_host || publicHosts[b.provider];
  const hosts = new Set([
    ...Object.values(publicHosts),
    ...allowed
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  ]);
  if (
    !host ||
    !hosts.has(host) ||
    !/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/i.test(host) ||
    /\.(local|localhost|internal|test)$/i.test(host) ||
    host.toLowerCase() === "localhost"
  )
    fail(400, "Upstream host must be HTTPS on the operator allowlist");
  if (b.provider === "github" && host !== "github.com")
    fail(400, "GitHub integration supports github.com");
  if (
    !b.owner
      .split("/")
      .every(
        (p) =>
          /^[~a-zA-Z0-9_-][a-zA-Z0-9_.~-]*$/.test(p) &&
          ![".", ".."].includes(p),
      ) ||
    !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(b.name) ||
    b.name.endsWith(".git")
  )
    fail(400, "Invalid upstream repository path");
  return `https://${host}/${b.owner}/${b.name}.git`;
}
async function encryptionKey(env: Env) {
  if (!env.CREDENTIAL_ENCRYPTION_KEY)
    fail(503, "Operator must configure CREDENTIAL_ENCRYPTION_KEY");
  let raw;
  try {
    raw = unbase64(env.CREDENTIAL_ENCRYPTION_KEY);
  } catch {
    fail(503, "Invalid credential encryption configuration");
  }
  if (raw.length !== 32)
    fail(503, "Credential key must contain 32 random bytes");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
export async function seal(env: Env, context: string, value: unknown) {
  const iv = crypto.getRandomValues(new Uint8Array(12)),
    key = await encryptionKey(env);
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(context) },
    key,
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return "v1." + base64(iv) + "." + base64(new Uint8Array(data));
}
export async function unseal<T>(
  env: Env,
  context: string,
  value: string,
): Promise<T> {
  try {
    const [version, iv, body] = value.split(".");
    if (version !== "v1") throw Error();
    return JSON.parse(
      new TextDecoder().decode(
        await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: unbase64(iv),
            additionalData: new TextEncoder().encode(context),
          },
          await encryptionKey(env),
          unbase64(body),
        ),
      ),
    );
  } catch {
    fail(503, "Stored credential could not be decrypted");
  }
}
export const credentialSchema = z.object({
  username: z
    .string()
    .max(200)
    .refine((s) => !/[\r\n:]/.test(s))
    .default("oauth2"),
  password: z.string().min(1).max(10000),
});
export async function genericHeaders(env: Env, repo: Repo) {
  const row = await env.DB.prepare(
    "SELECT id,encrypted FROM git_credentials WHERE repo_id=? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(repo.id)
    .first<{ id: string; encrypted: string }>();
  if (!row) fail(409, "Upstream Git credential is not configured");
  const c = await unseal<z.infer<typeof credentialSchema>>(
    env,
    "git:" + repo.id + ":" + row.id,
    row.encrypted,
  );
  return {
    Authorization:
      "Basic " +
      base64(new TextEncoder().encode(c.username + ":" + c.password)),
  };
}
