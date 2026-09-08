import test from "node:test";
import assert from "node:assert/strict";
import { oauthConfig, authorizeOAuth, exchangeOAuth } from "../src/oauth";
import { providerInput, pkce, type OIDCProvider } from "../src/oidc";
function provider(
  protocol: "github" | "gitlab" = "github",
  domains: string[] = [],
) {
  const input = providerInput.parse({
    protocol,
    name: protocol,
    issuer:
      protocol === "github"
        ? "https://github.com"
        : "https://gitlab.example.com/forge",
    client_id: "client",
    auth_method: "client_secret_post",
    allowed_hosts:
      protocol === "github"
        ? ["github.com", "api.github.com"]
        : ["gitlab.example.com"],
    email_domains: domains,
  });
  return {
    input,
    p: {
      id: "p",
      name: protocol,
      issuer: input.issuer,
      client_id: "client",
      secret: "sealed",
      config: JSON.stringify(oauthConfig(input)),
      enabled: 1,
      registration: 1,
      revision: 1,
    } as OIDCProvider,
  };
}
const verifier = "x".repeat(64),
  redirect = "https://git.example.com/api/auth/oidc/callback";
test("OAuth configurations pin protocol endpoints and reject foreign hosts, HTTP and unsupported client modes", () => {
  const { input, p } = provider();
  assert.equal(
    JSON.parse(p.config).user_endpoint,
    "https://api.github.com/user",
  );
  for (const patch of [
    { issuer: "https://evil.example.com", allowed_hosts: ["evil.example.com"] },
    { allowed_hosts: ["github.com"] },
    { auth_method: "none" },
    { issuer: "http://github.com" },
  ])
    assert.throws(() => oauthConfig({ ...input, ...patch } as any));
  const gitlab = provider("gitlab");
  assert.equal(
    JSON.parse(gitlab.p.config).token_endpoint,
    "https://gitlab.example.com/forge/oauth/token",
  );
  assert.equal(
    oauthConfig({ ...gitlab.input, auth_method: "none" }).auth_method,
    "none",
  );
});
test("GitHub OAuth code exchange uses PKCE, fixed HTTPS user API and stable ID; tokens and admin flags stay private", async () => {
  const { p } = provider();
  const u = new URL(authorizeOAuth(p, "state", await pkce(verifier), redirect));
  assert.equal(u.searchParams.get("scope"), "read:user");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("state"), "state");
  assert.equal(u.searchParams.has("nonce"), false);
  const calls: string[] = [];
  const send = async (url: any, options: any) => {
    calls.push(String(url));
    assert.equal(options.redirect, "manual");
    if (calls.length === 1) {
      const form = new URLSearchParams(options.body);
      assert.equal(form.get("client_secret"), "private");
      assert.equal(form.get("code_verifier"), verifier);
      assert.equal(form.get("redirect_uri"), redirect);
      return Response.json({
        access_token: "opaque",
        token_type: "bearer",
        refresh_token: "private-refresh",
      });
    }
    assert.equal(
      new Headers(options.headers).get("authorization"),
      "Bearer opaque",
    );
    return Response.json({
      id: 4242,
      login: "renamed",
      type: "User",
      site_admin: true,
      email: "irrelevant@example.com",
    });
  };
  const identity = await exchangeOAuth(
    p,
    "private",
    "one-time",
    verifier,
    redirect,
    send as any,
  );
  assert.deepEqual(identity, {
    subject: "4242",
    suggested_username: "renamed",
  });
  assert.equal(calls.length, 2);
});
test("GitHub email restriction requires verified exact domains, scans bounded pages, and never follows provider links", async () => {
  const { p } = provider("github", ["company.example"]);
  assert.equal(
    new URL(authorizeOAuth(p, "s", "c", redirect)).searchParams.get("scope"),
    "read:user user:email",
  );
  let emails: any[] = [{ email: "person@company.example", verified: false }],
    page2 = false;
  const send = async (url: any) => {
    const u = new URL(url);
    if (u.pathname.endsWith("access_token"))
      return Response.json({ access_token: "opaque", token_type: "Bearer" });
    if (u.pathname === "/user") return Response.json({ id: 1, type: "User" });
    assert.equal(u.origin, "https://api.github.com");
    if (u.searchParams.get("page") === "2") {
      page2 = true;
      return Response.json([
        { email: "person@COMPANY.EXAMPLE", verified: true },
      ]);
    }
    return Response.json(emails, {
      headers: { Link: '<https://evil.example/api>; rel="next"' },
    });
  };
  await assert.rejects(
    exchangeOAuth(p, "s", "c", verifier, redirect, send as any),
    /email domain/,
  );
  emails = Array.from({ length: 100 }, () => ({
    email: "other@untrusted.example",
    verified: true,
  }));
  await exchangeOAuth(p, "s", "c", verifier, redirect, send as any);
  assert.equal(page2, true);
});
test("GitLab accepts only active human accounts and a confirmed primary email when domain-restricted", async () => {
  const { p } = provider("gitlab", ["company.example"]);
  let user: any = {
    id: 44,
    username: "person",
    state: "active",
    confirmed_at: "2020-01-01T00:00:00Z",
    email: "person@company.example",
  };
  const send = async (url: any) =>
    Response.json(
      String(url).endsWith("/oauth/token")
        ? { access_token: "opaque", token_type: "bearer" }
        : user,
    );
  assert.equal(
    (await exchangeOAuth(p, "s", "c", verifier, redirect, send as any)).subject,
    "44",
  );
  const base = { ...user };
  for (const patch of [
    { state: "blocked" },
    { locked: true },
    { bot: true },
    { confirmed_at: null },
    { email: "other@evil.example", public_email: "person@company.example" },
    { id: 9007199254740992 },
  ]) {
    user = { ...base, ...patch };
    await assert.rejects(
      exchangeOAuth(p, "s", "c", verifier, redirect, send as any),
    );
  }
});
test("OAuth denies malformed tokens, non-user responses, redirects and oversized provider JSON", async () => {
  const { p } = provider();
  for (const token of [
    { access_token: "opaque", token_type: "mac" },
    { access_token: "bad\nvalue", token_type: "bearer" },
    { error: "denied", access_token: "opaque", token_type: "bearer" },
  ])
    await assert.rejects(
      exchangeOAuth(p, "s", "c", verifier, redirect, (async () =>
        Response.json(token)) as any),
    );
  for (const user of [
    { id: 1, type: "Organization" },
    { id: "username", type: "User" },
    { id: 0, type: "User" },
  ])
    await assert.rejects(
      exchangeOAuth(p, "s", "c", verifier, redirect, (async (url: any) =>
        Response.json(
          String(url).endsWith("access_token")
            ? { access_token: "opaque", token_type: "bearer" }
            : user,
        )) as any),
    );
  await assert.rejects(
    exchangeOAuth(p, "s", "c", verifier, redirect, (async () =>
      Response.redirect("https://evil.example")) as any),
  );
  await assert.rejects(
    exchangeOAuth(
      p,
      "s",
      "c",
      verifier,
      redirect,
      (async () => new Response('"' + "x".repeat(65537) + '"')) as any,
    ),
  );
});
