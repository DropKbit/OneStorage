import test from "node:test";
import assert from "node:assert/strict";
import app from "../src/app";
import { fixture } from "./support/review-fixture";
import { digest } from "../src/security";

test("a committed native push response is not replaced by a failing subsequent D1 audit write", async () => {
  const f = fixture(),
    token = "receipt-test-token";
  f.db
    .prepare(
      "INSERT INTO credentials(hash,id,user_id,name,kind,scope,expires_at) VALUES(?,'receipt','o','test','pat','write',?)",
    )
    .run(await digest(token), Date.now() + 600000);
  let committed = false,
    afterCommitWrites = 0;
  const env = {
    ...f.env,
    APP_ORIGIN: "http://localhost",
    DB: {
      ...f.env.DB,
      batch: async (...args: any[]) => {
        if (committed) {
          afterCommitWrites++;
          throw Error("D1_ERROR: simulated unavailable audit storage");
        }
        return (f.env.DB.batch as any)(...args);
      },
    },
    REPOSITORIES: {
      idFromName: () => "r",
      get: () => ({
        fetch: async (request: Request) => {
          assert.equal(request.headers.get("x-actor-id"), "o");
          committed = true;
          return new Response("000eunpack ok\n0000", {
            headers: {
              "content-type": "application/x-git-receive-pack-result",
            },
          });
        },
      }),
    },
  } as any;
  const response = await app.request(
    "http://localhost/owner/repo.git/git-receive-pack",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "x-actor-id": "spoofed-user",
        "content-type": "application/x-git-receive-pack-request",
      },
    },
    env,
    { waitUntil() {}, passThroughOnException() {} } as any,
  );
  assert.equal(committed, true);
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") || "",
    /git-receive-pack-result/,
  );
  assert.equal(afterCommitWrites, 0);
});

import {
  putRefPublication,
  assertGitReceiptCapacity,
  stageGitReceipt,
  projectGitReceipt,
  drainGitReceipts,
  RECEIPT_LIMIT,
  type GitReceipt,
} from "../src/git/receipts";
import { GitRepository } from "../src/git/repository";
import { receive } from "../src/git/protocol";
import { concat, ZERO } from "../src/git/objects";
import { pkt, FLUSH } from "../src/git/pkt";
function durable() {
  const values = new Map<string, any>(),
    alarms: number[] = [];
  const storage = {
    get: async (key: string) => structuredClone(values.get(key)),
    put: async (input: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(structuredClone(input)))
        values.set(key, value);
    },
    list: async ({ prefix, limit }: any) =>
      new Map(
        [...values].filter(([key]) => key.startsWith(prefix)).slice(0, limit),
      ),
    delete: async (key: string) => values.delete(key),
    setAlarm: async (at: number) => {
      alarms.push(at);
    },
  } as unknown as DurableObjectStorage;
  return { storage, values, alarms };
}
async function committed() {
  const f = fixture(),
    d = durable(),
    sha = await f.commit({ "test.txt": "accepted source" });
  let receipt: GitReceipt | undefined;
  const repo = new GitRepository(
    f.store,
    {
      get: (key) => d.storage.get(key),
      put: async (key, value) => {
        const values: Record<string, unknown> = { [key]: value };
        receipt = await stageGitReceipt(
          d.storage,
          values,
          { repository_id: "r", actor_id: "o" },
          1,
        );
        await d.storage.setAlarm(Date.now() + 1000);
        await d.storage.put(values);
      },
    },
    {},
    "main",
  );
  const response = await receive(
    repo,
    concat(pkt(`${ZERO} ${sha} refs/heads/main\0report-status\n`), FLUSH),
  );
  assert.equal(response.status, 200);
  assert.match(await response.text(), /ok refs\/heads\/main/);
  return { ...f, ...d, receipt: receipt!, sha };
}
test("native protocol success leaves an atomic ref/receipt even when D1 is down; alarm recovery projects it once", async () => {
  const f = await committed();
  assert.equal(f.values.get("refs.v2")["refs/heads/main"], f.sha);
  assert.ok(f.values.has("git-receipt:" + f.receipt.id));
  assert.equal(f.db.prepare("SELECT count(*) n FROM audit").get()!.n, 0);
  const down = {
    ...f.env,
    DB: {
      prepare: () => {
        throw Error("D1_ERROR: unavailable");
      },
    },
  } as any;
  assert.deepEqual(await drainGitReceipts(down, f.storage), {
    pending: true,
    failed: true,
  });
  assert.ok(f.alarms.at(-1)! > Date.now() + 29000);
  assert.ok(f.values.has("git-receipt:" + f.receipt.id));
  assert.deepEqual(await drainGitReceipts(f.env, f.storage), {
    pending: false,
    failed: false,
  });
  const audit = f.db
    .prepare("SELECT * FROM audit WHERE event_id=?")
    .get(f.receipt.id)!;
  assert.equal(audit.actor_id, "o");
  assert.equal(audit.action, "git.receive_pack");
  assert.equal(JSON.parse(String(audit.detail)).refs_updated, 1);
  assert.equal(f.values.has("git-receipt:" + f.receipt.id), false);
});
test("uncertain D1 commit or DO acknowledgement cannot duplicate an audit or watcher notification", async () => {
  const f = await committed();
  f.db.exec("INSERT INTO repository_watches(repo_id,user_id) VALUES('r','d')");
  const db = f.env.DB;
  const uncertain = {
    ...f.env,
    DB: {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => ({
          run: async () => {
            await db
              .prepare(sql)
              .bind(...values)
              .run();
            throw Error("D1_ERROR: lost acknowledgement");
          },
        }),
      }),
    },
  } as any;
  assert.equal((await drainGitReceipts(uncertain, f.storage)).failed, true);
  assert.equal(
    f.db
      .prepare("SELECT count(*) n FROM audit WHERE event_id=?")
      .get(f.receipt.id)!.n,
    1,
  );
  const failedDelete = {
    ...f.storage,
    delete: async () => {
      throw Error("temporary storage failure");
    },
  } as any;
  assert.equal((await drainGitReceipts(f.env, failedDelete)).failed, true);
  await drainGitReceipts(f.env, f.storage);
  assert.equal(
    f.db
      .prepare("SELECT count(*) n FROM audit WHERE event_id=?")
      .get(f.receipt.id)!.n,
    1,
  );
  assert.equal(
    f.db
      .prepare(
        "SELECT count(*) n FROM notifications WHERE user_id='d' AND action='git.receive_pack'",
      )
      .get()!.n,
    1,
  );
});
test("publication failure and a full backlog reject the native ref update without claiming acceptance", async () => {
  for (const mode of ["full", "publication-failure"]) {
    const f = fixture(),
      d = durable(),
      sha = await f.commit({ "test.txt": mode });
    if (mode === "full")
      for (let i = 0; i < RECEIPT_LIMIT; i++)
        d.values.set("git-receipt:" + i, {});
    const repo = new GitRepository(
      f.store,
      {
        get: (key) => d.storage.get(key),
        put: async (key, value) => {
          const values = { [key]: value };
          await stageGitReceipt(
            d.storage,
            values,
            { repository_id: "r", actor_id: "o" },
            1,
          );
          throw Error("atomic publication unavailable");
        },
      },
      {},
      "main",
    );
    const response = await receive(
      repo,
      concat(pkt(`${ZERO} ${sha} refs/heads/main\0report-status\n`), FLUSH),
    );
    assert.match(await response.text(), /ng refs\/heads\/main/);
    assert.equal(d.values.has("refs.v2"), false);
    assert.equal(
      [...d.values.keys()].filter((k) => k.startsWith("git-receipt:")).length,
      mode === "full" ? RECEIPT_LIMIT : 0,
    );
    if (mode === "full")
      await assert.rejects(assertGitReceiptCapacity(d.storage), /backlog full/);
  }
});
test("no-op publication creates no receipt; bounded delivery preserves historical actors and current project identity", async () => {
  const f = fixture(),
    d = durable(),
    values = {};
  assert.equal(
    await stageGitReceipt(
      d.storage,
      values,
      { repository_id: "r", actor_id: "o" },
      0,
    ),
    undefined,
  );
  assert.deepEqual(values, {});
  const records = [];
  for (let i = 0; i < 23; i++) {
    const v = {};
    const receipt = (await stageGitReceipt(
      d.storage,
      v,
      { repository_id: "r", actor_id: "o" },
      2,
    ))!;
    records.push(receipt);
    await d.storage.put(v);
  }
  f.db.exec(
    "UPDATE users SET disabled=1 WHERE id='o';UPDATE repositories SET namespace='changed',name='renamed',archived_at=datetime('now') WHERE id='r'",
  );
  assert.deepEqual(await drainGitReceipts(f.env, d.storage), {
    pending: true,
    failed: false,
  });
  assert.equal(
    f.db
      .prepare("SELECT count(*) n FROM audit WHERE event_id IS NOT NULL")
      .get()!.n,
    20,
  );
  assert.equal([...d.values.keys()].length, 3);
  await drainGitReceipts(f.env, d.storage);
  assert.equal(
    f.db
      .prepare("SELECT count(*) n FROM audit WHERE event_id IS NOT NULL")
      .get()!.n,
    23,
  );
  assert.equal(
    f.db
      .prepare("SELECT actor_id FROM audit WHERE event_id=?")
      .get(records[0].id)!.actor_id,
    "o",
  );
  await projectGitReceipt(f.env, {
    ...records[0],
    id: crypto.randomUUID(),
    actor_id: "missing",
  });
  await projectGitReceipt(f.env, {
    ...records[0],
    id: crypto.randomUUID(),
    repository_id: "removed",
  });
  assert.equal(
    f.db
      .prepare("SELECT count(*) n FROM audit WHERE event_id IS NOT NULL")
      .get()!.n,
    24,
  );
});

test("large atomic publications split storage calls without exposing partial refs or receipts", async () => {
  for (const failSecond of [false, true]) {
    const committed = new Map<string, unknown>();
    let calls = 0;
    const values: Record<string, unknown> = {
      "refs.v2": { "refs/heads/main": "new-sha" },
      "git-receipt:test": { id: "test" },
    };
    for (let i = 0; i < 129; i++)
      values["event:" + i] = { ref: "refs/heads/" + i };
    const storage = {
      put: async () => {
        throw Error("large writes require transaction");
      },
      transaction: async (callback: any) => {
        const pending = new Map();
        await callback({
          put: async (part: Record<string, unknown>) => {
            assert.ok(Object.keys(part).length <= 128);
            calls++;
            assert.equal(committed.size, 0);
            if (failSecond && calls === 2)
              throw Error("transaction write failed");
            for (const [key, value] of Object.entries(part))
              pending.set(key, value);
          },
        });
        for (const [key, value] of pending) committed.set(key, value);
      },
    } as any;
    if (failSecond) {
      await assert.rejects(
        putRefPublication(storage, values),
        /transaction write failed/,
      );
      assert.equal(committed.size, 0);
    } else {
      await putRefPublication(storage, values);
      assert.equal(committed.size, 131);
      assert.ok(committed.has("refs.v2") && committed.has("git-receipt:test"));
    }
    assert.equal(calls, 2);
  }
});

import { confirmGitResponse } from "../src/git/confirmation";
import { HTTPException } from "hono/http-exception";
test("gateway transport failures preserve commit uncertainty with private incident diagnostics; protocol responses pass through", async () => {
  const original = new Response("report-status", { status: 200 });
  assert.equal(await confirmGitResponse("r", async () => original), original);
  const rejected = new Response("DO rejection", {
    status: 503,
    headers: { "X-OneStorage-Incident": "existing" },
  });
  assert.equal(await confirmGitResponse("r", async () => rejected), rejected);
  const response = await confirmGitResponse("r", async () => {
    throw Object.assign(Error("provider-secret-marker"), {
      remote: true,
      retryable: true,
    });
  });
  assert.equal(response.status, 503);
  const body: any = await response.json();
  assert.match(body.error, /inspect remote refs/);
  assert.equal(response.headers.get("X-OneStorage-Incident"), body.incident_id);
  assert.equal(JSON.stringify(body).includes("provider-secret-marker"), false);
  await assert.rejects(
    confirmGitResponse("r", async () => {
      throw new HTTPException(403, { message: "Forbidden" });
    }),
    /Forbidden/,
  );
});
