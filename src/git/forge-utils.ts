import { RE2JS } from "re2js";
import { fail } from "../security";
import { base64, unbase64 } from "./signatures";
import { bytes, text, concat, TreeEntry } from "./objects";
export interface PageOptions {
  cursor?: string;
  limit?: number | string;
}
export function paginate<T>(
  all: T[],
  options: PageOptions,
  key: string,
  maximum = 1000,
) {
  const limit = Number(options.limit ?? 100);
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum)
    fail(400, "Invalid page limit");
  let offset = 0;
  if (options.cursor) {
    if (options.cursor.length > 8192) fail(400, "Invalid cursor");
    let decoded;
    try {
      decoded = JSON.parse(
        text(
          unbase64(
            options.cursor
              .replace(/-/g, "+")
              .replace(/_/g, "/")
              .padEnd(Math.ceil(options.cursor.length / 4) * 4, "="),
          ),
        ),
      );
    } catch {
      fail(400, "Invalid cursor");
    }
    if (decoded.key !== key)
      fail(409, "Cursor belongs to a different revision or query");
    offset = decoded.offset;
    if (!Number.isInteger(offset) || offset < 0 || offset > all.length)
      fail(400, "Invalid cursor offset");
  }
  const items = all.slice(offset, offset + limit),
    has_more = offset + limit < all.length,
    next_cursor = has_more
      ? base64(bytes(JSON.stringify({ key, offset: offset + limit })))
          .replace(/=+$/, "")
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
      : null;
  return { items, has_more, next_cursor };
}
export const lineTokens = (value: string) =>
  value.match(/[^\n]*\n|[^\n]+$/g) || [];
export function matchesGlob(path: string, pattern: string) {
  if (pattern.length > 300) fail(400, "Glob too long");
  let source = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          source += "(?:.*/)?";
        } else source += ".*";
      } else source += "[^/]*";
    } else if (ch === "?") source += "[^/]";
    else source += ch.replace(/[\^$.*+?()[\]{}|\\]/g, "\\$&");
  }
  return RE2JS.compile(source + "$")
    .matcher(path)
    .matches();
}
export function pathFilter(
  path: string,
  options: {
    include_globs?: string[];
    exclude_globs?: string[];
    paths?: string[];
    extension_filters?: string[];
  },
) {
  for (const a of [
    options.include_globs,
    options.exclude_globs,
    options.paths,
    options.extension_filters,
  ])
    if (
      a &&
      (!Array.isArray(a) ||
        a.length > 50 ||
        a.some((x) => typeof x !== "string"))
    )
      fail(400, "Invalid file filter");
  return (
    (!options.paths?.length ||
      options.paths.some(
        (p) => path === p || path.startsWith(p.replace(/\/$/, "") + "/"),
      )) &&
    (!options.include_globs?.length ||
      options.include_globs.some((g) => matchesGlob(path, g))) &&
    !options.exclude_globs?.some((g) => matchesGlob(path, g)) &&
    (!options.extension_filters?.length ||
      options.extension_filters.some((e) => path.endsWith(e)))
  );
}
export function identity(value: {
  name: string;
  email: string;
  timestamp?: number;
}) {
  if (
    !value ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    typeof value.email !== "string" ||
    !value.email.trim() ||
    /[\r\n<>\0]/.test(value.name + value.email) ||
    value.name.length > 200 ||
    value.email.length > 254
  )
    fail(400, "Invalid commit identity");
  const time = value.timestamp ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(time) || time < 0)
    fail(400, "Invalid commit timestamp");
  return `${value.name} <${value.email}> ${time} +0000`;
}
export function parseIdentity(value: string) {
  const m = value.match(/^(.*) <([^>]*)> (-?\d+) ([+-]\d{4})$/);
  if (!m)
    return {
      name: value,
      email: "",
      date: new Date(0).toISOString(),
      timestamp: 0,
    };
  const time = Number(m[3]);
  return {
    name: m[1],
    email: m[2],
    date:
      Math.abs(time) < 8640000000000
        ? new Date(time * 1000).toISOString()
        : new Date(0).toISOString(),
    timestamp: time,
  };
}
export function tarHeader(
  path: string,
  size: number,
  mode: number,
  type = "0",
  link = "",
  mtime = 0,
) {
  const out = new Uint8Array(512);
  const put = (s: string, offset: number, length?: number) => {
    const v = bytes(s);
    if (length && v.length > length) fail(400, "Tar field too long");
    out.set(v, offset);
  };
  put(path, 0, 100);
  put(mode.toString(8).padStart(7, "0") + "\0", 100);
  put("0000000\0", 108);
  put("0000000\0", 116);
  put(size.toString(8).padStart(11, "0") + "\0", 124);
  put(Math.max(0, mtime).toString(8).padStart(11, "0") + "\0", 136);
  out.fill(32, 148, 156);
  put(type, 156);
  put(link, 157, 100);
  put("ustar\0", 257);
  put("00", 263);
  put("OneStorage", 265);
  put("OneStorage", 297);
  const sum = out.reduce((n, b) => n + b, 0);
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return out;
}
export function paxField(key: string, value: string) {
  const raw = ` ${key}=${value}\n`;
  let n = bytes(raw).length + 1;
  while (String(n).length + bytes(raw).length !== n)
    n = String(n).length + bytes(raw).length;
  return bytes(n + raw);
}
export async function* tarEntries(
  entries: AsyncIterable<{ path: string; data: Uint8Array; mode: string }>,
  prefix = "",
  mtime = 0,
) {
  if (
    prefix &&
    (prefix.startsWith("/") ||
      prefix.split("/").some((p) => p === ".." || p === ".") ||
      /[\0\r\n]/.test(prefix))
  )
    fail(400, "Invalid archive prefix");
  if (prefix && !prefix.endsWith("/")) prefix += "/";
  let i = 0;
  for await (const e of entries) {
    const full = prefix + e.path,
      isLink = e.mode === "120000",
      link = isLink ? text(e.data) : "",
      pax = [];
    if (bytes(full).length > 100) pax.push(paxField("path", full));
    if (bytes(link).length > 100) pax.push(paxField("linkpath", link));
    if (pax.length) {
      const p = concat(...pax);
      yield tarHeader(`PaxHeaders/${i}`, p.length, 0o644, "x", "", mtime);
      yield p;
      yield new Uint8Array((512 - (p.length % 512)) % 512);
    }
    const data = isLink ? new Uint8Array() : e.data;
    yield tarHeader(
      bytes(full).length > 100 ? `entry-${i}` : full,
      data.length,
      e.mode === "100755" ? 0o755 : 0o644,
      isLink ? "2" : "0",
      bytes(link).length > 100 ? "" : link,
      mtime,
    );
    if (!isLink) {
      yield data;
      yield new Uint8Array((512 - (data.length % 512)) % 512);
    }
    i++;
  }
  yield new Uint8Array(1024);
}
export function streamFrom<T>(iterator: AsyncIterator<T>) {
  return new ReadableStream<T>({
    async pull(controller) {
      try {
        const value = await iterator.next();
        if (value.done) controller.close();
        else controller.enqueue(value.value);
      } catch (e) {
        controller.error(e);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}
