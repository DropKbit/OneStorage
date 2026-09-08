import { toBase64 } from "./auth";
export type Content =
  | string
  | Uint8Array
  | Blob
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array>;
export async function* contentChunks(
  value: Content,
): AsyncGenerator<Uint8Array> {
  if (typeof value === "string") value = new TextEncoder().encode(value);
  if (value instanceof Blob) value = value.stream();
  if (value instanceof Uint8Array) {
    for (let i = 0; i < value.length; i += 1024 * 1024)
      yield value.subarray(i, i + 1024 * 1024);
    return;
  }
  if (Symbol.asyncIterator in value) {
    for await (const chunk of value as AsyncIterable<Uint8Array>) {
      if (!(chunk instanceof Uint8Array))
        throw Error("Stream must yield bytes");
      for (let i = 0; i < chunk.length; i += 1024 * 1024)
        yield chunk.subarray(i, i + 1024 * 1024);
    }
    return;
  }
  const reader = (value as ReadableStream<Uint8Array>).getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (let i = 0; i < value.length; i += 1024 * 1024)
        yield value.subarray(i, i + 1024 * 1024);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
export function streamNDJSON(lines: AsyncIterable<unknown>) {
  const iterator = lines[Symbol.asyncIterator](),
    encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const n = await iterator.next();
        if (n.done) controller.close();
        else controller.enqueue(encoder.encode(JSON.stringify(n.value) + "\n"));
      } catch (e) {
        controller.error(e);
        await iterator.return?.();
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}
export interface CommitOptions {
  target_branch: string;
  commit_message: string;
  author: { name: string; email: string; timestamp?: number };
  committer?: { name: string; email: string; timestamp?: number };
  expected_target_sha?: string | null;
  base_branch?: string;
  base_ref?: string;
  ephemeral_base?: boolean;
  ephemeral?: boolean;
}
export interface CommitResult {
  sha: string;
  commit_sha: string;
  tree_sha: string;
  target_branch: string;
  blob_count: number;
  ref_update: { branch: string; old_sha: string; new_sha: string };
}
export class CommitBuilder {
  private files: {
    path: string;
    content_id: string;
    operation: "upsert" | "delete";
    mode?: string;
    value?: Content;
  }[] = [];
  private used = false;
  constructor(
    private options: CommitOptions,
    private sendStream: (
      stream: ReadableStream<Uint8Array>,
    ) => Promise<CommitResult>,
  ) {}
  addFile(path: string, value: Content, mode = "100644") {
    if (this.used) throw Error("Builder already sent");
    this.files.push({
      path,
      content_id: String(this.files.length),
      operation: "upsert",
      mode,
      value,
    });
    return this;
  }
  addFileFromString(path: string, value: string, mode = "100644") {
    return this.addFile(path, value, mode);
  }
  addFileFromStream(
    path: string,
    value: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
    mode = "100644",
  ) {
    return this.addFile(path, value, mode);
  }
  deleteFile(path: string) {
    if (this.used) throw Error("Builder already sent");
    this.files.push({
      path,
      content_id: String(this.files.length),
      operation: "delete",
    });
    return this;
  }
  deleteDirectory(path: string) {
    return this.deleteFile(path);
  }
  async send() {
    if (this.used) throw Error("Builder already sent");
    this.used = true;
    if (!this.files.length) throw Error("Commit needs at least one operation");
    const files = this.files,
      options = this.options;
    async function* lines() {
      yield {
        metadata: {
          ...options,
          files: files.map(({ value, ...file }) => file),
        },
      };
      for (const file of files)
        if (file.operation === "upsert") {
          for await (const chunk of contentChunks(file.value!))
            yield {
              blob_chunk: {
                content_id: file.content_id,
                data: toBase64(chunk),
                eof: false,
              },
            };
          yield {
            blob_chunk: { content_id: file.content_id, data: "", eof: true },
          };
        }
    }
    return this.sendStream(streamNDJSON(lines()));
  }
}
export function diffStream(options: CommitOptions, diff: Content) {
  async function* lines() {
    yield { metadata: options };
    for await (const chunk of contentChunks(diff))
      yield { diff_chunk: { data: toBase64(chunk), eof: false } };
    yield { diff_chunk: { data: "", eof: true } };
  }
  return streamNDJSON(lines());
}
