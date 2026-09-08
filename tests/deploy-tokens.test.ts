import test from "node:test";
import assert from "node:assert/strict";
import app from "../src/app";
import { fixture } from "./support/review-fixture";
import { digest } from "../src/security";
import {
  assertDeployAccess,
  assertDeployGitRequest,
  resolveDeployToken,
} from "../src/deploy-tokens";
import { publishPackage } from "../src/packages";
async function setup() {
  const f = fixture(),
    keys: Record<string, string> = {};
  for (const [name, user, scope] of [
    ["owner", "o", "write"],
    ["author", "a", "write"],
    ["developer", "d", "write"],
    ["reader", "o", "read"],
  ]) {
    keys[name] = "deploy-manager-" + name;
    f.db
      .prepare(
        "INSERT INTO credentials(hash,id,user_id,name,kind,scope,expires_at) VALUES(?,?,?,?,'pat',?,?)",
      )
      .run(
        await digest(keys[name]),
        name,
        user,
        name,
        scope,
        Date.now() + 600000,
      );
  }
  const pending: Promise<unknown>[] = [];
  const request = async (
    path: string,
    method = "GET",
    body?: unknown,
    token = keys.owner,
    headers: Record<string, string> = {},
  ) => {
    const response = await app.request(
      "http://localhost" + path,
      {
        method,
        headers: {
          Origin: "http://localhost",
          Authorization: "Bearer " + token,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      { ...f.env, APP_ORIGIN: "http://localhost" },
      {
        waitUntil(p: Promise<unknown>) {
          pending.push(p);
        },
        passThroughOnException() {},
      } as any,
    );
    await Promise.all(pending.splice(0));
    return response;
  };
  const base = "/api/repos/owner/repo/deploy-tokens",
    create = async (
      scopes = [
        "read_repository",
        "read_package_registry",
        "write_package_registry",
      ],
    ) => {
      const response = await request(base, "POST", {
        name: "Builder",
        scopes,
        days: 1,
      });
      assert.equal(response.status, 201, await response.clone().text());
      return response.json() as Promise<any>;
    };
  return { ...f, request, base, create, keys };
}
test("deploy token management is scoped, secret-once, versioned, and enforces current manager credentials", async () => {
  const f = await setup();
  for (const who of ["developer", "reader"])
    assert.equal(
      (
        await f.request(
          f.base,
          "POST",
          { name: "No", scopes: ["read_repository"] },
          f.keys[who],
        )
      ).status,
      403,
    );
  const t = await f.create();
  assert.match(t.token, /^odt_[a-f0-9]{64}$/);
  assert.equal(t.hash, undefined);
  const list = (await (await f.request(f.base)).json()) as any;
  assert.equal(list.tokens[0].token, undefined);
  assert.equal(list.tokens[0].hash, undefined);
  assert.ok(
    !f.db
      .prepare("SELECT hash FROM deploy_tokens WHERE id=?")
      .get(t.id)!
      .hash!.toString()
      .includes(t.token),
  );
  assert.equal(
    (await f.request(f.base + "/" + t.id + "/rotate", "POST", { revision: 2 }))
      .status,
    409,
  );
  const rotated = (await (
    await f.request(f.base + "/" + t.id + "/rotate", "POST", { revision: 1 })
  ).json()) as any;
  assert.equal(rotated.revision, 2);
  assert.notEqual(rotated.token, t.token);
  await assert.rejects(resolveDeployToken(f.env, t.token));
  assert.equal(
    (await f.request(f.base + "/" + t.id, "DELETE", { revision: 1 })).status,
    409,
  );
  assert.equal(
    (await f.request(f.base + "/" + t.id, "DELETE", { revision: 2 })).status,
    200,
  );
  await assert.rejects(resolveDeployToken(f.env, rotated.token));
  assert.equal(
    (await f.request(f.base + "/" + t.id + "/rotate", "POST", { revision: 3 }))
      .status,
    409,
  );
});
test("deploy principals cannot impersonate users, write Git, manage collaboration or cross project boundaries", async () => {
  const f = await setup(),
    t = await f.create();
  for (const [path, method] of [
    ["/api/tokens", "GET"],
    ["/api/admin/users", "GET"],
    ["/api/repos/owner/repo/issues", "POST"],
    [f.base, "GET"],
    ["/owner/repo.git/git-receive-pack", "POST"],
    ["/owner/repo.git/info/refs?service=git-receive-pack", "GET"],
  ]) {
    assert.equal(
      (
        await f.request(
          path,
          method,
          method === "POST" ? {} : undefined,
          t.token,
        )
      ).status,
      403,
      path,
    );
  }
  assert.equal(
    (
      await f.request(
        "/api/repos/owner/repo/packages",
        "GET",
        undefined,
        t.token,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request(
        "/api/repos/owner/other/packages",
        "GET",
        undefined,
        t.token,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request(
        "/api/repos/owner/repo/packages",
        "GET",
        undefined,
        t.token,
        { Authorization: "Basic " + btoa("wrong:" + t.token) },
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await f.request(
        "/api/repos/owner/repo/packages",
        "GET",
        undefined,
        t.token,
        { Authorization: "Basic " + btoa(t.username + ":" + t.token) },
      )
    ).status,
    200,
  );
  f.db
    .prepare("UPDATE repositories SET visibility='public' WHERE id='other'")
    .run();
  assert.equal(
    (
      await f.request(
        "/api/repos/owner/other/packages",
        "GET",
        undefined,
        t.token,
      )
    ).status,
    403,
  );
});
test("workspace deployment principal follows current project scope independently of issuer membership; project transfer permanently revokes project credentials", async () => {
  const f = await setup();
  f.db.exec(
    "INSERT INTO workspaces(id,slug,name) VALUES('w','team','Team'),('x','second','Second'); INSERT INTO workspace_members VALUES('w','o','owner'),('w','a','maintainer'),('x','o','owner'); UPDATE repositories SET workspace_id='w',namespace='team' WHERE id='r';",
  );
  const base = "/api/workspaces/team/deploy-tokens";
  assert.equal(
    (
      await f.request(
        base,
        "POST",
        { name: "Denied", scopes: ["read_repository"] },
        f.keys.author,
      )
    ).status,
    403,
  );
  const created = await f.request(base, "POST", {
    name: "Shared",
    scopes: ["read_repository", "read_package_registry"],
  });
  assert.equal(created.status, 201);
  const t = (await created.json()) as any,
    token = await resolveDeployToken(f.env, t.token);
  const r = f.db
    .prepare("SELECT * FROM repositories WHERE id='r'")
    .get() as any;
  await assertDeployAccess(f.env, r, token, "read_repository");
  f.db.prepare("UPDATE users SET disabled=1 WHERE id='o'").run();
  await assertDeployAccess(f.env, r, token, "read_repository");
  f.db.prepare("UPDATE users SET disabled=0 WHERE id='o'").run();
  const project = (await (
    await f.request("/api/repos/team/repo/deploy-tokens", "POST", {
      name: "Project",
      scopes: ["read_repository"],
    })
  ).json()) as any;
  f.db
    .prepare(
      "UPDATE repositories SET workspace_id='x',namespace='second',lifecycle_revision=lifecycle_revision+1 WHERE id='r'",
    )
    .run();
  const moved = f.db
    .prepare("SELECT * FROM repositories WHERE id='r'")
    .get() as any;
  await assert.rejects(
    assertDeployAccess(f.env, moved, token, "read_repository"),
  );
  await assert.rejects(resolveDeployToken(f.env, project.token));
  f.db
    .prepare(
      "UPDATE repositories SET workspace_id='w',namespace='team',lifecycle_revision=lifecycle_revision+1 WHERE id='r'",
    )
    .run();
  await assert.rejects(resolveDeployToken(f.env, project.token));
  const returned = f.db
    .prepare("SELECT * FROM repositories WHERE id='r'")
    .get() as any;
  await assertDeployAccess(f.env, returned, token, "read_repository");
});
test("package publication uses deployment identity and rechecks token rotation, revocation, expiry and project archive after R2 write", async () => {
  for (const mode of ["success", "rotate", "revoke", "expiry", "archive"]) {
    const f = await setup(),
      t = await f.create(),
      token = await resolveDeployToken(f.env, t.token),
      bytes = new TextEncoder().encode("deploy package"),
      objects = new Set<string>();
    f.env.OBJECTS = {
      delete: async (key: string) => objects.delete(key),
    } as any;
    const promise = publishPackage(
      f.env,
      f.repo,
      {
        id: token.created_by,
        credential: token.hash,
        revision: 0,
        deploy: token,
      },
      {
        kind: "generic",
        name: "demo",
        version: "1",
        filename: "data.bin",
        size: bytes.length,
        sha256: await digest(bytes),
      },
      async (key) => {
        objects.add(key);
        if (mode === "rotate")
          f.db
            .prepare("UPDATE deploy_tokens SET revision=revision+1 WHERE id=?")
            .run(t.id);
        if (mode === "revoke")
          f.db
            .prepare("UPDATE deploy_tokens SET revoked_at=1 WHERE id=?")
            .run(t.id);
        if (mode === "expiry")
          f.db
            .prepare("UPDATE deploy_tokens SET expires_at=0 WHERE id=?")
            .run(t.id);
        if (mode === "archive")
          f.db
            .prepare(
              "UPDATE repositories SET archived_at=datetime('now') WHERE id='r'",
            )
            .run();
      },
    );
    if (mode !== "success") {
      await assert.rejects(promise);
      assert.equal(objects.size, 0);
    } else {
      await promise;
      const v = f.db.prepare("SELECT * FROM package_versions").get()!;
      assert.equal(v.deploy_token_id, t.id);
      assert.match(String(v.publisher_label), /Deploy token:/);
      const audit = f.db
        .prepare(
          "SELECT actor_id,detail FROM audit WHERE action='package.publish'",
        )
        .get()!;
      assert.equal(audit.actor_id, null);
      assert.match(String(audit.detail), new RegExp(t.id));
      f.db.prepare("UPDATE users SET disabled=1 WHERE id='o'").run();
      assert.equal(
        (
          await f.request(
            "/api/repos/owner/repo/packages",
            "GET",
            undefined,
            t.token,
          )
        ).status,
        200,
      );
    }
  }
});
test("read, publish and delete package scopes are independent", async () => {
  const f = await setup(),
    read = await f.create(["read_package_registry"]),
    write = await f.create(["write_package_registry"]),
    git = await f.create(["read_repository"]);
  const path = "/api/repos/owner/repo/packages";
  assert.equal(
    (await f.request(path, "GET", undefined, git.token)).status,
    403,
  );
  assert.equal(
    (await f.request(path, "GET", undefined, write.token)).status,
    403,
  );
  assert.equal(
    (
      await f.request(
        path + "/npm/-/package/demo/dist-tags/latest",
        "PUT",
        "1.0.0",
        read.token,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request(
        path + "/versions/" + crypto.randomUUID(),
        "DELETE",
        undefined,
        write.token,
      )
    ).status,
    403,
  );
});
test("deploy-token package downloads cancel unread R2 streams when authentication changes during storage access", async () => {
  for (const mode of ["rotate", "revoke", "expire", "transfer"]) {
    const f = await setup(),
      t = await f.create(),
      token = await resolveDeployToken(f.env, t.token),
      bytes = new TextEncoder().encode("private deployment package");
    await publishPackage(
      f.env,
      f.repo,
      {
        id: token.created_by,
        credential: token.hash,
        revision: 0,
        deploy: token,
      },
      {
        kind: "generic",
        name: "demo",
        version: "1",
        filename: "data.bin",
        size: bytes.length,
        sha256: await digest(bytes),
      },
      async () => {},
    );
    let canceled = false;
    f.env.OBJECTS = {
      get: async () => {
        if (mode === "rotate")
          f.db
            .prepare("UPDATE deploy_tokens SET revision=revision+1 WHERE id=?")
            .run(t.id);
        if (mode === "revoke")
          f.db
            .prepare("UPDATE deploy_tokens SET revoked_at=1 WHERE id=?")
            .run(t.id);
        if (mode === "expire")
          f.db
            .prepare("UPDATE deploy_tokens SET expires_at=0 WHERE id=?")
            .run(t.id);
        if (mode === "transfer")
          f.db
            .prepare(
              "UPDATE repositories SET lifecycle_revision=lifecycle_revision+1 WHERE id='r'",
            )
            .run();
        return {
          size: bytes.length,
          body: new ReadableStream({
            start(c) {
              c.enqueue(bytes);
            },
            cancel() {
              canceled = true;
            },
          }),
        };
      },
    } as any;
    const r = await f.request(
      "/api/repos/owner/repo/packages/generic/demo/1/data.bin",
      "GET",
      undefined,
      t.token,
    );
    assert.equal(r.status, 403, mode);
    assert.ok(canceled, mode);
  }
});
test("workspace ownership is rechecked atomically and archived project deploy tokens remain manageable", async () => {
  const f = await setup();
  f.db.exec(
    "INSERT INTO workspaces(id,slug,name) VALUES('w','team','Team'); INSERT INTO workspace_members VALUES('w','o','owner'),('w','a','owner');",
  );
  const original = f.env.DB.batch.bind(f.env.DB);
  f.env.DB.batch = async <T>(statements: D1PreparedStatement[]) => {
    f.db
      .prepare(
        "UPDATE workspace_members SET role='maintainer' WHERE workspace_id='w' AND user_id='o'",
      )
      .run();
    return original<T>(statements);
  };
  assert.equal(
    (
      await f.request("/api/workspaces/team/deploy-tokens", "POST", {
        name: "Race",
        scopes: ["read_repository"],
      })
    ).status,
    409,
  );
  assert.equal(
    f.db.prepare("SELECT COUNT(*) n FROM deploy_tokens").get()!.n,
    0,
  );
  f.env.DB.batch = original;
  f.db
    .prepare("UPDATE repositories SET archived_at=datetime('now') WHERE id='r'")
    .run();
  const t = await f.create();
  assert.equal(
    (await f.request(f.base + "/" + t.id, "DELETE", { revision: 1 })).status,
    200,
  );
});
test("DO deployment guard rejects stale queued reads, writes, missing scope and invalid snapshots", async () => {
  const f = await setup(),
    t = await f.create(),
    token = await resolveDeployToken(f.env, t.token),
    id = crypto.randomUUID();
  f.db.prepare("UPDATE repositories SET id=? WHERE id='other'").run(id);
  f.db.prepare("UPDATE deploy_tokens SET repo_id=? WHERE id=?").run(id, t.id);
  const request = (path = "/git/git-upload-pack", method = "POST") =>
    new Request("http://repository" + path, {
      method,
      headers: {
        "x-deploy-token": JSON.stringify({
          id: token.id,
          hash: token.hash,
          revision: token.revision,
        }),
        "x-repo-id": id,
        "x-lifecycle-revision": "0",
      },
    });
  await assertDeployGitRequest(f.env, request());
  await assert.rejects(
    assertDeployGitRequest(f.env, request("/git/git-receive-pack")),
  );
  f.db
    .prepare("UPDATE deploy_tokens SET revision=revision+1 WHERE id=?")
    .run(t.id);
  await assert.rejects(assertDeployGitRequest(f.env, request()));
});
test("credential and role changes before deploy-token mutation roll back issuance; expired rotation obeys active quota", async () => {
  for (const mode of ["credential", "role"]) {
    const f = await setup(),
      original = f.env.DB.batch.bind(f.env.DB);
    f.env.DB.batch = async <T>(statements: D1PreparedStatement[]) => {
      if (mode === "credential")
        f.db.prepare("DELETE FROM credentials WHERE id='owner'").run();
      else
        f.db.prepare("UPDATE repositories SET owner_id='a' WHERE id='r'").run();
      return original<T>(statements);
    };
    assert.equal(
      (
        await f.request(f.base, "POST", {
          name: "Race",
          scopes: ["read_repository"],
        })
      ).status,
      409,
    );
    assert.equal(
      f.db.prepare("SELECT COUNT(*) n FROM deploy_tokens").get()!.n,
      0,
    );
  }
  const f = await setup(),
    old = await f.create();
  f.db.prepare("UPDATE deploy_tokens SET expires_at=0 WHERE id=?").run(old.id);
  const insert = f.db.prepare(
    "INSERT INTO deploy_tokens(id,hash,repo_id,name,username,scopes,created_by,created_at,expires_at) VALUES(?,?,'r','quota','quota','[\"read_repository\"]','o',0,?)",
  );
  for (let n = 0; n < 100; n++)
    insert.run(crypto.randomUUID(), "hash-" + n, Date.now() + 600000);
  assert.equal(
    (
      await f.request(f.base + "/" + old.id + "/rotate", "POST", {
        revision: 1,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.request(f.base, "POST", {
        name: "Over",
        scopes: ["read_repository"],
      })
    ).status,
    409,
  );
  f.db
    .prepare("UPDATE deploy_tokens SET revoked_at=1 WHERE hash='hash-0'")
    .run();
  assert.equal(
    (
      await f.request(f.base + "/" + old.id + "/rotate", "POST", {
        revision: 1,
      })
    ).status,
    200,
  );
});
