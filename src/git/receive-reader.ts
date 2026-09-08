import { createHash } from "node:crypto";
import { fail } from "../security";
import { text, concat } from "./objects";

export const RECEIVE_LIMITS = {
  wire: 64 * 1024 * 1024,
  expanded: 256 * 1024 * 1024,
  objects: 25000,
  headers: 128 * 1024,
  chunk: 1024 * 1024,
  idleMs: 20000,
};

/** No read-ahead. Prefer BYOB so native request chunks remain bounded independently of upload size. */
export class ReceiveReader {
  private reader:
    ReadableStreamDefaultReader<Uint8Array> | ReadableStreamBYOBReader;
  readonly byob: boolean;
  private buffer: Uint8Array = new Uint8Array();
  private offset = 0;
  private ended = false;
  private hashing = false;
  private hash = createHash("sha1");
  position = 0;
  received = 0;
  peakChunk = 0;
  constructor(
    body: ReadableStream<Uint8Array>,
    private idleMs = RECEIVE_LIMITS.idleMs,
    private chunkLimit = RECEIVE_LIMITS.chunk,
  ) {
    try {
      this.reader = body.getReader({ mode: "byob" });
      this.byob = true;
    } catch {
      this.reader = body.getReader();
      this.byob = false;
    }
  }
  async chunk(): Promise<Uint8Array | null> {
    let empty = 0;
    while (this.offset === this.buffer.length) {
      if (this.ended) return null;
      let timer: ReturnType<typeof setTimeout>;
      try {
        const result = await Promise.race([
          this.byob
            ? (this.reader as ReadableStreamBYOBReader).read(
                new Uint8Array(65536),
              )
            : (this.reader as ReadableStreamDefaultReader<Uint8Array>).read(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(Error("Git upload idle timeout")),
              this.idleMs,
            );
          }),
        ]);
        if (result.done) {
          this.ended = true;
          this.buffer = new Uint8Array();
          return null;
        }
        const value = result.value!;
        this.received += value.byteLength;
        this.peakChunk = Math.max(this.peakChunk, value.byteLength);
        if (this.received > RECEIVE_LIMITS.wire)
          fail(413, "Git upload exceeds 64 MiB");
        if (value.byteLength > this.chunkLimit)
          fail(413, "Git transport chunk exceeds memory budget");
        this.buffer = value;
        this.offset = 0;
        if (!value.byteLength && ++empty > 1024)
          fail(400, "Empty upload stream chunks");
      } finally {
        clearTimeout(timer!);
      }
    }
    return this.buffer.subarray(
      this.offset,
      Math.min(this.buffer.length, this.offset + 16384),
    );
  }
  advance(n: number) {
    if (n < 0 || n > this.buffer.length - this.offset)
      throw Error("Invalid receive cursor");
    if (this.hashing)
      this.hash.update(this.buffer.subarray(this.offset, this.offset + n));
    this.offset += n;
    this.position += n;
  }
  async read(n: number) {
    const out = new Uint8Array(n);
    let offset = 0;
    while (offset < n) {
      const chunk = await this.chunk();
      if (!chunk) fail(400, "Truncated Git upload");
      const size = Math.min(n - offset, chunk.length);
      out.set(chunk.subarray(0, size), offset);
      this.advance(size);
      offset += size;
    }
    return out;
  }
  async byte() {
    return (await this.read(1))[0];
  }
  startHash() {
    this.hashing = true;
  }
  digest() {
    this.hashing = false;
    return this.hash.digest("hex");
  }
  async close() {
    try {
      if (!this.ended) await this.reader.cancel();
    } catch {
    } finally {
      this.reader.releaseLock();
      this.ended = true;
      this.buffer = new Uint8Array();
    }
  }
}

export async function receiveHeader(reader: ReceiveReader) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (let count = 0; ; count++) {
    if (count > 256) fail(400, "Too many receive commands");
    const header = await reader.read(4),
      raw = text(header);
    if (!/^[0-9a-fA-F]{4}$/.test(raw)) fail(400, "Invalid pkt-line header");
    const length = parseInt(raw, 16);
    chunks.push(header);
    size += 4;
    if (!length) return concat(...chunks);
    if (length < 4 || length > 65520)
      fail(400, "Invalid receive pkt-line length");
    size += length - 4;
    if (size > RECEIVE_LIMITS.headers)
      fail(413, "Receive command headers exceed budget");
    chunks.push(await reader.read(length - 4));
  }
}
