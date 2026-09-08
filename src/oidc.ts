import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { z } from "zod";
import { endpoint, identityJSON as json } from "./identity-http";
export { endpoint } from "./identity-http";
import { oauthConfig, authorizeOAuth, exchangeOAuth } from "./oauth";

export const providerInput = z
  .object({
    protocol: z.enum(["oidc", "github", "gitlab"]).default("oidc"),
    name: z.string().trim().min(1).max(80),
    issuer: z.string().url().max(1000),
    client_id: z.string().min(1).max(512),
    client_secret: z.string().min(1).max(4096).optional(),
    auth_method: z
      .enum(["client_secret_basic", "client_secret_post", "none"])
      .default("client_secret_basic"),
    allowed_hosts: z
      .array(
        z
          .string()
          .max(253)
          .regex(/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/),
      )
      .min(1)
      .max(10),
    email_domains: z
      .array(
        z
          .string()
          .max(253)
          .regex(/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/),
      )
      .max(20)
      .default([]),
    enabled: z.boolean().default(false),
    registration: z.boolean().default(false),
    revision: z.number().int().positive().optional(),
  })
  .strict();
export type ProviderInput = z.infer<typeof providerInput>;
export interface OIDCConfig {
  protocol?: "oidc";
  auth_method: "client_secret_basic" | "client_secret_post" | "none";
  allowed_hosts: string[];
  email_domains: string[];
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}
export interface OIDCProvider {
  id: string;
  name: string;
  issuer: string;
  client_id: string;
  secret: string | null;
  config: string;
  enabled: number;
  registration: number;
  revision: number;
}
export async function discover(
  input: z.infer<typeof providerInput>,
  send: typeof fetch = globalThis.fetch.bind(globalThis),
) {
  if (input.protocol !== "oidc") return oauthConfig(input);
  const issuer = input.issuer,
    canonical = endpoint(issuer, input.allowed_hosts);
  if (canonical !== issuer && canonical !== issuer + "/")
    throw Error("Use the canonical issuer URL");
  const data = await json(
    await send(
      issuer.replace(/\/$/, "") + "/.well-known/openid-configuration",
      { redirect: "manual", signal: AbortSignal.timeout(10000) },
    ),
  );
  if (
    data.issuer !== issuer ||
    !data.response_types_supported?.includes("code") ||
    !data.subject_types_supported?.some((s: string) =>
      ["public", "pairwise"].includes(s),
    )
  )
    throw Error("OIDC discovery issuer/code support mismatch");
  if (
    data.code_challenge_methods_supported &&
    !data.code_challenge_methods_supported.includes("S256")
  )
    throw Error("OIDC provider must support PKCE S256");
  if (
    data.token_endpoint_auth_methods_supported &&
    !data.token_endpoint_auth_methods_supported.includes(input.auth_method)
  )
    throw Error("Unsupported OIDC client authentication method");
  return {
    protocol: "oidc" as const,
    auth_method: input.auth_method,
    allowed_hosts: input.allowed_hosts,
    email_domains: input.email_domains,
    authorization_endpoint: endpoint(
      data.authorization_endpoint,
      input.allowed_hosts,
    ),
    token_endpoint: endpoint(data.token_endpoint, input.allowed_hosts),
    jwks_uri: endpoint(data.jwks_uri, input.allowed_hosts),
  };
}
export async function pkce(verifier: string) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
export function authorize(
  p: OIDCProvider,
  state: string,
  nonce: string,
  challenge: string,
  redirect: string,
) {
  if ((JSON.parse(p.config).protocol || "oidc") !== "oidc")
    return authorizeOAuth(p, state, challenge, redirect);
  const cfg = JSON.parse(p.config) as OIDCConfig;
  const u = new URL(endpoint(cfg.authorization_endpoint, cfg.allowed_hosts));
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: p.client_id,
    redirect_uri: redirect,
    scope: "openid email profile",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }))
    u.searchParams.set(key, value);
  return u.href;
}
export async function exchange(
  p: OIDCProvider,
  secret: string | null,
  code: string,
  verifier: string,
  nonce: string,
  redirect: string,
  send: typeof fetch = globalThis.fetch.bind(globalThis),
) {
  if ((JSON.parse(p.config).protocol || "oidc") !== "oidc")
    return exchangeOAuth(p, secret, code, verifier, redirect, send);
  const cfg = JSON.parse(p.config) as OIDCConfig;
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirect,
    code_verifier: verifier,
  });
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  if (cfg.auth_method === "client_secret_basic") {
    if (!secret) throw Error("OIDC client secret missing");
    const encode = (s: string) =>
      new URLSearchParams({ x: s }).toString().slice(2);
    headers.authorization =
      "Basic " + btoa(encode(p.client_id) + ":" + encode(secret));
  } else {
    form.set("client_id", p.client_id);
    if (cfg.auth_method === "client_secret_post") {
      if (!secret) throw Error("OIDC client secret missing");
      form.set("client_secret", secret);
    }
  }
  const token = await json(
    await send(endpoint(cfg.token_endpoint, cfg.allowed_hosts), {
      method: "POST",
      headers,
      body: form,
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
    }),
  );
  if (typeof token.id_token !== "string" || token.id_token.length > 32768)
    throw Error("OIDC ID token missing or too large");
  const jwks = (await json(
    await send(endpoint(cfg.jwks_uri, cfg.allowed_hosts), {
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
    }),
  )) as JSONWebKeySet;
  if (
    !Array.isArray(jwks.keys) ||
    !jwks.keys.length ||
    jwks.keys.length > 16 ||
    jwks.keys.some((k) => k.d || k.k)
  )
    throw Error("Invalid OIDC public key set");
  const { payload } = await jwtVerify(token.id_token, createLocalJWKSet(jwks), {
    issuer: p.issuer,
    audience: p.client_id,
    algorithms: ["RS256", "ES256", "EdDSA"],
    requiredClaims: ["sub", "exp", "iat", "nonce"],
    maxTokenAge: "10m",
    clockTolerance: 30,
  });
  if (
    payload.nonce !== nonce ||
    typeof payload.sub !== "string" ||
    !payload.sub ||
    payload.sub.length > 255 ||
    (payload.azp !== undefined && payload.azp !== p.client_id) ||
    (Array.isArray(payload.aud) &&
      payload.aud.length > 1 &&
      payload.azp !== p.client_id)
  )
    throw Error("OIDC subject, nonce or authorized party mismatch");
  const email =
    typeof payload.email === "string" && payload.email.length <= 254
      ? payload.email
      : "";
  if (
    cfg.email_domains.length &&
    (payload.email_verified !== true ||
      email.split("@").length !== 2 ||
      !cfg.email_domains.includes(email.split("@")[1].toLowerCase()))
  )
    throw Error("OIDC verified email domain is not allowed");
  return {
    subject: payload.sub,
    suggested_username:
      typeof payload.preferred_username === "string"
        ? payload.preferred_username.slice(0, 48)
        : "",
  };
}
