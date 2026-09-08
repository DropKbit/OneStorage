import { z } from "zod";
import { endpoint, identityJSON } from "./identity-http";
import type { OIDCProvider, ProviderInput } from "./oidc";

interface OAuthConfig {
  protocol: "github" | "gitlab";
  auth_method: "client_secret_post" | "none";
  allowed_hosts: string[];
  email_domains: string[];
  authorization_endpoint: string;
  token_endpoint: string;
  user_endpoint: string;
  emails_endpoint?: string;
}
/** Fixed provider routes, no arbitrary userinfo URL or claim-to-role mapping. */
export function oauthConfig(input: ProviderInput): OAuthConfig {
  const protocol = input.protocol;
  if (protocol !== "github" && protocol !== "gitlab")
    throw Error("Unknown OAuth protocol");
  const canonical = endpoint(input.issuer, input.allowed_hosts),
    base = input.issuer.replace(/\/$/, "");
  if (canonical !== input.issuer && canonical !== input.issuer + "/")
    throw Error("Use canonical provider URL");
  if (
    input.auth_method !== "client_secret_post" &&
    !(protocol === "gitlab" && input.auth_method === "none")
  )
    throw Error(
      "OAuth client authentication must be POST; GitLab also supports public PKCE clients",
    );
  if (protocol === "github" && base !== "https://github.com")
    throw Error(
      "GitHub OAuth requires github.com; Enterprise deployments should use OIDC",
    );
  const approved = (url: string) => endpoint(url, input.allowed_hosts);
  return {
    protocol,
    auth_method: input.auth_method,
    allowed_hosts: input.allowed_hosts,
    email_domains: input.email_domains,
    authorization_endpoint: approved(
      base +
        (protocol === "github" ? "/login/oauth/authorize" : "/oauth/authorize"),
    ),
    token_endpoint: approved(
      base +
        (protocol === "github" ? "/login/oauth/access_token" : "/oauth/token"),
    ),
    user_endpoint: approved(
      protocol === "github"
        ? "https://api.github.com/user"
        : base + "/api/v4/user",
    ),
    ...(protocol === "github"
      ? { emails_endpoint: approved("https://api.github.com/user/emails") }
      : {}),
  };
}
function config(p: OIDCProvider) {
  const stored = JSON.parse(p.config) as OAuthConfig;
  // Derive again at use time: tokens must only reach routes on the pinned provider.
  return oauthConfig({
    ...stored,
    name: p.name,
    issuer: p.issuer,
    client_id: p.client_id,
    enabled: !!p.enabled,
    registration: !!p.registration,
  });
}
export function authorizeOAuth(
  p: OIDCProvider,
  state: string,
  challenge: string,
  redirect: string,
) {
  const cfg = config(p),
    u = new URL(cfg.authorization_endpoint);
  for (const [k, v] of Object.entries({
    response_type: "code",
    client_id: p.client_id,
    redirect_uri: redirect,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope:
      cfg.protocol === "github"
        ? "read:user" + (cfg.email_domains.length ? " user:email" : "")
        : "read_user",
  }))
    u.searchParams.set(k, v);
  return u.href;
}
function subject(value: unknown) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
    return String(value);
  if (typeof value === "string" && /^[1-9][0-9]{0,30}$/.test(value))
    return value;
  throw Error("OAuth provider returned an invalid stable user ID");
}
function allowedEmail(email: unknown, domains: string[]) {
  return (
    typeof email === "string" &&
    email.length <= 254 &&
    z.email().safeParse(email).success &&
    domains.includes(email.split("@")[1].toLowerCase())
  );
}
export async function exchangeOAuth(
  p: OIDCProvider,
  secret: string | null,
  code: string,
  verifier: string,
  redirect: string,
  send: typeof fetch,
) {
  const cfg = config(p),
    form = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: p.client_id,
      redirect_uri: redirect,
      code,
      code_verifier: verifier,
    });
  if (cfg.auth_method === "client_secret_post") {
    if (!secret) throw Error("OAuth client secret missing");
    form.set("client_secret", secret);
  }
  const token = await identityJSON(
    await send(cfg.token_endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        "user-agent": "OneStorage",
      },
      body: form,
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
    }),
  );
  if (
    token.error ||
    typeof token.access_token !== "string" ||
    !/^[\x21-\x7e]{1,8192}$/.test(token.access_token) ||
    typeof token.token_type !== "string" ||
    token.token_type.toLowerCase() !== "bearer"
  )
    throw Error("OAuth access token missing or invalid");
  const headers = {
    accept: "application/json",
    authorization: "Bearer " + token.access_token,
    "user-agent": "OneStorage",
    ...(cfg.protocol === "github"
      ? { "X-GitHub-Api-Version": "2022-11-28" }
      : {}),
  };
  const get = async (url: string) =>
    identityJSON(
      await send(url, {
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(10000),
      }),
    );
  const user = await get(cfg.user_endpoint),
    id = subject(user.id);
  if (
    cfg.protocol === "gitlab" &&
    (user.state !== "active" || user.locked === true || user.bot === true)
  )
    throw Error("GitLab account is not an active human account");
  if (cfg.protocol === "github" && user.type !== "User")
    throw Error("GitHub account is not a user");
  if (cfg.email_domains.length) {
    let allowed = false;
    if (cfg.protocol === "gitlab") {
      // /user is available with read_user. Only the confirmed primary email is used,
      // never public_email or unconfirmed_email (and never an email-based account link).
      allowed =
        typeof user.confirmed_at === "string" &&
        Number.isFinite(Date.parse(user.confirmed_at)) &&
        Date.parse(user.confirmed_at) <= Date.now() &&
        allowedEmail(user.email, cfg.email_domains);
    } else {
      for (let page = 1; page <= 5 && !allowed; page++) {
        const u = new URL(cfg.emails_endpoint!);
        u.searchParams.set("per_page", "100");
        u.searchParams.set("page", String(page));
        const emails = await get(u.href);
        if (!Array.isArray(emails) || emails.length > 100)
          throw Error("Invalid OAuth email list");
        allowed = emails.some(
          (e) =>
            e?.verified === true && allowedEmail(e.email, cfg.email_domains),
        );
        if (emails.length < 100) break;
      }
    }
    if (!allowed) throw Error("OAuth confirmed email domain is not allowed");
  }
  // Access/refresh tokens and provider admin flags are never persisted or returned.
  const name = cfg.protocol === "github" ? user.login : user.username;
  return {
    subject: id,
    suggested_username: typeof name === "string" ? name.slice(0, 48) : "",
  };
}
