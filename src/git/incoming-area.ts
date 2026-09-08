import { IncomingBlocks } from "./incoming-blocks";
import {
  ObjectStore,
  LIMITS,
  sameBytes,
  canonical,
  readCanonical,
  type GitObject,
} from "./objects";
import { fail } from "../security";
import { GitIO } from "./diagnostics";
import type { ReceiveReader } from "./receive-reader";

export interface IncomingSink {
  save(object: GitObject): Promise<void>;
  load(oid: string): Promise<GitObject>;
  delta(offset: number, data: Uint8Array): Promise<void>;
  loadDelta(offset: number): Promise<Uint8Array>;
  settle(): Promise<void>;
}
type Marker = { repoId: string; session: string };
function prefix(marker: Marker) {
  if (![marker.repoId, marker.session].every((s) => /^[0-9a-f-]{36}$/.test(s)))
    throw Error("Invalid incoming storage scope");
  return `repos/${marker.repoId}/incoming/${marker.session}/`;
}
/** A serialized repository alarm owns orphan cleanup; it cannot overtake the active upload. */
export async function collectIncoming(
  bucket: R2Bucket,
  storage: DurableObjectStorage,
) {
  const markers = await storage.list<Marker>({ prefix: "incoming:", limit: 2 });
  for (const [key, marker] of markers) {
    const page = await bucket.list({ prefix: prefix(marker), limit: 1000 });
    if (page.objects.length)
      await bucket.delete(page.objects.map((o) => o.key));
    if (!page.truncated) await storage.delete(key);
  }
  return (await storage.list({ prefix: "incoming:", limit: 1 })).size > 0;
}

export class IncomingArea implements IncomingSink {
  private marker: Marker;
  private key: string;
  private root: string;
  private temporary: IncomingBlocks;
  private started = false;
  private io = new GitIO();
  private objects = new Set<string>();
  private wireChunks = 0;
  private wireBytes = 0;
  constructor(
    private bucket: R2Bucket,
    private storage: DurableObjectStorage,
    private target: ObjectStore,
  ) {
    this.marker = { repoId: target.repoId, session: crypto.randomUUID() };
    this.key = "incoming:" + this.marker.session;
    this.root = prefix(this.marker);
    this.temporary = new IncomingBlocks(bucket, this.root, target.repoId);
  }
  async begin() {
    if (
      (await this.storage.list({ prefix: "incoming:", limit: 8 })).size >= 8
    ) {
      await this.storage.setAlarm(Date.now() + 1000);
      fail(503, "Previous upload cleanup is pending");
    }
    await this.storage.put(this.key, this.marker);
    this.started = true;
    await this.storage.setAlarm(Date.now() + 1000);
  }
  async save(object: GitObject) {
    await this.temporary.put("object:" + object.oid, canonical(object));
    this.objects.add(object.oid);
  }

  /** Drain the HTTP body with a bounded number of R2 writes before per-object work. */
  async spool(reader: ReceiveReader) {
    const limit = 4 * 1024 * 1024;
    let buffer = new Uint8Array(limit),
      used = 0;
    const sizes: number[] = [];
    const persist = async () => {
      const value = buffer.subarray(0, used),
        key = this.root + "wire/" + sizes.length;
      const result = await this.io.run("object-write", () =>
        this.bucket.put(key, value, { onlyIf: { etagDoesNotMatch: "*" } }),
      );
      if (result === null) {
        const existing = await this.io.run("object-read", () =>
          this.bucket.get(key),
        );
        if (
          !existing ||
          existing.size !== used ||
          !sameBytes(new Uint8Array(await existing.arrayBuffer()), value)
        )
          fail(409, "Conflicting incoming wire chunk");
      }
      sizes.push(used);
      this.wireChunks++;
      this.wireBytes += used;
      used = 0;
    };
    for (;;) {
      const chunk = await reader.chunk();
      if (!chunk) break;
      const count = Math.min(limit - used, chunk.length);
      buffer.set(chunk.subarray(0, count), used);
      used += count;
      reader.advance(count);
      if (used === limit) await persist();
    }
    if (used) await persist();
    buffer = new Uint8Array();
    let next = 0;
    const area = this;
    return new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          if (next === sizes.length) {
            controller.close();
            return;
          }
          const index = next++,
            value = await area.io.run("object-read", () =>
              area.bucket.get(area.root + "wire/" + index),
            );
          if (!value || value.size !== sizes[index])
            fail(409, "Incoming wire chunk unavailable");
          const bytes = new Uint8Array(await value.arrayBuffer());
          // The stream carries one bounded chunk. The parser reader divides it without whole-pack allocation.
          controller.enqueue(bytes);
        },
      },
      { highWaterMark: 0 },
    );
  }
  async load(oid: string) {
    return this.objects.has(oid)
      ? readCanonical(await this.temporary.get("object:" + oid), oid)
      : this.target.get(oid);
  }
  async delta(offset: number, data: Uint8Array) {
    await this.temporary.put("delta:" + offset, data);
  }
  async loadDelta(offset: number) {
    return this.temporary.get("delta:" + offset);
  }

  async settle() {
    await this.temporary.flush();
  }
  async promote() {
    await this.settle();
    for (const oid of this.objects) {
      const object = await readCanonical(
        await this.temporary.get("object:" + oid),
        oid,
      );
      if (
        this.target.memoryUsage.stagedBytes + object.data.length >
        LIMITS.object
      )
        await this.target.flush(4);
      this.target.add(object);
      if (
        this.target.staged.size >= 4 ||
        this.target.memoryUsage.stagedBytes >= 4 * 1024 * 1024
      )
        await this.target.flush(4);
    }
    await this.target.flush(4);
  }
  get metrics() {
    return {
      incomingObjects: this.objects.size,
      wireChunks: this.wireChunks,
      spooledBytes: this.wireBytes,
      quarantine: this.temporary.ioUsage,
    };
  }
  async close() {
    if (!this.started) return;
    try {
      const page = await this.bucket.list({ prefix: this.root, limit: 1000 });
      if (page.objects.length)
        await this.bucket.delete(page.objects.map((o) => o.key));
      if (!page.truncated) await this.storage.delete(this.key);
      else await this.storage.setAlarm(Date.now() + 1000);
    } catch {
      // The marker and alarm precede every R2 write. Cleanup failure must not undo a successful ref publication.
      console.warn("Git incoming cleanup pending", this.marker);
    }
  }
}
