import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, realpath, stat, rm } from "node:fs/promises";
import { resolve, relative, join, dirname, sep } from "node:path";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { create, list, extract } from "tar";
const LIMIT = 64 * 1024 * 1024,
  EXPANDED = 256 * 1024 * 1024,
  ENTRIES = 25000;
function safe(path) {
  return (
    typeof path === "string" &&
    path.length <= 500 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !/[\x00-\x1f\x7f]/.test(path) &&
    path
      .replace(/\/$/, "")
      .split("/")
      .every((s) => s && s !== "." && s !== ".." && s.toLowerCase() !== ".git")
  );
}
function allowed(spec, path) {
  path = path.replace(/\/$/, "");
  return (
    safe(path) && spec.paths.some((p) => path === p || path.startsWith(p + "/"))
  );
}
async function noLinks(work, path, includeLeaf = true) {
  const parts = path.replace(/\/$/, "").split("/");
  if (!includeLeaf) parts.pop();
  let target = work;
  for (const part of parts) {
    target = join(target, part);
    const info = await lstat(target).catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (info?.isSymbolicLink()) throw Error("Cache path contains a symlink");
  }
  return resolve(work, path);
}
async function checksum(file) {
  const hash = createHash("sha256");
  for await (const b of createReadStream(file)) hash.update(b);
  return hash.digest("hex");
}
export async function packCache(work, spec, file) {
  let size = 0,
    count = 0;
  const files = [];
  for (const root of spec.paths) {
    if (!safe(root)) throw Error("Unsafe cache root");
    await noLinks(work, root);
    async function walk(path) {
      const target = resolve(work, path),
        info = await lstat(target).catch((e) => {
          if (e.code === "ENOENT") return null;
          throw e;
        });
      if (!info) return;
      if (info.isSymbolicLink())
        throw Error("Cache archives cannot contain links");
      if (info.isDirectory()) {
        for (const child of await readdir(target))
          await walk(path + "/" + child);
        return;
      }
      if (!info.isFile() || info.nlink > 1)
        throw Error("Cache archives require ordinary files");
      if (!allowed(spec, path)) throw Error("Unsafe cache path");
      if (++count > ENTRIES || (size += info.size) > EXPANDED)
        throw Error("Cache expanded size or file count exceeded");
      files.push(path);
    }
    await walk(root);
  }
  if (!files.length) return null;
  await create(
    {
      cwd: work,
      file,
      gzip: true,
      portable: true,
      strict: true,
      noDirRecurse: true,
      follow: false,
    },
    files,
  );
  const bytes = (await stat(file)).size;
  if (bytes > LIMIT) throw Error("Cache archive exceeds 64 MiB");
  return { size: bytes, checksum: await checksum(file) };
}
export async function restoreCache(work, spec, file) {
  let size = 0,
    count = 0;
  const paths = [];
  // Inspect the complete archive before extraction; extended headers are handled by tar itself.
  const parser = list({
    strict: true,
    onReadEntry(entry) {
      const path = entry.path.replace(/\/$/, "");
      if (
        !["File", "OldFile", "Directory"].includes(entry.type) ||
        !allowed(spec, path)
      )
        return parser.abort(Error("Unsafe cache archive entry"));
      if (++count > ENTRIES || (size += entry.size) > EXPANDED)
        return parser.abort(
          Error("Cache expanded size or file count exceeded"),
        );
      paths.push(path);
    },
  });
  await pipeline(createReadStream(file), parser);
  for (const path of paths) await noLinks(work, path);
  await extract({
    cwd: work,
    file,
    strict: true,
    preservePaths: false,
    unlink: true,
    noChmod: false,
    noMtime: true,
    filter: (path, entry) => {
      if (
        !["File", "OldFile", "Directory"].includes(entry.type) ||
        !allowed(spec, path)
      )
        throw Error("Unsafe cache archive entry");
      return true;
    },
  });
}
export async function restoreCaches({ run, lease, work, dir, request, log }) {
  for (const spec of run.config.caches || []) {
    if (spec.policy === "push") continue;
    const file = join(dir, "cache-" + spec.id + ".tgz");
    try {
      const response = await request(
        "/runs/" + run.id + "/caches/" + spec.id,
        undefined,
        lease,
      );
      if (response.headers.get("content-type")?.includes("json")) {
        await response.body?.cancel();
        log("Cache MISS " + spec.id + "\n");
        continue;
      }
      const expected = response.headers.get("x-cache-sha256"),
        size = Number(response.headers.get("content-length"));
      if (
        !expected ||
        !Number.isSafeInteger(size) ||
        size <= 0 ||
        size > LIMIT
      ) {
        await response.body?.cancel();
        throw Error("Invalid cache metadata");
      }
      let bytes = 0;
      await pipeline(
        Readable.fromWeb(response.body),
        new Transform({
          transform(chunk, _, done) {
            bytes += chunk.length;
            done(
              bytes > LIMIT ? Error("Cache download too large") : null,
              chunk,
            );
          },
        }),
        createWriteStream(file, { flags: "wx", mode: 0o600 }),
      );
      if (bytes !== size || (await checksum(file)) !== expected)
        throw Error("Cache checksum mismatch");
      await restoreCache(work, spec, file);
      log("Cache HIT " + spec.id + "\n");
    } catch (e) {
      log("Cache MISS " + spec.id + " (" + e.message + ")\n");
    } finally {
      await rm(file, { force: true });
    }
  }
}
export async function saveCaches({ run, lease, work, dir, request, log }) {
  for (const spec of run.config.caches || []) {
    if (spec.policy === "pull") continue;
    const file = join(dir, "cache-" + spec.id + ".tgz");
    try {
      const metadata = await packCache(work, spec, file);
      if (!metadata) {
        log("Cache SKIP " + spec.id + " (empty)\n");
        continue;
      }
      await request(
        "/runs/" + run.id + "/caches/" + spec.id,
        undefined,
        lease,
        {
          method: "PUT",
          headers: {
            "content-type": "application/gzip",
            "content-length": String(metadata.size),
            "x-cache-sha256": metadata.checksum,
          },
          body: createReadStream(file),
          duplex: "half",
          signal: AbortSignal.timeout(150000),
        },
      );
      log("Cache SAVED " + spec.id + "\n");
    } catch (e) {
      log("Cache SKIP " + spec.id + " (" + e.message + ")\n");
    } finally {
      await rm(file, { force: true });
    }
  }
}
