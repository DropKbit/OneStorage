// Temporary acceptance IdP. Deploy only with random test credentials, then delete.
import { importJWK, SignJWT } from "jose";
interface Env {
  IDP: DurableObjectNamespace;
  CLIENT_SECRET: string;
  TEST_PASSWORD: string;
  PRIVATE_JWK: string;
  PUBLIC_JWK: string;
}
const client = "onestorage-acceptance-v23";
const equal = async (a: string, b: string) => {
  const hash = async (s: string) =>
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
    );
  const x = await hash(a),
    y = await hash(b);
  let n = 0;
  for (let i = 0; i < x.length; i++) n |= x[i] ^ y[i];
  return n === 0;
};
const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export class IdentityFixture {
  constructor(
    private ctx: DurableObjectState,
    private env: Env,
  ) {}
  async fetch(request: Request) {
    const url = new URL(request.url),
      issuer = url.origin;
    if (url.pathname === "/.well-known/openid-configuration")
      return Response.json({
        issuer,
        authorization_endpoint: issuer + "/authorize",
        token_endpoint: issuer + "/token",
        jwks_uri: issuer + "/jwks",
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic"],
        id_token_signing_alg_values_supported: ["ES256"],
      });
    if (url.pathname === "/jwks")
      return Response.json({ keys: [JSON.parse(this.env.PUBLIC_JWK)] });
    if (url.pathname === "/authorize") {
      const q = url.searchParams;
      let callback: URL;
      try {
        callback = new URL(q.get("redirect_uri")!);
      } catch {
        return new Response("Bad redirect", { status: 400 });
      }
      if (
        !["http://localhost:8787", "https://git.1s.hk"].includes(
          callback.origin,
        ) ||
        callback.pathname !== "/api/auth/oidc/callback" ||
        callback.search ||
        callback.hash ||
        q.get("client_id") !== client ||
        q.get("response_type") !== "code" ||
        q.get("code_challenge_method") !== "S256" ||
        !q.get("nonce") ||
        !q.get("state")
      )
        return new Response("Invalid authorization", { status: 400 });
      if (request.method === "GET")
        return new Response(
          `<!doctype html><html><head><title>OneStorage test identity provider</title></head><body><h1>Test identity provider</h1><form method="post" action="${esc(url.pathname + url.search)}"><label>Subject<input name="subject" value="acceptance-user" required></label><label>Test password<input name="password" type="password" required></label><button>Authorize</button></form></body></html>`,
          {
            headers: {
              "content-type": "text/html;charset=utf-8",
              "cache-control": "no-store",
              "referrer-policy": "no-referrer",
              "content-security-policy": `default-src 'none'; form-action 'self' ${callback.origin}; base-uri 'none'; frame-ancestors 'none'`,
            },
          },
        );
      if (request.method !== "POST")
        return new Response("Method not allowed", { status: 405 });
      const body = await request.formData(),
        subject = String(body.get("subject") || "");
      if (
        !subject ||
        subject.length > 100 ||
        !(await equal(
          String(body.get("password") || ""),
          this.env.TEST_PASSWORD,
        ))
      )
        return new Response("Test credential required", { status: 401 });
      const code = crypto.randomUUID();
      await this.ctx.storage.put("code:" + code, {
        redirect: callback.href,
        challenge: q.get("code_challenge"),
        nonce: q.get("nonce"),
        subject,
        expires: Date.now() + 60000,
      });
      await this.ctx.storage.setAlarm(Date.now() + 120000);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", q.get("state")!);
      callback.searchParams.set("iss", issuer);
      return Response.redirect(callback.href, 303);
    }
    if (url.pathname === "/token" && request.method === "POST") {
      if (
        !(await equal(
          request.headers.get("authorization") || "",
          "Basic " + btoa(client + ":" + this.env.CLIENT_SECRET),
        ))
      )
        return new Response("Unauthorized client", { status: 401 });
      const body = await request.formData(),
        code = String(body.get("code") || "");
      const record = await this.ctx.storage.transaction(async (storage) => {
        const data = await storage.get<any>("code:" + code);
        await storage.delete("code:" + code);
        return data;
      });
      if (
        !record ||
        record.expires < Date.now() ||
        body.get("redirect_uri") !== record.redirect ||
        body.get("grant_type") !== "authorization_code"
      )
        return new Response("Invalid code", { status: 400 });
      const bytes = new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(String(body.get("code_verifier") || "")),
        ),
      );
      const challenge = btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      if (challenge !== record.challenge)
        return new Response("Invalid PKCE", { status: 400 });
      const key = await importJWK(JSON.parse(this.env.PRIVATE_JWK), "ES256");
      const token = await new SignJWT({
        nonce: record.nonce,
        email: "acceptance@example.test",
        email_verified: true,
        preferred_username: record.subject,
      })
        .setProtectedHeader({ alg: "ES256", kid: "fixture" })
        .setIssuer(issuer)
        .setSubject(record.subject)
        .setAudience(client)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(key);
      return Response.json(
        {
          id_token: token,
          access_token: crypto.randomUUID(),
          token_type: "Bearer",
          expires_in: 300,
        },
        { headers: { "cache-control": "no-store" } },
      );
    }
    return new Response("Not found", { status: 404 });
  }
  async alarm() {
    for (const [key, value] of await this.ctx.storage.list<any>({
      prefix: "code:",
    }))
      if (value.expires < Date.now()) await this.ctx.storage.delete(key);
  }
}
export default {
  fetch(request: Request, env: Env) {
    return env.IDP.get(env.IDP.idFromName("fixture")).fetch(request);
  },
};
