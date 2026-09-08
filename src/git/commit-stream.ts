import { ObjectStore, bytes, text, concat, LIMITS } from "./objects";
import { fail } from "../security";
import { unbase64 } from "./signatures";
import type { CommitInput, FileEdit } from "./forge";
export async function* ndjson(request: Request) {
  if (!request.body) fail(400, "Request body required");
  const reader = request.body.getReader(),
    decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "",
    total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > 48 * 1024 * 1024) fail(413, "Commit stream exceeds 48 MiB");
      pending += decoder.decode(value, { stream: true });
      let at;
      while ((at = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, at);
        pending = pending.slice(at + 1);
        if (!line.trim()) continue;
        if (bytes(line).length > 6 * 1024 * 1024)
          fail(413, "NDJSON line exceeds 6 MiB");
        try {
          yield JSON.parse(line);
        } catch (e) {
          if ((e as any).status) throw e;
          fail(400, "Invalid NDJSON line");
        }
      }
      if (bytes(pending).length > 6 * 1024 * 1024)
        fail(413, "NDJSON line exceeds 6 MiB");
    }
    pending += decoder.decode();
    if (pending.trim()) {
      try {
        yield JSON.parse(pending);
      } catch (e) {
        if ((e as any).status) throw e;
        fail(400, "Invalid final NDJSON line");
      }
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
export async function parseCommitStream(
  request: Request,
  store: ObjectStore,
  kind: "files" | "diff" | "restore",
) {
  let metadata: any,
    seen = false,
    decoded = 0,
    diffDone = false;
  const content = new Map<
      string,
      { chunks: Uint8Array[]; size: number; done: boolean; sha?: string }
    >(),
    diff: Uint8Array[] = [];
  for await (const line of ndjson(request)) {
    if (!seen) {
      seen = true;
      if (
        !line ||
        typeof line.metadata !== "object" ||
        !line.metadata ||
        Array.isArray(line.metadata) ||
        Object.keys(line).length !== 1
      )
        fail(400, "First NDJSON line must contain metadata");
      metadata = line.metadata;
      if (kind === "files") {
        if (
          !Array.isArray(metadata.files) ||
          !metadata.files.length ||
          metadata.files.length > 1000
        )
          fail(400, "Metadata requires 1–1000 file operations");
        for (const f of metadata.files) {
          if (
            !f ||
            typeof f.path !== "string" ||
            !["upsert", "delete"].includes(f.operation) ||
            typeof f.content_id !== "string" ||
            !f.content_id ||
            f.content_id.length > 100
          )
            fail(400, "Invalid streamed file operation");
          if (!content.has(f.content_id))
            content.set(f.content_id, { chunks: [], size: 0, done: false });
        }
      }
      continue;
    }
    if (kind === "restore") fail(400, "Restore accepts metadata only");
    const chunk = kind === "files" ? line.blob_chunk : line.diff_chunk;
    if (
      !chunk ||
      typeof chunk.data !== "string" ||
      typeof chunk.eof !== "boolean" ||
      Object.keys(line).length !== 1
    )
      fail(400, "Invalid stream chunk");
    const data = unbase64(chunk.data);
    if (data.length > 4 * 1024 * 1024) fail(413, "Chunk exceeds 4 MiB");
    decoded += data.length;
    if (decoded > LIMITS.expanded) fail(413, "Decoded commit exceeds 32 MiB");
    if (kind === "diff") {
      if (diffDone) fail(400, "Data after diff EOF");
      diff.push(data);
      diffDone = chunk.eof;
      continue;
    }
    const item = content.get(chunk.content_id);
    if (!item || item.done) fail(400, "Unknown content ID or data after EOF");
    item.chunks.push(data);
    item.size += data.length;
    if (item.size > LIMITS.object) fail(413, "File exceeds Git object limit");
    if (chunk.eof) {
      item.done = true;
      item.sha = (await store.create("blob", concat(...item.chunks))).oid;
      item.chunks = [];
    }
  }
  if (!seen) fail(400, "Metadata required");
  if (kind === "diff") {
    if (!diffDone) fail(400, "Missing diff EOF");
    return { metadata, diff: concat(...diff) };
  }
  if (kind === "restore") return { metadata };
  const files: FileEdit[] = metadata.files.map((file: any) => {
    const item = content.get(file.content_id)!;
    if (file.operation === "upsert" && !item.done)
      fail(400, "Missing blob EOF");
    return {
      path: file.path,
      operation: file.operation,
      mode: file.mode,
      ...(file.operation === "delete" ? { content: null } : { sha: item.sha }),
    };
  });
  return { metadata: { ...metadata, files } as CommitInput };
}
