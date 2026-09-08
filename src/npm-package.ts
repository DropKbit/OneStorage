import { Inflate } from "pako";
import { z } from "zod";
import {
  PACKAGE_LIMIT,
  packageName,
  npmVersion,
  npmTag,
  npmFile,
  type PackageSpec,
} from "./package-schema";
import { fail, hex } from "./security";
import { base64 } from "./base64";
const decode = new TextDecoder("utf-8", { fatal: true });
const record = z.record(z.string(), z.unknown());
/** Inspect headers and the manifest incrementally; never retain the expanded archive. */
export function npmManifest(compressed: Uint8Array): Record<string, unknown> {
  if (compressed[0] !== 31 || compressed[1] !== 139)
    fail(400, "npm attachment must be gzip");
  let total = 0,
    entries = 0,
    pathBytes = 0,
    headerUsed = 0,
    remaining = 0,
    padding = 0,
    zeros = 0;
  let capture: Uint8Array | null = null,
    captureUsed = 0,
    captureKind = "",
    manifest: Record<string, unknown> | undefined;
  let nextPath: string | undefined, nextSize: number | undefined;
  const header = new Uint8Array(512),
    seen = new Set<string>();
  const text = (a: Uint8Array) =>
    decode.decode(a.subarray(0, a.indexOf(0) < 0 ? a.length : a.indexOf(0)));
  const octal = (a: Uint8Array) => {
    const s = text(a).trim();
    if (!/^[0-7]*$/.test(s)) fail(400, "Invalid tar number");
    const n = parseInt(s || "0", 8);
    if (!Number.isSafeInteger(n)) fail(400, "Invalid tar size");
    return n;
  };
  const finish = () => {
    if (!capture) return;
    if (captureKind === "manifest") {
      try {
        manifest = record.parse(JSON.parse(decode.decode(capture)));
      } catch {
        fail(400, "Invalid package/package.json");
      }
    } else if (captureKind === "L") nextPath = text(capture).replace(/\n$/, "");
    else {
      let at = 0;
      while (at < capture.length) {
        const space = capture.indexOf(32, at);
        if (space < 0 || space - at > 10) fail(400, "Invalid PAX record");
        const lengthString = decode.decode(capture.subarray(at, space));
        if (!/^[1-9][0-9]*$/.test(lengthString))
          fail(400, "Invalid PAX length");
        const length = Number(lengthString),
          end = at + length;
        if (end > capture.length || end <= space + 2 || capture[end - 1] !== 10)
          fail(400, "Invalid PAX length");
        const line = decode.decode(capture.subarray(space + 1, end - 1)),
          eq = line.indexOf("=");
        if (eq < 1) fail(400, "Invalid PAX field");
        const key = line.slice(0, eq),
          value = line.slice(eq + 1);
        if (key === "path") nextPath = value;
        if (key === "size") {
          if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value)))
            fail(400, "Invalid PAX size");
          nextSize = Number(value);
        }
        if (key === "linkpath" || key.startsWith("GNU.sparse"))
          fail(400, "Linked and sparse npm entries are unsupported");
        at = end;
      }
    }
    capture = null;
  };
  let complete = false;
  const inflate = new Inflate({ chunkSize: 16384 });
  const onEnd = inflate.onEnd.bind(inflate);
  inflate.onEnd = (status) => {
    complete = status === 0;
    onEnd(status);
  };
  inflate.onData = (chunk: Uint8Array) => {
    total += chunk.length;
    if (total > PACKAGE_LIMIT.expanded)
      fail(413, "Expanded npm archive exceeds 64 MiB");
    let at = 0;
    while (at < chunk.length) {
      if (remaining) {
        const n = Math.min(remaining, chunk.length - at);
        if (capture) {
          capture.set(chunk.subarray(at, at + n), captureUsed);
          captureUsed += n;
        }
        remaining -= n;
        at += n;
        if (!remaining) finish();
      } else if (padding) {
        const n = Math.min(padding, chunk.length - at);
        if (chunk.subarray(at, at + n).some((x) => x !== 0))
          fail(400, "Invalid tar padding");
        padding -= n;
        at += n;
      } else {
        const n = Math.min(512 - headerUsed, chunk.length - at);
        header.set(chunk.subarray(at, at + n), headerUsed);
        headerUsed += n;
        at += n;
        if (headerUsed !== 512) continue;
        headerUsed = 0;
        if (header.every((x) => x === 0)) {
          zeros++;
          continue;
        }
        if (zeros) fail(400, "Data follows tar end marker");
        if (++entries > PACKAGE_LIMIT.entries)
          fail(413, "Too many npm archive entries");
        const checksum = header.reduce(
          (sum, x, i) => sum + (i >= 148 && i < 156 ? 32 : x),
          0,
        );
        if (octal(header.subarray(148, 156)) !== checksum)
          fail(400, "Invalid tar checksum");
        let path = text(header.subarray(0, 100));
        const prefix = text(header.subarray(345, 500));
        if (prefix) path = prefix + "/" + path;
        const kind = String.fromCharCode(header[156] || 48),
          size = octal(header.subarray(124, 136));
        if (size > PACKAGE_LIMIT.expanded)
          fail(413, "npm archive entry too large");
        remaining = size;
        padding = (512 - (size % 512)) % 512;
        if (kind === "x" || kind === "L") {
          if (size > PACKAGE_LIMIT.metadata || size === 0)
            fail(400, "Invalid extended tar header");
          capture = new Uint8Array(size);
          captureUsed = 0;
          captureKind = kind;
          continue;
        }
        if (nextPath !== undefined) path = nextPath;
        if (nextSize !== undefined && nextSize !== size)
          fail(400, "PAX size disagrees with tar header");
        nextPath = undefined;
        nextSize = undefined;
        path = path.replace(/\/$/, "");
        if (
          path.length > 4096 ||
          /[\\\x00-\x1f\x7f]/.test(path) ||
          (!path.startsWith("package/") && path !== "package") ||
          path.split("/").some((x) => !x || x === "." || x === "..")
        )
          fail(400, "Unsafe npm archive path");
        pathBytes += path.length;
        if (pathBytes > 2 * 1024 * 1024)
          fail(413, "npm archive paths too large");
        if (seen.has(path)) fail(400, "Duplicate npm archive path");
        seen.add(path);
        if ((kind !== "0" && kind !== "5") || (kind === "5" && size !== 0))
          fail(
            400,
            "Only regular files and directories are supported in npm packages",
          );
        if (path === "package/package.json") {
          if (kind !== "0" || !size || size > PACKAGE_LIMIT.metadata)
            fail(400, "Invalid npm manifest size");
          capture = new Uint8Array(size);
          captureUsed = 0;
          captureKind = "manifest";
        }
      }
    }
  };
  try {
    // Feed bounded compressed chunks so cancellation and output limits apply while inflating.
    for (let at = 0; at < compressed.length; at += 16384)
      inflate.push(
        compressed.subarray(at, at + 16384),
        at + 16384 >= compressed.length,
      );
  } catch (e) {
    if (e instanceof Error && e.name === "HTTPException") throw e;
    fail(400, "Invalid gzip or tar archive");
  }
  if (
    inflate.err ||
    !complete ||
    remaining ||
    padding ||
    headerUsed ||
    zeros < 2 ||
    nextPath !== undefined ||
    nextSize !== undefined ||
    !manifest
  )
    fail(400, "Incomplete npm archive or missing package/package.json");
  return manifest;
}
export async function parseNpmPublish(name: string, input: unknown) {
  packageName.parse(name);
  const b = record.parse(input),
    versions = record.parse(b.versions),
    attachments = record.parse(b._attachments);
  if (
    b.name !== name ||
    Object.keys(versions).length !== 1 ||
    Object.keys(attachments).length !== 1
  )
    fail(400, "Publish exactly one package version and attachment");
  const version = npmVersion.parse(Object.keys(versions)[0]),
    supplied = record.parse(versions[version]);
  if (supplied.name !== name || supplied.version !== version)
    fail(400, "npm publish metadata differs from package identity");
  const attachmentName = Object.keys(attachments)[0];
  if (attachmentName !== `${name}-${version}.tgz`)
    fail(400, "npm attachment name differs from package identity");
  const filename = npmFile.parse(`${name.split("/").at(-1)}-${version}.tgz`),
    attachment = record.parse(attachments[attachmentName]);
  if (
    !filename.endsWith(".tgz") ||
    typeof attachment.data !== "string" ||
    attachment.data.length > Math.ceil(PACKAGE_LIMIT.npm / 3) * 4 ||
    attachment.data.length % 4 !== 0 ||
    /[^A-Za-z0-9+/]/.test(attachment.data.replace(/={1,2}$/, ""))
  )
    fail(400, "Invalid npm attachment");
  const size =
    (attachment.data.length / 4) * 3 -
    (attachment.data.endsWith("==")
      ? 2
      : attachment.data.endsWith("=")
        ? 1
        : 0);
  if (size < 1 || size > PACKAGE_LIMIT.npm)
    fail(413, "npm tarball must be 1..16 MiB");
  if (attachment.length !== size) fail(400, "npm attachment length mismatch");
  const bytes = new Uint8Array(size);
  for (
    let start = 0, offset = 0;
    start < attachment.data.length;
    start += 32768
  ) {
    const chunk = atob(attachment.data.slice(start, start + 32768));
    for (let i = 0; i < chunk.length; i++)
      bytes[offset++] = chunk.charCodeAt(i);
  }
  const metadata = npmManifest(bytes);
  if (
    metadata.name !== name ||
    metadata.version !== version ||
    metadata.private === true
  )
    fail(400, "Tarball manifest does not match publish identity or is private");
  const [sha256, sha1, sha512] = await Promise.all(
    ["SHA-256", "SHA-1", "SHA-512"].map((a) => crypto.subtle.digest(a, bytes)),
  );
  const dist = supplied.dist === undefined ? {} : record.parse(supplied.dist);
  if (
    (dist.shasum !== undefined && dist.shasum !== hex(sha1)) ||
    (dist.integrity !== undefined &&
      dist.integrity !== "sha512-" + base64(new Uint8Array(sha512)))
  )
    fail(400, "npm integrity mismatch");
  const tags =
    b["dist-tags"] === undefined
      ? { latest: version }
      : record.parse(b["dist-tags"]);
  if (!Object.keys(tags).length || Object.keys(tags).length > 32)
    fail(400, "Publish needs 1..32 dist-tags");
  for (const [tag, target] of Object.entries(tags)) {
    npmTag.parse(tag);
    if (target !== version)
      fail(400, "Publish tags must reference this version");
  }
  delete metadata.dist;
  delete metadata._rev;
  delete metadata._attachments;
  const spec: PackageSpec = {
    kind: "npm",
    name,
    version,
    filename,
    size,
    metadata,
    tags: Object.keys(tags),
    sha256: hex(sha256),
    sha1: hex(sha1),
    sha512: base64(new Uint8Array(sha512)),
  };
  return { bytes, spec, access: b.access };
}
