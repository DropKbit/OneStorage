import { importPKCS8, SignJWT } from "jose";
import { createPrivateKey } from "node:crypto";
import { z } from "zod";
import type { Env, Repo } from "./types";
import { unseal, Upstream } from "./sync-config";
import { base64 } from "./git/signatures";
import { fail, boundedBody } from "./security";
export const githubSchema = z.object({
  app_id: z.string().regex(/^\d+$/),
  installation_id: z.string().regex(/^\d+$/),
  private_key: z.string().min(1).max(20000),
  webhook_secret: z.string().min(16).max(1000),
});
export type GitHubConfig = z.infer<typeof githubSchema>;
export async function githubPrivateKey(pem: string) {
  try {
    return await importPKCS8(
      createPrivateKey(pem).export({ format: "pem", type: "pkcs8" }).toString(),
      "RS256",
    );
  } catch {
    fail(400, "Invalid GitHub App RSA private key");
  }
}
export async function githubConfig(env: Env, userId: string) {
  const row = await env.DB.prepare(
    "SELECT encrypted FROM github_integrations WHERE user_id=?",
  )
    .bind(userId)
    .first<{ encrypted: string }>();
  if (!row) fail(409, "GitHub App integration is not configured");
  return unseal<GitHubConfig>(env, "github:" + userId, row.encrypted);
}
export async function githubHeaders(
  env: Env,
  repo: Repo,
  base: Upstream,
  send: typeof fetch = fetch,
) {
  const config = await githubConfig(env, repo.owner_id),
    now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(config.app_id)
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 540)
    .sign(await githubPrivateKey(config.private_key));
  const response = await send(
    `https://api.github.com/app/installations/${config.installation_id}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + jwt,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "OneStorage",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ repositories: [base.name] }),
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    fail(403, "GitHub installation token request failed");
  }
  let result;
  try {
    result = JSON.parse(
      new TextDecoder().decode(
        await boundedBody(response as unknown as Request, 1024 * 1024),
      ),
    );
  } catch {
    fail(503, "Invalid GitHub token response");
  }
  if (
    typeof result.token !== "string" ||
    !result.token ||
    Date.parse(result.expires_at) <= Date.now()
  )
    fail(503, "Invalid GitHub installation token");
  return {
    Authorization:
      "Basic " +
      base64(new TextEncoder().encode("x-access-token:" + result.token)),
  };
}
export async function verifyGitHubWebhook(
  body: Uint8Array,
  signature: string,
  secret: string,
) {
  if (!/^sha256=[0-9a-f]{64}$/.test(signature)) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const sig = Uint8Array.from(signature.slice(7).match(/../g)!, (x) =>
    parseInt(x, 16),
  );
  return crypto.subtle.verify("HMAC", key, sig, body as BufferSource);
}
