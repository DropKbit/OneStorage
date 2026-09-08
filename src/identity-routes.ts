import { Hono, Context } from "hono";
import { importSPKI } from "jose";
import { z } from "zod";
import { algorithms } from "./delegation";
import { signingKeyInfo } from "./git/signatures";
import { fail, boundedBody } from "./security";
import type { App } from "./types";
export function registerIdentityRoutes(app: Hono<App>) {
  const live = `EXISTS(SELECT 1 FROM credentials c JOIN users u ON u.id=c.user_id
    WHERE c.hash=? AND c.user_id=? AND c.kind='session' AND c.expires_at>? AND u.disabled=0)`;
  const credential = (c: Context<App>) => [
    c.get("credential"),
    c.get("user")!.id,
    Date.now(),
  ];
  const session = (c: Context<App>) => {
    if (c.get("kind") !== "session" || !c.get("user"))
      fail(403, "Browser session required");
    return c.get("user")!;
  };
  const input = async (c: Context<App>) => {
    try {
      return JSON.parse(
        new TextDecoder().decode(await boundedBody(c.req.raw, 100000)),
      );
    } catch {
      fail(400, "Invalid JSON");
    }
  };
  for (const type of ["api-keys", "signing-keys"] as const) {
    const table = type === "api-keys" ? "api_keys" : "signing_keys";
    app.get("/api/" + type, async (c) => {
      const u = session(c);
      return c.json({
        keys: (
          await c.env.DB.prepare(
            `SELECT ${type === "api-keys" ? "id,name,algorithm,public_key,created_at" : "id,name,format,fingerprint,public_key,created_at"} FROM ${table} WHERE user_id=? ORDER BY created_at,id`,
          )
            .bind(u.id)
            .all()
        ).results,
        issuer: u.username,
      });
    });
    app.post("/api/" + type, async (c) => {
      const u = session(c),
        b = z
          .object({
            name: z.string().trim().min(1).max(100),
            public_key: z.string().min(1).max(65536),
            algorithm: z.enum(algorithms).optional(),
          })
          .parse(await input(c));
      const count = await c.env.DB.prepare(
        `SELECT count(*) AS n FROM ${table} WHERE user_id=?`,
      )
        .bind(u.id)
        .first<{ n: number }>();
      if ((count?.n || 0) >= 20) fail(400, "Maximum 20 keys per user");
      const id = crypto.randomUUID();
      if (type === "api-keys") {
        const alg = b.algorithm || "ES256";
        if (
          !b.public_key.startsWith("-----BEGIN PUBLIC KEY-----") ||
          b.public_key.includes("PRIVATE")
        )
          fail(400, "SPKI public key required");
        let key;
        try {
          key = await importSPKI(b.public_key, alg);
        } catch {
          fail(400, "Invalid API public key");
        }
        if (
          alg === "RS256" &&
          (key.algorithm as RsaKeyAlgorithm).modulusLength < 2048
        )
          fail(400, "RSA keys must be at least 2048 bits");
        const result = await c.env.DB.prepare(
          `INSERT INTO api_keys(id,user_id,name,algorithm,public_key) SELECT ?,?,?,?,? WHERE ${live}`,
        )
          .bind(id, u.id, b.name, alg, b.public_key, ...credential(c))
          .run();
        if (!result.meta.changes) fail(403, "Session changed; sign in again");
        return c.json({ id, issuer: u.username, algorithm: alg }, 201);
      }
      let info;
      try {
        info = await signingKeyInfo(b.public_key);
      } catch {
        fail(400, "Invalid or unsupported signing public key");
      }
      let result;
      try {
        result = await c.env.DB.prepare(
          `INSERT INTO signing_keys(id,user_id,name,format,public_key,fingerprint) SELECT ?,?,?,?,?,? WHERE ${live}`,
        )
          .bind(
            id,
            u.id,
            b.name,
            info.format,
            b.public_key,
            info.fingerprint,
            ...credential(c),
          )
          .run();
      } catch {
        fail(409, "Signing key already registered");
      }
      if (!result.meta.changes) fail(403, "Session changed; sign in again");
      return c.json({ id, ...info }, 201);
    });
    app.delete("/api/" + type + "/:id", async (c) => {
      const u = session(c);
      const result = await c.env.DB.prepare(
        `DELETE FROM ${table} WHERE id=? AND user_id=? AND ${live}`,
      )
        .bind(c.req.param("id"), u.id, ...credential(c))
        .run();
      if (
        !result.meta.changes &&
        !(await c.env.DB.prepare(`SELECT 1 WHERE ${live}`)
          .bind(...credential(c))
          .first())
      )
        fail(403, "Session changed; sign in again");
      return c.json({ deleted: true });
    });
  }
}
