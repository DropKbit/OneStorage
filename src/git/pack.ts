import { Inflate, deflate } from "pako";
import { HTTPException } from "hono/http-exception";
import { fail } from "../security";
import {
  LIMITS,
  GitObject,
  ObjectType,
  concat,
  bytes,
  text,
  sha1,
  toHex,
  fromHex,
  makeObject,
} from "./objects";
const TYPES: Record<number, ObjectType> = {
  1: "commit",
  2: "tree",
  3: "blob",
  4: "tag",
};
/** Decode one zlib member, track consumed bytes, cap expansion before allocating its result. */
export function inflateMember(input: Uint8Array, max = LIMITS.object) {
  if (
    input.length < 6 ||
    (input[0] & 15) !== 8 ||
    (input[0] * 256 + input[1]) % 31 !== 0 ||
    input[1] & 32
  )
    fail(400, "Invalid zlib header");
  const stream = new Inflate({
    chunkSize: 16384,
    windowBits: 15,
  }) as Inflate & { ended: boolean; strm: { total_in: number } };
  let size = 0;
  const chunks: Uint8Array[] = [];
  stream.onData = (chunk) => {
    size += (chunk as Uint8Array).length;
    if (size > max) fail(413, "Inflated Git object exceeds limit");
    chunks.push(chunk as Uint8Array);
  };
  // Feed incrementally: pako's default concatenated-member logic must not eat a following pack header.
  let supplied = 0;
  while (!stream.ended && supplied < input.length) {
    const n = Math.min(16384, input.length - supplied);
    stream.push(input.subarray(supplied, supplied + n), false);
    supplied += n;
    if (stream.err) fail(400, "Invalid zlib stream");
  }
  if (!stream.ended || stream.err) fail(400, "Truncated zlib stream");
  const state = (stream as unknown as { strm: { total_in: number } }).strm;
  return { data: concat(...chunks), consumed: state.total_in };
}
function varint(data: Uint8Array, state: { pos: number }) {
  let value = 0,
    shift = 0;
  while (true) {
    if (state.pos >= data.length || shift > 28) fail(400, "Invalid delta size");
    const b = data[state.pos++];
    value += (b & 127) * 2 ** shift;
    if (!Number.isSafeInteger(value)) fail(400, "Delta size overflow");
    if (!(b & 128)) break;
    shift += 7;
  }
  return value;
}
export function applyDelta(base: Uint8Array, delta: Uint8Array) {
  const state = { pos: 0 },
    baseSize = varint(delta, state),
    size = varint(delta, state);
  if (baseSize !== base.length) fail(400, "Delta base size mismatch");
  if (size > LIMITS.object) fail(413, "Delta result exceeds 8 MiB");
  const out = new Uint8Array(size);
  let at = 0;
  while (state.pos < delta.length) {
    const op = delta[state.pos++];
    if (op & 128) {
      let offset = 0,
        count = 0;
      for (let i = 0; i < 4; i++)
        if (op & (1 << i)) {
          if (state.pos >= delta.length) fail(400, "Truncated delta copy");
          offset += delta[state.pos++] * 2 ** (8 * i);
        }
      for (let i = 0; i < 3; i++)
        if (op & (16 << i)) {
          if (state.pos >= delta.length) fail(400, "Truncated delta copy");
          count += delta[state.pos++] * 2 ** (8 * i);
        }
      if (!count) count = 65536;
      if (offset + count > base.length || at + count > size)
        fail(400, "Delta copy out of bounds");
      out.set(base.subarray(offset, offset + count), at);
      at += count;
    } else {
      if (!op || state.pos + op > delta.length || at + op > size)
        fail(400, "Invalid delta insert");
      out.set(delta.subarray(state.pos, state.pos + op), at);
      state.pos += op;
      at += op;
    }
  }
  if (at !== size) fail(400, "Delta output size mismatch");
  return out;
}
interface Entry {
  offset: number;
  type: number;
  data: Uint8Array;
  baseOffset?: number;
  baseOid?: string;
  object?: GitObject;
  depth?: number;
}
export async function parsePack(
  pack: Uint8Array,
  external?: (oid: string) => Promise<GitObject>,
): Promise<GitObject[]> {
  if (pack.length < 32 || text(pack.subarray(0, 4)) !== "PACK")
    fail(400, "Invalid PACK header");
  const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength),
    version = view.getUint32(4),
    count = view.getUint32(8);
  if (version !== 2 && version !== 3) fail(400, "Unsupported pack version");
  if (count > LIMITS.objects) fail(413, "Pack exceeds 2000 objects");
  if ((await sha1(pack.subarray(0, -20))) !== toHex(pack.subarray(-20)))
    fail(400, "Pack checksum mismatch");
  const entries: Entry[] = [],
    byOffset = new Map<number, Entry>(),
    byOid = new Map<string, GitObject>(),
    depths = new Map<string, number>();
  let pos = 12,
    total = 0;
  for (let i = 0; i < count; i++) {
    const offset = pos;
    if (pos >= pack.length - 20) fail(400, "Truncated object header");
    let b = pack[pos++],
      size = b & 15,
      shift = 4;
    const type = (b >> 4) & 7;
    while (b & 128) {
      if (pos >= pack.length - 20 || shift > 28) fail(400, "Invalid pack size");
      b = pack[pos++];
      size += (b & 127) * 2 ** shift;
      shift += 7;
    }
    if (size > LIMITS.object) fail(413, "Pack object exceeds 8 MiB");
    if (!TYPES[type] && type !== 6 && type !== 7)
      fail(400, "Unsupported pack object type");
    let baseOffset: number | undefined, baseOid: string | undefined;
    if (type === 6) {
      if (pos >= pack.length - 20) fail(400, "Truncated delta offset");
      b = pack[pos++];
      let distance = b & 127,
        rounds = 0;
      while (b & 128) {
        if (++rounds > 7 || pos >= pack.length - 20)
          fail(400, "Invalid delta offset");
        b = pack[pos++];
        distance = (distance + 1) * 128 + (b & 127);
      }
      baseOffset = offset - distance;
      if (!byOffset.has(baseOffset))
        fail(400, "OFS_DELTA must point to an earlier object");
    }
    if (type === 7) {
      if (pos + 20 > pack.length - 20) fail(400, "Truncated REF_DELTA");
      baseOid = toHex(pack.subarray(pos, pos + 20));
      pos += 20;
    }
    const inflated = inflateMember(pack.subarray(pos, pack.length - 20), size);
    if (inflated.data.length !== size || !inflated.consumed)
      fail(400, "Pack object size mismatch");
    pos += inflated.consumed;
    total += size;
    if (total > LIMITS.expanded) fail(413, "Pack expansion exceeds 32 MiB");
    const e: Entry = { offset, type, data: inflated.data, baseOffset, baseOid };
    if (TYPES[type]) {
      e.object = await makeObject(TYPES[type], e.data);
      e.depth = 0;
      byOid.set(e.object.oid, e.object);
      depths.set(e.object.oid, 0);
    }
    entries.push(e);
    byOffset.set(offset, e);
  }
  if (pos !== pack.length - 20) fail(400, "Trailing bytes in pack");
  let remaining = entries.filter((e) => !e.object);
  const externalCache = new Map<string, GitObject>(),
    missingExternal = new Set<string>(),
    externalFailures = new Map<string, unknown>();
  for (let pass = 0; remaining.length && pass <= LIMITS.depth; pass++) {
    let progress = false;
    for (const e of remaining) {
      let base: GitObject | undefined,
        depth = 0;
      if (e.baseOffset !== undefined) {
        const parent = byOffset.get(e.baseOffset)!;
        base = parent.object;
        depth = (parent.depth || 0) + 1;
      } else {
        base = byOid.get(e.baseOid!);
        depth = (depths.get(e.baseOid!) || 0) + 1;
        if (!base && external && !missingExternal.has(e.baseOid!)) {
          base = externalCache.get(e.baseOid!);
          if (!base) {
            try {
              base = await external(e.baseOid!);
              externalCache.set(e.baseOid!, base);
            } catch (error) {
              missingExternal.add(
                e.baseOid!,
              ); /* A REF_DELTA base may appear later in this pack. */
              if (!(
                error instanceof HTTPException &&
                error.status === 409 &&
                error.message === "Missing Git object " + e.baseOid
              ))
                externalFailures.set(e.baseOid!, error);
            }
          }
        }
      }
      if (!base) continue;
      if (depth > LIMITS.depth) fail(400, "Delta chain exceeds 64");
      const data = applyDelta(base.data, e.data);
      total += data.length;
      if (total > LIMITS.expanded) fail(413, "Resolved pack exceeds 32 MiB");
      e.object = await makeObject(base.type, data);
      e.depth = depth;
      byOid.set(e.object.oid, e.object);
      depths.set(e.object.oid, depth);
      progress = true;
    }
    remaining = remaining.filter((e) => !e.object);
    if (!progress) {
      // First allow later deltas to supply a base. If still unresolved, retain infrastructure failures.
      for (const entry of remaining)
        if (entry.baseOid && externalFailures.has(entry.baseOid))
          throw externalFailures.get(entry.baseOid);
      fail(400, "Unresolved or cyclic delta base");
    }
  }
  if (remaining.length) fail(400, "Delta chain too deep");
  return entries.map((e) => e.object!);
}
export async function writePack(objects: GitObject[]) {
  if (objects.length > LIMITS.graph) fail(413, "Too many objects to fetch");
  const header = new Uint8Array(12);
  header.set(bytes("PACK"));
  new DataView(header.buffer).setUint32(4, 2);
  new DataView(header.buffer).setUint32(8, objects.length);
  const parts = [header];
  let total = 12;
  for (const o of objects) {
    let size = o.data.length;
    const type = Object.entries(TYPES).find(([, name]) => name === o.type)![0];
    let first = (Number(type) << 4) | (size & 15);
    size = Math.floor(size / 16);
    const h = [];
    if (size) first |= 128;
    h.push(first);
    while (size) {
      let b = size & 127;
      size = Math.floor(size / 128);
      if (size) b |= 128;
      h.push(b);
    }
    const body = deflate(o.data);
    total += h.length + body.length;
    if (total > LIMITS.pack) fail(413, "Generated pack exceeds 16 MiB");
    parts.push(Uint8Array.from(h), body);
  }
  const data = concat(...parts);
  return concat(data, fromHex(await sha1(data)));
}
