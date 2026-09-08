import test from "node:test";
import assert from "node:assert/strict";
import app from "../src/app";
import { fixture } from "./support/review-fixture";
import { digest } from "../src/security";
import { publishPackage } from "../src/packages";
async function setup() {
  const f = fixture(),
    tokens: Record<string, string> = {};
  for (const [label, user, scope] of [
    ["owner", "o", "write"],
    ["developer", "d", "write"],
    ["guest", "g", "write"],
    ["reader", "o", "read"],
  ]) {
    tokens[label] = "package-test-" + label;
    f.db
      .prepare(
        "INSERT INTO credentials(hash,id,user_id,name,kind,scope,expires_at) VALUES(?,?,?,?,'pat',?,?)",
      )
      .run(
        await digest(tokens[label]),
        label,
        user,
        label,
        scope,
        Date.now() + 600000,
      );
  }
  let duringGet = () => {},
    canceled = false;
  const data = new TextEncoder().encode("test-package-data"),
    objects = new Map<string, Uint8Array>();
  f.env.OBJECTS = {
    put: async (key: string) => {
      objects.set(key, data);
      return {};
    },
    delete: async (key: string) => {
      objects.delete(key);
    },
    get: async (key: string) => {
      if (!objects.has(key)) return null;
      duringGet();
      return {
        size: data.length,
        body: new ReadableStream({
          start(c) {
            c.enqueue(data);
          },
          cancel() {
            canceled = true;
          },
        }),
      };
    },
    head: async (key: string) =>
      objects.has(key) ? { size: data.length } : null,
  } as any;
  const result: any = await publishPackage(
    f.env,
    f.repo,
    { id: "o", credential: await digest(tokens.owner), revision: 0 },
    {
      kind: "generic",
      name: "demo",
      version: "1",
      filename: "demo.bin",
      size: data.length,
      sha256: await digest(data),
    },
    (key) => f.env.OBJECTS.put(key, data),
  );
  const base = "/api/repos/owner/repo/packages";
  const request = (
    suffix = "",
    who = "owner",
    method = "GET",
    body?: unknown,
  ) =>
    app.request(
      "http://localhost" + base + suffix,
      {
        method,
        headers: {
          Origin: "http://localhost",
          ...(who ? { Authorization: "Bearer " + (tokens[who] || who) } : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      { ...f.env, APP_ORIGIN: "http://localhost" },
      { waitUntil() {}, passThroughOnException() {} } as any,
    );
  return {
    ...f,
    tokens,
    result,
    request,
    onGet: (fn: () => void) => (duringGet = fn),
    canceled: () => canceled,
  };
}
test("package routes enforce private membership, read PAT scope, maintainer retirement and archived read-only behavior", async () => {
  const f = await setup();
  for (const who of ["owner", "developer", "reader"])
    assert.equal((await f.request("", who)).status, 200);
  assert.equal((await f.request("", "")).status, 401);
  assert.equal((await f.request("", "guest")).status, 404);
  assert.equal(
    (await f.request("/versions/" + f.result.version_id, "developer", "DELETE"))
      .status,
    403,
  );
  assert.equal(
    (await f.request("/versions/" + f.result.version_id, "reader", "DELETE"))
      .status,
    403,
  );
  f.db
    .prepare("UPDATE repositories SET archived_at=datetime('now') WHERE id='r'")
    .run();
  assert.equal(
    (await f.request("/versions/" + f.result.version_id, "owner", "DELETE"))
      .status,
    409,
  );
  assert.equal((await f.request("", "owner")).status, 200);
  f.db.prepare("UPDATE repositories SET archived_at=NULL WHERE id='r'").run();
  assert.equal(
    (await f.request("/versions/" + f.result.version_id, "owner", "DELETE"))
      .status,
    200,
  );
  assert.equal(
    (await f.request("/generic/demo/1/demo.bin", "owner")).status,
    404,
  );
});
test("package download rechecks role, credential, user, visibility and lifecycle after R2 I/O, canceling unread bytes", async () => {
  for (const mode of [
    "role",
    "credential",
    "disabled",
    "visibility",
    "transfer",
    "retired",
  ]) {
    const f = await setup();
    if (mode === "visibility")
      f.db
        .prepare("UPDATE repositories SET visibility='public' WHERE id='r'")
        .run();
    f.onGet(() => {
      if (mode === "role")
        f.db
          .prepare("DELETE FROM members WHERE repo_id='r' AND user_id='d'")
          .run();
      if (mode === "credential")
        f.db.prepare("DELETE FROM credentials WHERE id='developer'").run();
      if (mode === "disabled")
        f.db.prepare("UPDATE users SET disabled=1 WHERE id='d'").run();
      if (mode === "visibility")
        f.db
          .prepare("UPDATE repositories SET visibility='private' WHERE id='r'")
          .run();
      if (mode === "transfer")
        f.db
          .prepare(
            "UPDATE repositories SET lifecycle_revision=lifecycle_revision+1 WHERE id='r'",
          )
          .run();
      if (mode === "retired")
        f.db
          .prepare("UPDATE package_versions SET deleted_at=? WHERE id=?")
          .run(Date.now(), f.result.version_id);
    });
    const response = await f.request(
      "/generic/demo/1/demo.bin",
      mode === "visibility" ? "" : "developer",
    );
    assert.equal(response.status, 404, mode);
    assert.ok(f.canceled(), mode);
  }
});
test("public package routes keep explicit invalid credentials rejected and inherit workspace read membership", async () => {
  const f = await setup();
  f.db
    .prepare("UPDATE repositories SET visibility='public' WHERE id='r'")
    .run();
  assert.equal((await f.request("", "")).status, 200);
  assert.equal((await f.request("", "os_invalid")).status, 401);
  f.db.exec(
    "INSERT INTO workspaces(id,slug,name) VALUES('w','team','Team'); INSERT INTO workspace_members VALUES('w','g','reader'); UPDATE repositories SET workspace_id='w',visibility='private' WHERE id='r';",
  );
  assert.equal((await f.request("", "guest")).status, 200);
  assert.equal(
    (await f.request("/versions/" + f.result.version_id, "guest", "DELETE"))
      .status,
    403,
  );
});
