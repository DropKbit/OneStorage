/** One-time, in-Worker import of v0.1 server-generated tar snapshots. Never invokes tar or Git. */
import { fail } from "../security";
import {
  ObjectStore,
  Refs,
  readCanonical,
  text,
  checkRefs,
  LIMITS,
  parseCommit,
} from "./objects";
import { inflateMember, parsePack } from "./pack";
import { RefStorage, publishRefs } from "./repository";
function string(data: Uint8Array) {
  const end = data.indexOf(0);
  return text(end < 0 ? data : data.subarray(0, end));
}
export async function importSnapshot(
  data: Uint8Array,
  store: ObjectStore,
  storage: RefStorage,
) {
  const files = new Map<string, Uint8Array>();
  let pos = 0,
    paxPath: string | undefined;
  while (pos + 512 <= data.length) {
    const header = data.subarray(pos, pos + 512);
    if (header.every((b) => b === 0)) break;
    const expected = parseInt(string(header.subarray(148, 156)).trim(), 8);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
    if (sum !== expected) fail(400, "Legacy tar checksum mismatch");
    const size = parseInt(string(header.subarray(124, 136)).trim() || "0", 8);
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      pos + 512 + size > data.length
    )
      fail(400, "Invalid legacy tar size");
    const type = header[156],
      content = data.subarray(pos + 512, pos + 512 + size);
    let name = string(header.subarray(0, 100)),
      prefix = string(header.subarray(345, 500));
    if (prefix) name = prefix + "/" + name;
    pos += 512 + Math.ceil(size / 512) * 512;
    if (type === 120 || type === 103) {
      for (const line of text(content).split("\n")) {
        const m = line.match(/^\d+ path=(.*)$/);
        if (m) paxPath = m[1];
      }
      continue;
    }
    if (paxPath) {
      name = paxPath;
      paxPath = undefined;
    }
    name = name.replace(/^\.\//, "");
    if (name.split("/").includes("..") || name.startsWith("/"))
      fail(400, "Unsafe legacy archive path");
    if (type === 53) continue;
    if (type !== 0 && type !== 48)
      fail(400, "Unsupported legacy archive entry");
    // macOS bsdtar may attach AppleDouble metadata beside real files.
    if (
      name.split("/").at(-1)?.startsWith("._") &&
      content.length >= 4 &&
      new DataView(content.buffer, content.byteOffset, 4).getUint32(0) ===
        0x00051607
    )
      continue;
    if (files.has(name)) fail(400, "Duplicate legacy archive entry");
    files.set(name, content);
  }
  const refs: Refs = {};
  for (const [name, content] of files) {
    if (/^objects\/[0-9a-f]{2}\/[0-9a-f]{38}$/.test(name)) {
      const unpacked = inflateMember(content, LIMITS.object + 64);
      if (unpacked.consumed !== content.length)
        fail(400, "Trailing legacy object data");
      store.add(
        await readCanonical(
          unpacked.data,
          name.replace("objects/", "").replace("/", ""),
        ),
      );
    } else if (/^refs\/(heads|tags)\//.test(name))
      refs[name] = text(content).trim();
  }
  for (const [name, content] of files)
    if (/^objects\/pack\/pack-[0-9a-f]{40}\.pack$/.test(name))
      for (const o of await parsePack(content, (id) => store.get(id)))
        store.add(o);
  const packed = files.get("packed-refs");
  if (packed)
    for (const line of text(packed).split("\n")) {
      if (!line || line.startsWith("#") || line.startsWith("^")) continue;
      const space = line.indexOf(" "),
        ref = line.slice(space + 1);
      if (!refs[ref]) refs[ref] = line.slice(0, space);
    }
  checkRefs(refs);
  await store.walk(Object.values(refs));
  for (const [ref, oid] of Object.entries(refs))
    if (ref.startsWith("refs/heads/")) parseCommit(await store.get(oid));
  await publishRefs(store, storage, refs);
  return refs;
}
