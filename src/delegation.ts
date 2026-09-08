import { decodeJwt, decodeProtectedHeader, importSPKI, jwtVerify } from "jose";
import { z } from "zod";
import { fail, repoName } from "./security";
import { validRef } from "./git/objects";
import type { Env, User } from "./types";
export const algorithms = ["ES256", "ES384", "ES512", "RS256"] as const;
export const scopes = [
  "git:read",
  "git:write",
  "repo:write",
  "org:read",
] as const;
export type Scope = (typeof scopes)[number];
export type RefOperation = "no-force-push" | "no-push" | "verify-sig";
export type RefPolicy = [string, RefOperation[]];
export interface Delegation {
  user: User;
  issuer: string;
  subject: string;
  repo?: string;
  scopes: Scope[];
  refs: RefPolicy[];
  keyId: string;
}
export function normalizePolicies(value: unknown): RefPolicy[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64)
    fail(400, "At most 64 ordered ref policies are allowed");
  return value.map((rule) => {
    if (
      !Array.isArray(rule) ||
      rule.length !== 2 ||
      typeof rule[0] !== "string" ||
      !Array.isArray(rule[1])
    )
      fail(400, "Policies must be ordered [pattern, operations] pairs");
    let pattern = rule[0];
    if (pattern !== "*" && !pattern.startsWith("refs/"))
      pattern = "refs/heads/" + pattern;
    const candidate = pattern.endsWith("/*")
      ? pattern.slice(0, -1) + "x"
      : pattern;
    if (pattern !== "*" && (!validRef(candidate) || candidate.includes("*")))
      fail(400, "Invalid ref policy pattern");
    if (
      rule[1].some(
        (op: unknown) =>
          !["no-force-push", "no-push", "verify-sig"].includes(String(op)),
      )
    )
      fail(400, "Unsupported ref policy operation");
    return [pattern, [...new Set(rule[1])] as RefOperation[]];
  });
}
export function refOperations(ref: string, rules: RefPolicy[]): RefOperation[] {
  for (const [pattern, ops] of rules)
    if (
      pattern === "*" ||
      pattern === ref ||
      (pattern.endsWith("/*") && ref.startsWith(pattern.slice(0, -1)))
    )
      return ops;
  return [];
}
export async function verifyDelegation(
  env: Env,
  token: string,
): Promise<Delegation> {
  if (token.length > 16384) fail(401, "JWT is too large");
  try {
    const header = decodeProtectedHeader(token),
      claims = decodeJwt(token);
    if (
      !algorithms.includes(header.alg as any) ||
      header.typ !== "JWT" ||
      typeof claims.iss !== "string" ||
      typeof claims.sub !== "string" ||
      !claims.sub ||
      claims.sub.length > 200
    )
      fail(401, "Invalid JWT identity");
    const candidates = await env.DB.prepare(
      "SELECT k.id,k.public_key,k.algorithm,u.id AS user_id,u.username FROM api_keys k JOIN users u ON u.id=k.user_id WHERE u.disabled=0 AND u.username=? AND (? IS NULL OR k.id=?) LIMIT 20",
    )
      .bind(claims.iss, header.kid || null, header.kid || null)
      .all<{
        id: string;
        public_key: string;
        algorithm: string;
        user_id: string;
        username: string;
      }>();
    for (const row of candidates.results) {
      if (row.algorithm !== header.alg) continue;
      try {
        const key = await importSPKI(row.public_key, row.algorithm),
          { payload } = await jwtVerify(token, key, {
            algorithms: [row.algorithm],
            issuer: row.username,
            requiredClaims: ["exp", "iat", "sub"],
            clockTolerance: 0,
          });
        if (
          typeof payload.iat !== "number" ||
          typeof payload.exp !== "number" ||
          payload.iat > Math.floor(Date.now() / 1000) + 60 ||
          payload.exp <= payload.iat ||
          payload.exp - payload.iat > 365 * 86400
        )
          fail(401, "Invalid JWT lifetime");
        const allowed = z
          .array(z.enum(scopes))
          .min(1)
          .max(4)
          .parse(payload.scopes);
        if (
          payload.repo !== undefined &&
          (typeof payload.repo !== "string" ||
            !payload.repo.startsWith(row.username + "/") ||
            !repoName.safeParse(payload.repo.slice(row.username.length + 1))
              .success)
        )
          fail(401, "JWT repository must belong to its issuer");
        if (
          allowed.some((s) => s !== "org:read") &&
          typeof payload.repo !== "string"
        )
          fail(401, "Repository claim required");
        return {
          user: { id: row.user_id, username: row.username, admin: 0 },
          issuer: row.username,
          subject: payload.sub!,
          repo: payload.repo as string | undefined,
          scopes: allowed,
          refs: normalizePolicies(payload.refs),
          keyId: row.id,
        };
      } catch {
        /* Try other current issuer keys; no token-controlled key URLs. */
      }
    }
  } catch {
    /* Invalid/untrusted claims are authentication failures. */
  }
  fail(401, "Invalid, expired or revoked JWT");
}
export function requireScope(
  auth: Delegation | undefined,
  scope: Scope,
  repo?: string,
) {
  if (!auth) return;
  if (!auth.scopes.includes(scope)) fail(403, "Required scope: " + scope);
  if (repo && auth.repo !== repo) fail(403, "JWT repository restriction");
}
