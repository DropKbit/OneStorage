import { createHash } from "node:crypto";
import { Deflate } from "pako";
import { LIMITS, bytes, type GitObject } from "./objects";
import { fail } from "../security";
import { prefetchObjects, type PrefetchOptions } from "./prefetch";
/** One object at a time. The incremental hash covers the exact header and zlib bytes emitted. */
export async function* packChunks(
  ids: readonly string[],
  load: (oid: string) => Promise<GitObject>,
  prefetch?: PrefetchOptions,
): AsyncGenerator<Uint8Array> {
  if (ids.length > LIMITS.transferGraph)
    fail(413, "Fetch graph exceeds operation budget");
  const hash = createHash("sha1"),
    header = new Uint8Array(12);
  header.set(bytes("PACK"));
  new DataView(header.buffer).setUint32(4, 2);
  new DataView(header.buffer).setUint32(8, ids.length);
  hash.update(header);
  yield header;
  let emitted = 12;
  for await (const object of prefetchObjects(ids, load, prefetch)) {
    let size = object.data.length;
    if (size > LIMITS.object) fail(413, "Git object exceeds 8 MiB");
    const type = { commit: 1, tree: 2, blob: 3, tag: 4 }[object.type],
      entry = [];
    let first = (type << 4) | (size & 15);
    size = Math.floor(size / 16);
    if (size) first |= 128;
    entry.push(first);
    while (size) {
      let value = size & 127;
      size = Math.floor(size / 128);
      if (size) value |= 128;
      entry.push(value);
    }
    const objectHeader = Uint8Array.from(entry);
    hash.update(objectHeader);
    emitted += objectHeader.length;
    yield objectHeader;
    const compressor = new Deflate({ chunkSize: 16384 });
    let chunks: Uint8Array[] = [];
    compressor.onData = (chunk) => {
      chunks.push(chunk as Uint8Array);
    };
    // Bounded input increments prevent synchronous compression from producing an entire large member before backpressure.
    for (
      let offset = 0;
      offset < object.data.length || offset === 0;
      offset += 16384
    ) {
      compressor.push(
        object.data.subarray(offset, offset + 16384),
        offset + 16384 >= object.data.length,
      );
      if (compressor.err) throw Error("Git compression failed");
      for (const chunk of chunks) {
        emitted += chunk.length;
        if (emitted + 20 > LIMITS.fetchBytes)
          fail(413, "Generated pack exceeds 512 MiB transfer budget");
        hash.update(chunk);
        yield chunk;
      }
      chunks = [];
    }
  }
  yield new Uint8Array(hash.digest());
}
/** Keep the repository queue held until the stream ends, is canceled, errors, or its idle timer fires. */
const completions = new WeakMap<Response, Promise<void>>();
export function responseCompletion(response: Response) {
  return completions.get(response);
}
export function streamResponse(
  iterator: AsyncIterator<Uint8Array>,
  headers: HeadersInit,
  idleMs = 20000,
) {
  let resolve!: () => void,
    closed = false,
    timer: ReturnType<typeof setTimeout>;
  let control: ReadableStreamDefaultController<Uint8Array>,
    stopping: Promise<void> | undefined;
  const completed = new Promise<void>((r) => {
    resolve = r;
  });
  const finish = () => {
    closed = true;
    clearTimeout(timer);
    resolve();
  };
  const stop = (error?: unknown): Promise<void> => {
    if (stopping) return stopping;
    if (closed) return Promise.resolve();
    closed = true;
    clearTimeout(timer);
    if (error) control.error(error);
    stopping = (async () => {
      try {
        await iterator.return?.();
      } catch {
      } finally {
        finish();
      }
    })();
    return stopping;
  };
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      void stop(Error("Git stream idle timeout"));
    }, idleMs);
  };
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        control = controller;
        arm();
      },
      async pull(controller) {
        if (closed) return;
        arm();
        try {
          const result = await iterator.next();
          if (closed) return;
          if (result.done) {
            controller.close();
            finish();
            return;
          }
          controller.enqueue(result.value);
          arm();
        } catch (error) {
          await stop(error);
        }
      },
      cancel() {
        return stop();
      },
    },
    { highWaterMark: 0 },
  );
  const response = new Response(stream, { headers });
  completions.set(response, completed);
  return response;
}
