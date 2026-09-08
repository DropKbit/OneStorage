import { Inflate } from "pako";
import { exports as packageExports } from "resolve.exports";
import { BUILD_LIMIT } from "./ci-build-schema";
import { decodeBase64 } from "./base64";

const encoder = new TextEncoder(),
  decoder = new TextDecoder("utf-8", { fatal: true });
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
export function normalizePath(value: string) {
  if (value.startsWith("/") || /[\\\x00-\x1f]/.test(value))
    throw Error("Invalid build path");
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (part === "..") {
      if (!parts.length) throw Error("Build path escapes root");
      parts.pop();
    } else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/");
}
export function lockPackages(
  files: Record<string, string>,
  privateURL: (url: URL) => boolean = () => false,
) {
  const manifest = JSON.parse(files["package.json"] || "{}");
  const lock = files["package-lock.json"]
    ? JSON.parse(files["package-lock.json"])
    : null;
  const fields = ["dependencies", "devDependencies", "optionalDependencies"];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    throw Error("Invalid package manifest");
  for (const k of fields) {
    if (
      manifest[k] !== undefined &&
      (!manifest[k] ||
        typeof manifest[k] !== "object" ||
        Array.isArray(manifest[k]) ||
        Object.entries(manifest[k]).some(
          ([name, version]) =>
            !packageName.test(name) || typeof version !== "string",
        ))
    )
      throw Error("Invalid package dependency declarations");
  }
  if (!lock) {
    if (fields.some((k) => Object.keys(manifest[k] || {}).length))
      throw Error("npm dependencies require package-lock.json v2/v3");
    return {};
  }
  if (
    ![2, 3].includes(lock.lockfileVersion) ||
    !lock.packages?.[""] ||
    Array.isArray(lock.packages) ||
    Object.keys(lock.packages).length > 5000
  )
    throw Error("Expected package-lock.json v2/v3");
  for (const k of fields) {
    const a = manifest[k] || {},
      b = lock.packages[""][k] || {};
    if (
      Object.keys(a).length !== Object.keys(b).length ||
      Object.keys(a).some((n) => a[n] !== b[n])
    )
      throw Error("package.json and package-lock.json differ: " + k);
  }
  const packages: Record<
    string,
    { version: string; resolved: string; integrity: string }
  > = Object.create(null);
  for (const [path, data] of Object.entries(lock.packages)) {
    if (!path) continue;
    const parts = path.split("node_modules/");
    if (
      parts[0] !== "" ||
      parts
        .slice(1)
        .some(
          (p, i, all) =>
            !packageName.test(i < all.length - 1 ? p.slice(0, -1) : p),
        )
    )
      throw Error("Unsupported workspace/link package in lockfile");
    const p = data as any;
    if (
      p.link ||
      typeof p.version !== "string" ||
      !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/.test(
        p.version,
      )
    )
      throw Error("Invalid locked package version");
    const url = new URL(p.resolved);
    if (
      (url.origin !== "https://registry.npmjs.org" && !privateURL(url)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.endsWith(".tgz")
    )
      throw Error(
        "Only public npm registry or explicitly supplied private tarballs are supported",
      );
    if (
      typeof p.integrity !== "string" ||
      !/^sha512-[A-Za-z0-9+/]{86}==$/.test(p.integrity)
    )
      throw Error("Locked packages require SHA-512 integrity");
    packages[path] = {
      version: p.version,
      resolved: url.href,
      integrity: p.integrity,
    };
  }
  return packages;
}

// Bounded gzip + tar parser. Never writes to a filesystem or follows links.
export function unpackPackage(
  gzip: Uint8Array,
  remaining = BUILD_LIMIT.expanded,
) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const inflater = new Inflate({ chunkSize: 16384 });
  inflater.onData = (data) => {
    const chunk =
      data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
    size += chunk.length;
    if (size > remaining) throw Error("npm expanded byte limit exceeded");
    chunks.push(chunk);
  };
  inflater.push(gzip, true);
  if (inflater.err || !(inflater as Inflate & { ended: boolean }).ended)
    throw Error("Invalid npm gzip archive");
  const tar = new Uint8Array(size);
  let pos = 0;
  for (const chunk of chunks) {
    tar.set(chunk, pos);
    pos += chunk.length;
  }
  const files: Record<string, string> = Object.create(null);
  let count = 0,
    ended = false;
  const str = (b: Uint8Array) =>
    decoder.decode(b.subarray(0, b.indexOf(0) < 0 ? b.length : b.indexOf(0)));
  for (let offset = 0; offset + 512 <= tar.length;) {
    const h = tar.subarray(offset, offset + 512);
    if (h.every((n) => n === 0)) {
      ended = true;
      break;
    }
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : h[i];
    if (parseInt(str(h.subarray(148, 156)).trim(), 8) !== checksum)
      throw Error("Invalid npm tar checksum");
    const length = str(h.subarray(124, 136)).trim();
    if (!/^[0-7]+$/.test(length)) throw Error("Unsupported npm tar length");
    const bytes = parseInt(length, 8),
      type = h[156];
    const prefix = str(h.subarray(345, 500));
    const name = (prefix ? prefix + "/" : "") + str(h.subarray(0, 100));
    if (
      ++count > BUILD_LIMIT.packageFiles ||
      bytes > remaining ||
      offset + 512 + bytes > tar.length
    )
      throw Error("npm archive limit or truncation");
    if (
      !name.startsWith("package/") ||
      name.includes("\\") ||
      name.includes("//") ||
      /[\x00-\x1f]/.test(name) ||
      name
        .split("/")
        .some(
          (p) =>
            p === ".." || p === "." || p === ".git" || p === "node_modules",
        )
    )
      throw Error("Invalid npm tar path");
    if (type !== 0 && type !== 48 && type !== 53)
      throw Error("npm archive links and extended headers are unsupported");
    const path = name.slice(8).replace(/\/$/, "");
    if (type !== 53 && path) {
      if (Object.hasOwn(files, path)) throw Error("Duplicate npm tar entry");
      // Native modules and binary assets cannot be executed by this compiler.
      if (/\.(?:[cm]?js|[cm]?ts|jsx|tsx|json|css)$/.test(path))
        files[path] = decoder.decode(
          tar.subarray(offset + 512, offset + 512 + bytes),
        );
    }
    offset += 512 + Math.ceil(bytes / 512) * 512;
  }
  if (!ended) throw Error("Unterminated npm tar archive");
  return { files, expanded: size, entries: count };
}

export class BuildFileSystem {
  files: Record<string, string>;
  packages: ReturnType<typeof lockPackages>;
  loaded = new Map<string, Promise<void>>();
  compressed = 0;
  expanded = 0;
  count = 0;
  entries = 0;
  // Serialize downloads/extraction to bound peak memory even with parallel imports.
  private queue: Promise<void> = Promise.resolve();
  constructor(
    files: Record<string, string>,
    private platform: "worker" | "browser",
    private fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
    private signal: AbortSignal = new AbortController().signal,
    private supplied: Record<string, string> = {},
  ) {
    if (Object.keys(supplied).length > BUILD_LIMIT.packages)
      throw Error("Private npm package count limit exceeded");
    let encoded = 0;
    for (const value of Object.values(supplied)) {
      encoded += value.length;
      if (
        encoded >
          Math.ceil(BUILD_LIMIT.compressed / 3) * 4 +
            4 * BUILD_LIMIT.packages ||
        value.length % 4 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
      )
        throw Error("Private npm payload limit or encoding invalid");
      this.compressed +=
        (value.length / 4) * 3 -
        (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0);
    }
    if (this.compressed > BUILD_LIMIT.compressed)
      throw Error("npm compressed byte limit exceeded");
    this.files = Object.assign(Object.create(null), files);
    this.packages = lockPackages(files, (url) =>
      Object.hasOwn(supplied, url.href),
    );
  }
  async install(path: string) {
    if (this.loaded.has(path)) return this.loaded.get(path)!;
    if (++this.count > BUILD_LIMIT.packages)
      throw Error("npm package count limit exceeded");
    const task = this.queue.then(async () => {
      this.signal.throwIfAborted();
      const pkg = this.packages[path];
      const supplied = Object.hasOwn(this.supplied, pkg.resolved);
      const response = supplied
        ? new Response(decodeBase64(this.supplied[pkg.resolved]))
        : await this.fetcher(pkg.resolved, {
            redirect: "manual",
            signal: AbortSignal.any([this.signal, AbortSignal.timeout(15000)]),
          });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw Error("Locked npm package download failed");
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (!supplied) this.compressed += value.length;
          if (this.compressed > BUILD_LIMIT.compressed)
            throw Error("npm compressed byte limit exceeded");
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const c of chunks) {
        bytes.set(c, offset);
        offset += c.length;
      }
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-512", bytes));
      const sri = "sha512-" + btoa(String.fromCharCode(...hash));
      if (sri !== pkg.integrity)
        throw Error("npm SHA-512 integrity mismatch: " + path);
      const extracted = unpackPackage(
        bytes,
        BUILD_LIMIT.expanded - this.expanded,
      );
      this.expanded += extracted.expanded;
      this.entries += extracted.entries;
      if (this.entries > BUILD_LIMIT.packageFiles)
        throw Error("npm file count limit exceeded");
      const unpacked = extracted.files;
      const manifest = JSON.parse(unpacked["package.json"] || "null");
      if (!manifest || manifest.version !== pkg.version)
        throw Error("npm manifest version mismatch");
      if (supplied && manifest.name !== path.split("node_modules/").at(-1))
        throw Error("Private npm manifest name mismatch");
      for (const [p, content] of Object.entries(unpacked)) {
        this.files[path + "/" + p] = content;
      }
    });
    this.loaded.set(path, task);
    this.queue = task;
    return task;
  }
  private file(path: string): string | null {
    for (const suffix of [
      "",
      ".ts",
      ".tsx",
      ".mts",
      ".js",
      ".jsx",
      ".mjs",
      ".cjs",
      ".json",
      ".css",
      "/index.ts",
      "/index.tsx",
      "/index.js",
      "/index.mjs",
      "/index.cjs",
    ])
      if (Object.hasOwn(this.files, path + suffix)) return path + suffix;
    return null;
  }
  async resolve(
    specifier: string,
    importer = "",
    require = false,
  ): Promise<string> {
    if (
      specifier.startsWith(".") ||
      (!importer && Object.hasOwn(this.files, specifier))
    ) {
      const path = normalizePath(
        (importer ? importer.slice(0, importer.lastIndexOf("/") + 1) : "") +
          specifier,
      );
      const found = this.file(path);
      if (found) return found;
      throw Error("Cannot resolve source import: " + specifier);
    }
    const pieces = specifier.split("/"),
      name = pieces.slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
    if (
      !packageName.test(name) ||
      /[:\\]/.test(specifier) ||
      pieces.some((p) => !p || p === "." || p === "..")
    )
      throw Error("Unsupported import: " + specifier);
    let dir = importer
        .slice(0, importer.lastIndexOf("/") + 1)
        .replace(/\/$/, ""),
      root = "";
    for (;;) {
      const candidate = (dir ? dir + "/" : "") + "node_modules/" + name;
      if (Object.hasOwn(this.packages, candidate)) {
        root = candidate;
        break;
      }
      if (!dir) throw Error("Import missing from lockfile: " + specifier);
      dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
    }
    await this.install(root);
    const manifest = JSON.parse(this.files[root + "/package.json"]),
      sub = specifier.slice(name.length);
    let target: string;
    if (manifest.exports !== undefined) {
      const resolved = packageExports(manifest, sub ? "." + sub : ".", {
        browser: this.platform === "browser",
        require,
        conditions:
          this.platform === "worker" ? ["workerd", "worker"] : ["browser"],
      });
      if (!resolved?.length)
        throw Error("Package export unavailable: " + specifier);
      target = resolved[0];
    } else
      target = sub
        ? "." + sub
        : this.platform === "browser" && typeof manifest.browser === "string"
          ? manifest.browser
          : (!require && manifest.module) || manifest.main || "index.js";
    const path = normalizePath(root + "/" + target);
    if (!path.startsWith(root + "/"))
      throw Error("Package export escapes root");
    const found = this.file(path);
    if (!found) throw Error("Package entry unavailable: " + specifier);
    return found;
  }
}
