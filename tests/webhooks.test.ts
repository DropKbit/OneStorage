import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { consume, publishPending, signature } from "../src/webhooks.ts";
import type { Env } from "../src/types.ts";
function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of [
    "0001_initial.sql",
    "0002_webhooks.sql",
    "0003_delivery_lease.sql",
  ])
    sqlite.exec(
      readFileSync(new URL("../migrations/" + file, import.meta.url), "utf8"),
    );
  sqlite.exec(
    "INSERT INTO users(id,username,password) VALUES('u','owner','hash'); INSERT INTO repositories(id,owner_id,namespace,name,visibility) VALUES('r','u','owner','repo','private'); INSERT INTO webhooks(id,repo_id,url,secret) VALUES('h','r','https://hooks.example.com/events','signing-secret'); INSERT INTO deliveries(id,webhook_id,payload) VALUES('d','h','{\"event\":\"repo.commit\"}');",
  );
  const DB = {
    prepare(sql: string) {
      let values: any[] = [];
      const wrapped = {
        bind(...v: any[]) {
          values = v;
          return wrapped;
        },
        async first() {
          return sqlite.prepare(sql).get(...values) || null;
        },
        async run() {
          return sqlite.prepare(sql).run(...values);
        },
        async all() {
          return { results: sqlite.prepare(sql).all(...values) };
        },
      };
      return wrapped;
    },
  };
  const env = {
    DB,
    WEBHOOK_ALLOWED_HOSTS: "hooks.example.com",
  } as unknown as Env;
  const state = () =>
    sqlite.prepare("SELECT * FROM deliveries WHERE id=?").get("d")!;
  const message = () => {
    let ack = 0,
      retry = 0;
    return {
      body: { id: "d" },
      ack() {
        ack++;
      },
      retry() {
        retry++;
      },
      get acknowledged() {
        return ack;
      },
      get retried() {
        return retry;
      },
    };
  };
  return { env, state, message, sqlite };
}
const batch = (m: unknown) =>
  ({ messages: [m] }) as unknown as MessageBatch<{ id: string }>;
test("signed delivery is persisted and duplicate message does not redeliver", async () => {
  const f = fixture(),
    m = f.message();
  let calls = 0;
  const send = async (url: any, init: any) => {
    calls++;
    assert.equal(url, "https://hooks.example.com/events");
    assert.equal(init.redirect, "error");
    assert.equal(init.headers["X-OneStorage-Delivery"], "d");
    assert.equal(
      init.headers["X-OneStorage-Signature"],
      await signature(
        "signing-secret",
        init.headers["X-OneStorage-Timestamp"],
        init.body,
      ),
    );
    return new Response(null, { status: 204 });
  };
  await consume(batch(m), f.env, send as typeof fetch);
  assert.equal(f.state().state, "delivered");
  assert.equal(m.acknowledged, 1);
  await consume(batch(f.message()), f.env, send as typeof fetch);
  assert.equal(calls, 1);
  f.sqlite.close();
});
test("failed receiver retries, then remains inspectably failed after five attempts", async () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) {
    const m = f.message();
    await consume(
      batch(m),
      f.env,
      (async () => new Response(null, { status: 503 })) as typeof fetch,
    );
    assert.equal(m.retried, i < 4 ? 1 : 0);
  }
  assert.equal(f.state().state, "failed");
  assert.equal(f.state().attempts, 5);
  assert.equal(f.state().last_status, 503);
  f.sqlite.close();
});
test("lease prevents simultaneous duplicate deliveries", async () => {
  const f = fixture();
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((r) => (entered = r));
  const hold = new Promise<void>((r) => (release = r));
  let calls = 0;
  const send = (async () => {
    calls++;
    entered();
    await hold;
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const first = consume(batch(f.message()), f.env, send);
  await ready;
  const duplicate = f.message();
  await consume(batch(duplicate), f.env, send);
  assert.equal(duplicate.retried, 1);
  release();
  await first;
  assert.equal(calls, 1);
  f.sqlite.close();
});
test("queue publication failure leaves the durable outbox eligible for replay", async () => {
  const f = fixture();
  f.env.EVENTS = {
    send: async () => {
      throw Error("Queue unavailable");
    },
  } as unknown as Queue<{ id: string }>;
  await assert.rejects(() => publishPending(f.env), /Queue unavailable/);
  assert.equal(f.state().state, "pending");
  assert.equal(f.state().available_at, 0);
  f.sqlite.close();
});
test("revoked egress allowlist prevents HTTP delivery", async () => {
  const f = fixture();
  f.env.WEBHOOK_ALLOWED_HOSTS = "";
  let called = false;
  await consume(batch(f.message()), f.env, (async () => {
    called = true;
    return new Response();
  }) as typeof fetch);
  assert.equal(called, false);
  assert.equal(f.state().last_status, 0);
  f.sqlite.close();
});
