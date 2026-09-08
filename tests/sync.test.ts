import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { GitClient } from "../src/git/client";
import { ObjectStore, text, canonical } from "../src/git/objects";
import { ForgeRepository } from "../src/git/forge";
import { upstreamURL, seal, unseal } from "../src/sync-config";
import { verifyGitHubWebhook } from "../src/github";
import { mirroredRefs } from "../src/sync";
function memory() {
  const values = new Map<string, Uint8Array>();
  return {
    get: async (key: string) => {
      const b = values.get(key);
      return b
        ? {
            size: b.length,
            arrayBuffer: async () =>
              b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
          }
        : null;
    },
    put: async (key: string, value: Uint8Array) => {
      if (values.has(key)) return null;
      values.set(key, value.slice());
      return {};
    },
  } as any;
}
const git = (cwd: string, args: string[], input?: Uint8Array) => {
  const p = spawnSync("git", args, {
    cwd,
    input,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    maxBuffer: 32 * 1024 * 1024,
  });
  if (p.status) throw Error(p.stderr.toString());
  return p.stdout;
};
test("pure JS Git HTTP client fetches and atomically pushes against native Git http-backend", async () => {
  const dir = await mkdtemp(join(tmpdir(), "onestorage-sync-"));
  try {
    git(dir, ["init", "-b", "main", "work"]);
    const work = join(dir, "work");
    git(work, ["config", "user.name", "Native"]);
    git(work, ["config", "user.email", "native@example.com"]);
    await writeFile(join(work, "file"), "native content\n");
    git(work, ["add", "."]);
    git(work, ["commit", "-m", "Initial"]);
    git(dir, ["clone", "--bare", "work", "repo.git"]);
    git(join(dir, "repo.git"), ["config", "http.receivepack", "true"]);
    const transport = async (url: string, init: RequestInit) => {
      const u = new URL(url);
      const p = spawnSync("git", ["http-backend"], {
        input: init.body ? Buffer.from(init.body as Uint8Array) : undefined,
        env: {
          ...process.env,
          GIT_PROJECT_ROOT: dir,
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: u.pathname,
          QUERY_STRING: u.search.slice(1),
          REQUEST_METHOD: init.method,
          CONTENT_TYPE: new Headers(init.headers).get("content-type") || "",
          REMOTE_USER: "tests",
        },
        maxBuffer: 32 * 1024 * 1024,
      });
      if (p.status) throw Error(p.stderr.toString());
      const at = Buffer.from(p.stdout).toString("latin1").indexOf("\r\n\r\n");
      assert.ok(at >= 0);
      const headers = new Headers();
      let status = 200;
      for (const line of p.stdout.subarray(0, at).toString().split("\r\n")) {
        const i = line.indexOf(":");
        if (i < 0) continue;
        if (line.startsWith("Status:"))
          status = Number(
            line
              .slice(i + 1)
              .trim()
              .split(" ")[0],
          );
        else headers.set(line.slice(0, i), line.slice(i + 1).trim());
      }
      return new Response(p.stdout.subarray(at + 4), { status, headers });
    };
    const client = new GitClient(
        "https://git.example.com/repo.git",
        {},
        transport,
      ),
      store = new ObjectStore("sync-test", memory());
    const pulled = await client.pull(store);
    assert.equal(
      pulled.refs["refs/heads/main"],
      git(work, ["rev-parse", "HEAD"]).toString().trim(),
    );
    await store.flush();
    const state = new Map<string, any>();
    const repo = new ForgeRepository(
      store,
      {
        get: async <T>(k: string) => state.get(k) as T,
        put: async (k, v) => {
          state.set(k, v);
        },
      },
      pulled.refs,
      "main",
    );
    const commit = await repo.commitFiles({
      target_branch: "main",
      commit_message: "JS",
      author: { name: "JS", email: "js@example.com" },
      files: [
        { path: "file", content: "changed in worker\n" },
        { path: "binary", data: Buffer.from([0, 1, 255]).toString("base64") },
      ],
    });
    await client.push(store, pulled.refs, {
      ...repo.refs,
      "refs/tags/v1": commit.sha,
    });
    assert.equal(
      git(join(dir, "repo.git"), ["rev-parse", "main"]).toString().trim(),
      commit.sha,
    );
    assert.equal(
      git(join(dir, "repo.git"), ["show", "main:file"]).toString(),
      "changed in worker\n",
    );
    git(join(dir, "repo.git"), ["fsck", "--strict"]);
    await assert.rejects(
      () => client.push(store, pulled.refs, repo.refs),
      /Upstream ref changed/,
    );
    const fresh = new ObjectStore("fresh", memory());
    const again = await client.pull(fresh);
    assert.equal(again.refs["refs/tags/v1"], commit.sha);
    assert.equal(
      (await fresh.walk(Object.values(again.refs))).size,
      git(join(dir, "repo.git"), ["rev-list", "--objects", "--all"])
        .toString()
        .trim()
        .split("\n").length,
    );
    const after = { ...again.refs };
    delete after["refs/tags/v1"];
    await client.push(fresh, again.refs, after);
    assert.equal((await client.advertise()).refs["refs/tags/v1"], undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("upstream URLs never include credentials, arbitrary ports or unapproved hosts", () => {
  assert.equal(
    upstreamURL({ provider: "gitlab", owner: "team/subgroup", name: "repo" }),
    "https://gitlab.com/team/subgroup/repo.git",
  );
  for (const owner of [
    "../secret",
    "team/../private",
    "team%2Fprivate",
    "x?foo",
    "x@evil",
  ])
    assert.throws(() =>
      upstreamURL({ provider: "gitlab", owner, name: "repo" }),
    );
  for (const upstream_host of [
    "localhost",
    "127.0.0.1",
    "gitlab.com:443",
    "evil.example",
  ])
    assert.throws(() =>
      upstreamURL({
        provider: "gitea",
        owner: "team",
        name: "repo",
        upstream_host,
      }),
    );
  assert.equal(
    upstreamURL(
      {
        provider: "forgejo",
        owner: "team",
        name: "repo",
        upstream_host: "git.example.com",
      },
      "git.example.com",
    ),
    "https://git.example.com/team/repo.git",
  );
});
test("credential encryption binds ciphertext to repository and record ID", async () => {
  const env = {
    CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  } as any;
  const ciphertext = await seal(env, "repo:a", { password: "very-secret" });
  assert.ok(!ciphertext.includes("very-secret"));
  assert.deepEqual(await unseal(env, "repo:a", ciphertext), {
    password: "very-secret",
  });
  await assert.rejects(() => unseal(env, "repo:b", ciphertext));
  await assert.rejects(() =>
    unseal(
      {
        ...env,
        CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
      },
      "repo:a",
      ciphertext,
    ),
  );
});
test("GitHub webhook HMAC rejects tampering and unsigned payloads", async () => {
  const body = new TextEncoder().encode('{"ref":"refs/heads/main"}'),
    secret = "webhook-test-secret";
  const signature =
    "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  assert.equal(await verifyGitHubWebhook(body, signature, secret), true);
  assert.equal(
    await verifyGitHubWebhook(
      new TextEncoder().encode("{}"),
      signature,
      secret,
    ),
    false,
  );
  assert.equal(await verifyGitHubWebhook(body, "", secret), false);
});
test("upstream refresh preserves local notes and ephemeral refs, prunes stale mirrored branches", () => {
  const a = "a".repeat(40),
    b = "b".repeat(40);
  assert.deepEqual(
    mirroredRefs(
      {
        "refs/heads/stale": a,
        "refs/notes/commits": a,
        "refs/namespaces/ephemeral/refs/heads/task": a,
      },
      { "refs/heads/main": b },
    ),
    {
      "refs/notes/commits": a,
      "refs/namespaces/ephemeral/refs/heads/task": a,
      "refs/heads/main": b,
    },
  );
});
test("GitHub App installation JWT and LFS upload/download preserve scoped credentials and verified bytes", async () => {
  const { generateKeyPair, exportPKCS8, jwtVerify } = await import("jose");
  const { uploadLFS, downloadLFS, lfsAction } = await import("../src/lfs-sync");
  const { digest } = await import("../src/security");
  const keys = await generateKeyPair("RS256", { extractable: true });
  const env = {
    CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString("base64"),
  } as any;
  const encrypted = await seal(env, "github:user", {
    app_id: "123",
    installation_id: "456",
    private_key: await exportPKCS8(keys.privateKey),
    webhook_secret: "secret-for-tests",
  });
  env.DB = {
    prepare: () => ({ bind: () => ({ first: async () => ({ encrypted }) }) }),
  };
  const repo = {
    id: "repo",
    owner_id: "user",
    base_repo: JSON.stringify({
      provider: "github",
      owner: "team",
      name: "repo",
      mode: "app",
    }),
  } as any;
  const data = Uint8Array.of(0, 1, 255),
    oid = await digest(data);
  let uploaded = 0,
    verified = 0,
    tokens = 0;
  const transport = async (url: any, init: any = {}) => {
    url = String(url);
    const h = new Headers(init.headers);
    assert.equal(init.redirect, "manual");
    if (url === "https://api.github.com/app/installations/456/access_tokens") {
      tokens++;
      const claims = await jwtVerify(
        h.get("Authorization")!.slice(7),
        keys.publicKey,
        { issuer: "123" },
      );
      assert.ok(claims.payload.exp! - claims.payload.iat! <= 600);
      assert.deepEqual(JSON.parse(init.body), { repositories: ["repo"] });
      return Response.json({
        token: "installation-test-token",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      });
    }
    if (url === "https://github.com/team/repo.git/info/lfs/objects/batch") {
      assert.equal(
        h.get("Authorization"),
        "Basic " +
          Buffer.from("x-access-token:installation-test-token").toString(
            "base64",
          ),
      );
      const body = JSON.parse(init.body);
      return Response.json({
        objects: [
          {
            oid,
            size: 3,
            actions:
              body.operation === "upload"
                ? {
                    upload: {
                      href: "https://github-cloud.s3.amazonaws.com/upload?signature=test",
                    },
                    verify: {
                      href: "https://github.com/team/repo.git/info/lfs/verify",
                      header: { Authorization: "action-token" },
                    },
                  }
                : {
                    download: {
                      href: "https://github-cloud.s3.amazonaws.com/download?signature=test",
                    },
                  },
          },
        ],
      });
    }
    if (url.startsWith("https://github-cloud.s3.amazonaws.com/")) {
      assert.equal(h.has("Authorization"), false);
      if (init.method === "PUT") {
        assert.deepEqual(new Uint8Array(init.body), data);
        uploaded++;
        return new Response(null, { status: 200 });
      }
      return new Response(data);
    }
    if (url.endsWith("/verify")) {
      assert.equal(h.get("Authorization"), "action-token");
      verified++;
      return new Response(null, { status: 200 });
    }
    throw Error("Unexpected URL " + url);
  };
  await uploadLFS(env, repo, oid, data, transport as typeof fetch);
  assert.deepEqual(
    await downloadLFS(env, repo, oid, 3, transport as typeof fetch),
    data,
  );
  assert.equal(uploaded, 1);
  assert.equal(verified, 1);
  assert.equal(tokens, 2);
  assert.throws(
    () => lfsAction({ href: "http://127.0.0.1/metadata" }),
    /Unapproved/,
  );
  assert.throws(
    () =>
      lfsAction({
        href: "https://evil.example/object",
        header: { Authorization: "token" },
      }),
    /Unapproved/,
  );
  const corrupt = async (url: any, init: any) =>
    String(url).includes("/download?")
      ? new Response(Uint8Array.of(9, 9, 9))
      : transport(url, init);
  await assert.rejects(
    () => downloadLFS(env, repo, oid, 3, corrupt as typeof fetch),
    /integrity/,
  );
});
