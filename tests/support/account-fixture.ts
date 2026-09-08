import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import app from "../../src/app";
import { digest, passwordHash } from "../../src/security";
import type { Env } from "../../src/types";
export async function accountFixture() {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync("migrations").sort())
    db.exec(readFileSync("migrations/" + file, "utf8"));
  const password = "fixture-password-123";
  db.prepare(
    "INSERT INTO users(id,username,password,admin) VALUES('u','person',?,1)",
  ).run(await passwordHash(password));
  db.prepare(
    "INSERT INTO credentials(hash,id,user_id,name,kind,expires_at) VALUES(?,'session-one','u','Browser','session',?)",
  ).run(await digest("fixture-session"), Date.now() + 3600000);
  let beforeBatch: (() => void) | undefined;
  const DB = {
    prepare(sql: string) {
      let values: any[] = [];
      return {
        bind(...v: any[]) {
          values = v;
          return this;
        },
        async first() {
          return db.prepare(sql).get(...values) || null;
        },
        async all() {
          return { results: db.prepare(sql).all(...values) };
        },
        execute() {
          const s = db.prepare(sql);
          if (/RETURNING/i.test(sql) || s.columns().length) {
            const results = s.all(...values);
            return {
              results,
              meta: {
                changes: Number(db.prepare("SELECT changes() AS n").get()!.n),
              },
            };
          }
          return { results: [], meta: s.run(...values) };
        },
        async run() {
          return this.execute();
        },
      };
    },
    async batch(statements: any[]) {
      const hook = beforeBatch;
      beforeBatch = undefined;
      hook?.();
      db.exec("BEGIN");
      try {
        const result = statements.map((s) => s.execute());
        db.exec("COMMIT");
        return result;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
  const env = {
      DB,
      APP_ORIGIN: "http://localhost",
      CREDENTIAL_ENCRYPTION_KEY: btoa("x".repeat(32)),
    } as unknown as Env,
    pending: Promise<any>[] = [];
  async function req(
    path: string,
    method = "GET",
    body?: unknown,
    cookie = "onestorage_session=fixture-session",
    headers: Record<string, string> = {},
  ) {
    const r = await app.fetch(
      new Request("http://localhost/api" + path, {
        method,
        headers: {
          Origin: "http://localhost",
          Cookie: cookie,
          ...(body ? { "content-type": "application/json" } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
      env,
      {
        waitUntil(p: Promise<any>) {
          pending.push(p);
        },
        passThroughOnException() {},
      } as any,
    );
    await Promise.all(pending.splice(0));
    const data = (await r.json()) as any;
    return {
      status: r.status,
      data,
      cookie: r.headers.get("set-cookie")?.split(";")[0] || "",
    };
  }
  return {
    db,
    env,
    req,
    password,
    race(fn: () => void) {
      beforeBatch = fn;
    },
  };
}
