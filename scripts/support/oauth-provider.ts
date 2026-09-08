// Temporary GitLab-protocol acceptance server. Random credentials; delete after verification.
interface Env {
  IDP: DurableObjectNamespace;
  CLIENT_SECRET: string;
  TEST_PASSWORD: string;
}
const client = "onestorage-acceptance-v33";
const hash = async (s: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
const equal = async (a: string, b: string) => {
  const x = await hash(a),
    y = await hash(b);
  let n = 0;
  for (let i = 0; i < x.length; i++) n |= x.charCodeAt(i) ^ y.charCodeAt(i);
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
export class OAuthFixture {
  constructor(
    private ctx: DurableObjectState,
    private env: Env,
  ) {}
  async fetch(request: Request) {
    if (!this.env.CLIENT_SECRET || !this.env.TEST_PASSWORD)
      return new Response("Unconfigured fixture", { status: 503 });
    const url = new URL(request.url);
    if (url.pathname === "/oauth/authorize") {
      const q = url.searchParams;
      let callback: URL;
      try {
        callback = new URL(q.get("redirect_uri")!);
      } catch {
        return new Response("Invalid callback", { status: 400 });
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
        q.get("scope") !== "read_user" ||
        q.get("code_challenge_method") !== "S256" ||
        !q.get("state") ||
        !/^[A-Za-z0-9_-]{43}$/.test(q.get("code_challenge") || "")
      )
        return new Response("Invalid authorization", { status: 400 });
      if (request.method === "GET")
        return new Response(
          `<!doctype html><html><head><title>OneStorage OAuth protocol fixture</title></head><body><h1>GitLab OAuth protocol fixture</h1><form method="post" action="${esc(url.pathname + url.search)}"><label>Subject<input name="subject" required></label><label>Test password<input name="password" type="password" required></label><button>Authorize</button></form></body></html>`,
          {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
              "referrer-policy": "no-referrer",
            },
          },
        );
      if (request.method !== "POST")
        return new Response("Method not allowed", { status: 405 });
      const b = await request.formData(),
        subject = String(b.get("subject") || "");
      if (
        !/^[a-zA-Z0-9_-]{1,64}$/.test(subject) ||
        !(await equal(String(b.get("password") || ""), this.env.TEST_PASSWORD))
      )
        return new Response("Credential required", { status: 401 });
      const code = crypto.randomUUID();
      await this.ctx.storage.put("code:" + code, {
        subject,
        redirect: callback.href,
        challenge: q.get("code_challenge"),
        expires: Date.now() + 60000,
      });
      await this.ctx.storage.setAlarm(Date.now() + 120000);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", q.get("state")!);
      return Response.redirect(callback.href, 303);
    }
    if (url.pathname === "/oauth/token" && request.method === "POST") {
      const b = await request.formData();
      if (
        b.get("client_id") !== client ||
        !(await equal(
          String(b.get("client_secret") || ""),
          this.env.CLIENT_SECRET,
        ))
      )
        return new Response("Invalid client", { status: 401 });
      const record = await this.ctx.storage.transaction(async (s) => {
        const key = "code:" + b.get("code"),
          value = await s.get<any>(key);
        await s.delete(key);
        return value;
      });
      if (
        !record ||
        record.expires < Date.now() ||
        b.get("redirect_uri") !== record.redirect ||
        b.get("grant_type") !== "authorization_code"
      )
        return new Response("Invalid code", { status: 400 });
      const bytes = new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(String(b.get("code_verifier") || "")),
        ),
      );
      const challenge = btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      if (challenge !== record.challenge)
        return new Response("Invalid PKCE", { status: 400 });
      const token = crypto.randomUUID() + crypto.randomUUID();
      await this.ctx.storage.put("token:" + (await hash(token)), {
        subject: record.subject,
        expires: Date.now() + 300000,
      });
      await this.ctx.storage.setAlarm(Date.now() + 120000);
      return Response.json(
        { access_token: token, token_type: "bearer", expires_in: 300 },
        { headers: { "cache-control": "no-store" } },
      );
    }
    if (url.pathname === "/api/v4/user" && request.method === "GET") {
      const token =
          request.headers.get("authorization")?.replace(/^Bearer /, "") || "",
        record = await this.ctx.storage.get<any>(
          "token:" + (await hash(token)),
        );
      if (!record || record.expires < Date.now())
        return new Response("Unauthorized", { status: 401 });
      // The ID is stable; username varies on each lookup to exercise rename-safe identity.
      const id =
        Number.parseInt((await hash(record.subject)).slice(0, 12), 16) + 1;
      return Response.json(
        {
          id,
          username: record.subject + "-" + Date.now().toString(36),
          state: "active",
          locked: false,
          bot: false,
          email: "acceptance@example.test",
          confirmed_at: "2020-01-01T00:00:00Z",
        },
        { headers: { "cache-control": "no-store" } },
      );
    }
    return new Response("Not found", { status: 404 });
  }
  async alarm() {
    let pending = false;
    for (const [key, value] of await this.ctx.storage.list<any>()) {
      if (value.expires < Date.now()) await this.ctx.storage.delete(key);
      else pending = true;
    }
    if (pending) await this.ctx.storage.setAlarm(Date.now() + 120000);
  }
}
export default {
  fetch(request: Request, env: Env) {
    return env.IDP.get(env.IDP.idFromName("fixture")).fetch(request);
  },
};
