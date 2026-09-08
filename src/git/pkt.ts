import { fail } from "../security";
import { bytes, concat, text } from "./objects";
export const FLUSH = bytes("0000"),
  DELIM = bytes("0001");
export function pkt(payload: string | Uint8Array) {
  const data = typeof payload === "string" ? bytes(payload) : payload;
  if (data.length > 65516) fail(400, "pkt-line too large");
  return concat(bytes((data.length + 4).toString(16).padStart(4, "0")), data);
}
export function readPackets(data: Uint8Array, stopAtFlush = false) {
  const packets: (Uint8Array | null | "delimiter" | "end")[] = [];
  let pos = 0;
  while (pos < data.length) {
    if (pos + 4 > data.length) fail(400, "Truncated pkt-line header");
    const h = text(data.subarray(pos, pos + 4));
    if (!/^[0-9a-fA-F]{4}$/.test(h)) fail(400, "Invalid pkt-line header");
    const len = parseInt(h, 16);
    pos += 4;
    if (len < 4) {
      if (len === 3) fail(400, "Invalid pkt-line length");
      packets.push(len === 0 ? null : len === 1 ? "delimiter" : "end");
      if (stopAtFlush && len === 0) break;
      continue;
    }
    if (len > 65520 || pos + len - 4 > data.length)
      fail(400, "Truncated pkt-line payload");
    packets.push(data.subarray(pos, pos + len - 4));
    pos += len - 4;
  }
  return { packets, offset: pos };
}
export function band(data: Uint8Array) {
  const chunks: Uint8Array[] = [];
  for (let pos = 0; pos < data.length; pos += 65515)
    chunks.push(pkt(concat(Uint8Array.of(1), data.subarray(pos, pos + 65515))));
  return concat(...chunks, FLUSH);
}
