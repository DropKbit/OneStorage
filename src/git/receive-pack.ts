import { Inflate } from "pako";
import { HTTPException } from "hono/http-exception";
import { fail } from "../security";
import {
  LIMITS,
  type GitObject,
  type ObjectType,
  makeObject,
  sha1,
  text,
  toHex,
} from "./objects";
import { applyDelta } from "./pack";
import { ReceiveReader, RECEIVE_LIMITS } from "./receive-reader";
import type { IncomingSink } from "./incoming-area";

interface Entry {
  offset: number;
  type: number;
  size: number;
  baseOffset?: number;
  baseOid?: string;
  oid?: string;
  depth?: number;
  digest?: string;
}
const types: Record<number, ObjectType> = {
  1: "commit",
  2: "tree",
  3: "blob",
  4: "tag",
};

/** Inflate exactly one zlib member. Only consumed input contributes to the pack hash. */
async function member(reader: ReceiveReader, size: number) {
  const data = new Uint8Array(size);
  let written = 0;
  const inflater = new Inflate({
    windowBits: 15,
    chunkSize: 16384,
  }) as Inflate & { ended: boolean; strm: { next_in: number } };
  inflater.onData = (value) => {
    const chunk = value as Uint8Array;
    if (written + chunk.length > size)
      fail(413, "Inflated Git object exceeds declared size");
    data.set(chunk, written);
    written += chunk.length;
  };
  while (!inflater.ended) {
    const chunk = await reader.chunk();
    if (!chunk) fail(400, "Truncated zlib stream");
    inflater.push(chunk, false);
    if (inflater.err) fail(400, "Invalid zlib stream");
    const consumed = inflater.strm.next_in;
    if (!consumed && !inflater.ended)
      fail(400, "Zlib decoder made no progress");
    reader.advance(consumed);
  }
  if (written !== size) fail(400, "Pack object size mismatch");
  return data;
}

/** Metadata stays in memory; object bytes and unresolved deltas live in the upload's R2 quarantine. */
export async function parseReceivePack(
  reader: ReceiveReader,
  sink: IncomingSink,
) {
  const start = reader.position;
  reader.startHash();
  const header = await reader.read(12),
    view = new DataView(header.buffer);
  if (
    text(header.subarray(0, 4)) !== "PACK" ||
    ![2, 3].includes(view.getUint32(4))
  )
    fail(400, "Invalid PACK header/version");
  const count = view.getUint32(8);
  if (count > RECEIVE_LIMITS.objects) fail(413, "Pack exceeds 25000 objects");
  const entries: Entry[] = [],
    byOffset = new Map<number, Entry>(),
    byOid = new Map<string, Entry>();
  let expanded = 0,
    peakPayload = 0;
  const charge = (n: number) => {
    expanded += n;
    if (expanded > RECEIVE_LIMITS.expanded)
      fail(413, "Pack expansion exceeds 256 MiB");
  };
  const save = async (entry: Entry, object: GitObject, depth: number) => {
    entry.oid = object.oid;
    entry.depth = depth;
    byOid.set(object.oid, entry);
    await sink.save(object);
  };
  for (let i = 0; i < count; i++) {
    const offset = reader.position - start;
    let b = await reader.byte(),
      size = b & 15,
      shift = 4;
    const type = (b >> 4) & 7;
    while (b & 128) {
      if (shift > 28) fail(400, "Invalid pack size");
      b = await reader.byte();
      size += (b & 127) * 2 ** shift;
      shift += 7;
    }
    if (size > LIMITS.object) fail(413, "Pack object exceeds 8 MiB");
    if (!types[type] && type !== 6 && type !== 7)
      fail(400, "Unsupported pack object type");
    const entry: Entry = { offset, type, size };
    if (type === 6) {
      b = await reader.byte();
      let distance = b & 127,
        rounds = 0;
      while (b & 128) {
        if (++rounds > 7) fail(400, "Invalid delta offset");
        b = await reader.byte();
        distance = (distance + 1) * 128 + (b & 127);
        if (!Number.isSafeInteger(distance)) fail(400, "Invalid delta offset");
      }
      entry.baseOffset = offset - distance;
      if (!byOffset.has(entry.baseOffset))
        fail(400, "OFS_DELTA must point to an earlier object");
    } else if (type === 7) entry.baseOid = toHex(await reader.read(20));
    charge(size);
    const data = await member(reader, size);
    peakPayload = Math.max(peakPayload, data.length);
    if (types[type]) await save(entry, await makeObject(types[type], data), 0);
    else {
      entry.digest = await sha1(data);
      await sink.delta(offset, data);
    }
    entries.push(entry);
    byOffset.set(offset, entry);
  }
  const digest = reader.digest(),
    expected = toHex(await reader.read(20));
  if (digest !== expected) fail(400, "Pack checksum mismatch");
  if (await reader.chunk()) fail(400, "Trailing bytes in pack");
  await sink.settle();
  let remaining = entries.filter((e) => !e.oid);
  const unavailable = new Map<string, unknown>();
  for (let pass = 0; remaining.length && pass <= LIMITS.depth; pass++) {
    let progress = false;
    for (const entry of remaining) {
      const prior =
        entry.baseOffset !== undefined
          ? byOffset.get(entry.baseOffset)
          : byOid.get(entry.baseOid!);
      let base: GitObject | undefined;
      if (prior?.oid) base = await sink.load(prior.oid);
      else if (entry.baseOid && !unavailable.has(entry.baseOid)) {
        try {
          base = await sink.load(entry.baseOid);
        } catch (error) {
          unavailable.set(entry.baseOid, error);
        }
      }
      if (!base) continue;
      const depth = (prior?.depth || 0) + 1;
      if (depth > LIMITS.depth) fail(400, "Delta chain exceeds 64");
      const data = await sink.loadDelta(entry.offset);
      if (data.length !== entry.size || (await sha1(data)) !== entry.digest)
        fail(409, "Incoming delta integrity mismatch");
      const output = applyDelta(base.data, data);
      charge(output.length);
      peakPayload = Math.max(
        peakPayload,
        base.data.length + data.length + output.length,
      );
      await save(entry, await makeObject(base.type, output), depth);
      progress = true;
    }
    remaining = remaining.filter((e) => !e.oid);
    if (!progress) {
      for (const entry of remaining)
        if (entry.baseOid && unavailable.has(entry.baseOid)) {
          const error = unavailable.get(entry.baseOid);
          if (!(
            error instanceof HTTPException &&
            error.status === 409 &&
            error.message === "Missing Git object " + entry.baseOid
          ))
            throw error;
        }
      fail(400, "Unresolved or cyclic delta base");
    }
  }
  if (remaining.length) fail(400, "Delta chain too deep");
  await sink.settle();
  return {
    objects: count,
    expandedBytes: expanded,
    peakPayloadBytes: peakPayload,
    packBytes: reader.position - start,
  };
}
