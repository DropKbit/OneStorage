import { bytes, canonical, makeObject, treeBytes } from "../src/git/objects";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

async function repositoryClass() {
  const bundled = await build({
    entryPoints: ["src/repository.ts"],
    bundle: true,
    write: false,
    platform: "node",
    banner: {
      js: 'import { createRequire as alarmTestCreateRequire } from "node:module"; const require = alarmTestCreateRequire(import.meta.url);',
    },
    format: "esm",
    logLevel: "silent",
    plugins: [
      {
        name: "durable-object-test-host",
        setup(b) {
          b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "host",
            namespace: "test-host",
          }));
          b.onLoad({ filter: /.*/, namespace: "test-host" }, () => ({
            contents:
              "export class DurableObject { constructor(ctx,env) { this.ctx=ctx;this.env=env; } } export class WorkerEntrypoint {}",
          }));
        },
      },
    ],
  });
  const folder = await mkdtemp(join(tmpdir(), "onestorage-alarm-test-"));
  const entry = join(folder, "repository.mjs");
  await writeFile(entry, bundled.outputFiles[0].contents);
  let Repository;
  try {
    ({ Repository } = await import(pathToFileURL(entry).href));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
  return Repository;
}

test("busy repository alarms return without joining the HTTP queue; idle alarms still collect", async () => {
  const Repository = await repositoryClass();
  let reads = 0,
    alarm = 0,
    cacheUnavailable = false,
    release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const storage = {
    get: async () => {
      reads++;
      return undefined;
    },
    list: async ({ prefix }: { prefix: string }) => {
      if (cacheUnavailable && prefix === "pack-cache:entry:")
        throw Error("cache unavailable");
      return new Map();
    },
    setAlarm: async (value: number) => {
      alarm = value;
    },
  };
  const repository = new Repository({ storage }, { OBJECTS: {} });
  repository.handle = async () => {
    await gate;
    return new Response("done");
  };
  const first = repository.fetch(new Request("https://repo/one")),
    queued = repository.fetch(new Request("https://repo/two"));
  assert.equal(repository.waiting, 2);
  const before = Date.now();
  await Promise.race([
    repository.alarm(),
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(Error("alarm joined active HTTP queue")),
        1000,
      );
      timer.unref();
    }),
  ]);
  assert.equal(reads, 0);
  assert.ok(alarm >= before + 30000);
  release();
  await Promise.all([first, queued]);
  await repository.gate.tail;
  assert.equal(repository.waiting, 0);
  await repository.alarm();
  assert.ok(reads > 0);
  cacheUnavailable = true;
  const prior = reads;
  await repository.alarm();
  assert.ok(reads > prior + 1, "cache failure does not stop other alarm work");
  assert.ok(alarm >= Date.now() + 29000);
});

test("real snapshot prelude checks project versions and uses isolated published refs", async () => {
  const Repository = await repositoryClass();
  const id = "00000000-0000-4000-8000-000000000001";
  const blob = await makeObject("blob", bytes("old readme"));
  const tree = await makeObject(
    "tree",
    treeBytes([
      { name: "README.md", type: "blob", mode: "100644", sha: blob.oid },
    ]),
  );
  const commit = await makeObject(
    "commit",
    bytes(
      `tree ${tree.oid}\nauthor A <a@b> 1 +0000\ncommitter A <a@b> 1 +0000\n\nold\n`,
    ),
  );
  const next = await makeObject(
    "commit",
    bytes(
      `tree ${tree.oid}\nparent ${commit.oid}\nauthor A <a@b> 2 +0000\ncommitter A <a@b> 2 +0000\n\nnew\n`,
    ),
  );
  const objects = new Map(
    [blob, tree, commit, next].map((o) => [o.oid, canonical(o)]),
  );
  const state = new Map<string, any>([
    ["project-version", 0],
    ["refs.v2", { "refs/heads/main": commit.oid }],
  ]);
  let release!: () => void,
    started!: () => void,
    serial = 0;
  const hold = new Promise<void>((r) => {
      release = r;
    }),
    entered = new Promise<void>((r) => {
      started = r;
    });
  const waits: Promise<unknown>[] = [];
  const storage = {
    get: async (key: string) => structuredClone(state.get(key)),
    put: async () => {
      throw Error("read wrote state");
    },
  };
  const repository = new Repository(
    {
      storage,
      waitUntil: (p: Promise<unknown>) => {
        waits.push(p);
      },
    },
    {
      OBJECTS: {
        get: async (key: string) => {
          const oid = key.split("/").at(-1)!;
          // Publication happens after the snapshot has captured its refs but before its tree read finishes.
          if (oid === tree.oid)
            state.set("refs.v2", { "refs/heads/main": next.oid });
          const data = objects.get(oid);
          return data
            ? {
                size: data.length,
                arrayBuffer: async () => data.slice().buffer,
              }
            : null;
        },
      },
    },
  );
  repository.objectIndex = { repoId: id };
  repository.handle = async (request: Request, ready: () => void) => {
    if (request.method === "POST") {
      ready();
      started();
      await hold;
      return new Response("push");
    }
    serial++;
    return new Response("serial");
  };
  const headers = { "x-repo-id": id, "x-lifecycle-revision": "0" };
  const upload = repository.fetch(
    new Request("https://repo/git/git-receive-pack", {
      method: "POST",
      headers,
    }),
  );
  await entered;
  const response = await repository.fetch(
    new Request("https://repo/browse", { headers }),
  );
  assert.equal(response.headers.get("x-onestorage-read-mode"), "snapshot");
  const data = await response.json();
  assert.equal(data.data.ref, commit.oid);
  assert.equal(data.readme.ref, commit.oid);
  assert.equal(data.readme.content, "old readme");
  await Promise.all(waits);
  state.set("project-version", 1);
  assert.equal(
    (await repository.fetch(new Request("https://repo/browse", { headers })))
      .status,
    409,
  );
  const hidden = repository.fetch(
    new Request("https://repo/browse?ref=" + "a".repeat(40), {
      headers: { ...headers, "x-lifecycle-revision": "1" },
    }),
  );
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(
    serial,
    0,
    "unpublished explicit SHA falls back behind the active push",
  );
  release();
  await upload;
  assert.equal(await (await hidden).text(), "serial");
  await repository.gate.tail;
  assert.equal(repository.waiting, 0);
});
