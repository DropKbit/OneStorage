import { concat, LIMITS, sameBytes } from "./objects";
import { GitIO } from "./diagnostics";
import { fail } from "../security";

type Location = {
  block: number;
  offset: number;
  length: number;
  blockSize: number;
};
/** Upload-private immutable blocks. No locator is published outside the receive session. */
export class IncomingBlocks {
  private locations = new Map<string, Location>();
  private pending = new Map<string, Uint8Array>();
  private size = 0;
  private sequence = 0;
  private cache?: { block: number; data: Uint8Array };
  private reads = 0;
  private writes = 0;
  private readBytes = 0;
  private peakStaged = 0;
  private peakCached = 0;
  private io: GitIO;
  constructor(
    private bucket: R2Bucket,
    private root: string,
    repoId: string,
  ) {
    this.io = new GitIO(undefined, (detail) =>
      console.warn("Git object I/O retry", { repoId, ...detail }),
    );
  }
  async put(key: string, data: Uint8Array) {
    if (data.length > LIMITS.object + 64)
      fail(413, "Incoming entry exceeds object budget");
    if (this.pending.has(key) || this.locations.has(key)) {
      if (!sameBytes(await this.get(key), data))
        fail(409, "Conflicting incoming entry");
      return;
    }
    if (this.size && this.size + data.length > 4 * 1024 * 1024)
      await this.flush();
    this.pending.set(key, data);
    this.size += data.length;
    this.peakStaged = Math.max(this.peakStaged, this.size);
    if (this.size >= 4 * 1024 * 1024 || this.pending.size >= 1024)
      await this.flush();
  }
  async flush() {
    if (!this.pending.size) return;
    const block = this.sequence++,
      key = this.root + "blocks/" + block,
      data = concat(...this.pending.values());
    const result = await this.io.run("object-write", () => {
      this.writes++;
      return this.bucket.put(key, data, { onlyIf: { etagDoesNotMatch: "*" } });
    });
    if (result === null) {
      const old = await this.io.run("object-read", () => {
        this.reads++;
        return this.bucket.get(key);
      });
      if (
        !old ||
        old.size !== data.length ||
        !sameBytes(new Uint8Array(await old.arrayBuffer()), data)
      )
        fail(409, "Conflicting incoming block");
    }
    let offset = 0;
    for (const [id, value] of this.pending) {
      this.locations.set(id, {
        block,
        offset,
        length: value.length,
        blockSize: data.length,
      });
      offset += value.length;
    }
    this.pending.clear();
    this.size = 0;
    this.cache = { block, data };
    this.peakCached = Math.max(this.peakCached, data.length);
  }
  async get(key: string) {
    const staged = this.pending.get(key);
    if (staged) return staged.slice();
    const location = this.locations.get(key);
    if (!location) fail(409, "Incoming entry unavailable");
    if (this.cache?.block !== location.block) {
      const value = await this.io.run("object-read", () => {
        this.reads++;
        return this.bucket.get(this.root + "blocks/" + location.block);
      });
      if (
        !value ||
        value.size !== location.blockSize ||
        value.size > LIMITS.object + 64
      )
        fail(409, "Incoming block unavailable");
      const data = new Uint8Array(await value.arrayBuffer());
      this.readBytes += data.length;
      this.cache = { block: location.block, data };
      this.peakCached = Math.max(this.peakCached, data.length);
    }
    // Copy the entry so callers' object caches cannot retain an entire block for a tiny object.
    return this.cache.data.slice(
      location.offset,
      location.offset + location.length,
    );
  }
  get ioUsage() {
    return {
      r2Reads: this.reads,
      r2Writes: this.writes,
      r2Retries: this.io.retries,
      readBytes: this.readBytes,
      peakStagedBytes: this.peakStaged,
      stagedBytes: this.size,
      cachedBytes: this.cache?.data.length || 0,
      peakCachedBytes: this.peakCached,
    };
  }
}
