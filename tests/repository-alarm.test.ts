import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

test("busy repository alarms return without joining the HTTP queue; idle alarms still collect", async () => {
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
  await repository.tail;
  assert.equal(repository.waiting, 0);
  await repository.alarm();
  assert.ok(reads > 0);
  cacheUnavailable = true;
  const prior = reads;
  await repository.alarm();
  assert.ok(reads > prior + 1, "cache failure does not stop other alarm work");
  assert.ok(alarm >= Date.now() + 29000);
});
