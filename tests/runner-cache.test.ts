import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "tar";
const { packCache, restoreCache } = await import(new URL("../scripts/runner-cache.mjs",import.meta.url).href);
const spec = { paths: [".cache"] };
test("runner cache round-trips nested binary files and refuses links or out-of-scope tar entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cache-test-"));
  try {
    const source = join(dir, "source"),
      target = join(dir, "target"),
      file = join(dir, "cache.tgz");
    await mkdir(join(source, ".cache", "nested"), { recursive: true });
    await mkdir(target);
    await writeFile(
      join(source, ".cache", "nested", "binary"),
      Buffer.from([0, 1, 255]),
    );
    const info = await packCache(source, spec, file);
    assert.ok(info.size > 0);
    await restoreCache(target, spec, file);
    assert.deepEqual(
      await readFile(join(target, ".cache", "nested", "binary")),
      Buffer.from([0, 1, 255]),
    );
    await symlink("/tmp", join(source, ".cache", "link"));
    await assert.rejects(
      packCache(source, spec, join(dir, "link.tgz")),
      /links/,
    );
    await writeFile(join(source, "outside"), "bad");
    await create({ cwd: source, file: join(dir, "bad.tgz"), gzip: true }, [
      "outside",
    ]);
    await assert.rejects(
      restoreCache(target, spec, join(dir, "bad.tgz")),
      /Unsafe/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
