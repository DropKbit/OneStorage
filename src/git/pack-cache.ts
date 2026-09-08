import { createHash } from "node:crypto";
import { LIMITS } from "./objects";

const CHUNK = 4 * 1024 * 1024;
const TTL = 24 * 60 * 60 * 1000;
const CURRENT = "pack-cache:current";
const MARKERS = "pack-cache:entry:";
type Marker = { repo: string; session: string; expires: number };
type Descriptor = Marker & {
  selection: string;
  total: number;
  chunks: { size: number; hash: string }[];
};
const digest = (data: Uint8Array | string) =>
  createHash("sha256").update(data).digest("hex");
function root(marker: Marker) {
  if (![marker.repo, marker.session].every((id) => /^[0-9a-f-]{36}$/.test(id)))
    throw Error("Invalid pack cache scope");
  return `repos/${marker.repo}/pack-cache/${marker.session}/`;
}
async function arm(storage: DurableObjectStorage, at: number) {
  const alarm = await storage.getAlarm();
  if (alarm === null || alarm > at) await storage.setAlarm(at);
}

/** Called only behind the repository stream barrier. Pending writes are recoverable after eviction. */
export async function collectPackCache(
  bucket: R2Bucket,
  storage: DurableObjectStorage,
  now = Date.now(),
  force = false,
) {
  const markers = await storage.list<Marker>({ prefix: MARKERS, limit: 2 });
  for (const [key, marker] of markers) {
    if (!force && marker.expires > now) {
      await arm(storage, marker.expires);
      continue;
    }
    const current = await storage.get<Descriptor>(CURRENT);
    if (current?.session === marker.session) await storage.delete(CURRENT);
    const page = await bucket.list({ prefix: root(marker), limit: 1000 });
    if (page.objects.length)
      await bucket.delete(page.objects.map((o) => o.key));
    if (!page.truncated) await storage.delete(key);
    else await arm(storage, now + 1000);
  }
}

/** Disposable, one-slot cache of an exact, already-authorized selection. Never an object authority. */
export class PackCache {
  readonly metrics = {
    hit: false,
    fallback: false,
    reads: 0,
    writes: 0,
    bytes: 0,
  };
  constructor(
    private repo: string,
    private bucket: R2Bucket,
    private storage: DurableObjectStorage,
    private now = () => Date.now(),
  ) {}
  async *stream(
    ids: readonly string[],
    generate: () => AsyncIterable<Uint8Array>,
  ): AsyncGenerator<Uint8Array> {
    // The caller sorts IDs and generates non-delta PACK v2, independently of wire framing.
    const selection = digest(
      "pack-v2-full-zlib-v1\n" + this.repo + "\n" + ids.join("\n"),
    );
    let cached: Descriptor | undefined;
    try {
      const value = await this.storage.get<Descriptor>(CURRENT);
      if (
        value &&
        value.repo === this.repo &&
        value.selection === selection &&
        value.expires > this.now() &&
        this.valid(value)
      )
        cached = value;
    } catch {
      /* Cache metadata cannot make the authoritative path unavailable. */
    }
    if (cached) {
      let sent = 0;
      this.metrics.hit = true;
      for (let i = 0; i < cached.chunks.length; i++) {
        let data: Uint8Array;
        try {
          const part = cached.chunks[i];
          this.metrics.reads++;
          const object = await this.bucket.get(root(cached) + i);
          if (!object || object.size !== part.size)
            throw Error("Cache chunk missing");
          data = new Uint8Array(await object.arrayBuffer());
          if (data.length !== part.size || digest(data) !== part.hash)
            throw Error("Cache chunk checksum mismatch");
        } catch {
          this.metrics.fallback = true;
          // Keep the marker until cleanup succeeds; never expose unchecked cached bytes.
          try {
            await this.storage.delete(CURRENT);
            await arm(this.storage, this.now() + 1000);
            await this.storage.put(MARKERS + cached.session, {
              ...cached,
              expires: 0,
            });
          } catch {
            /* Original TTL and marker still provide eventual reclamation. */
          }
          // Regenerate the same deterministic pack; skip only the verified prefix already sent.
          for await (const chunk of generate()) {
            if (sent >= chunk.length) {
              sent -= chunk.length;
              continue;
            }
            yield chunk.subarray(sent);
            sent = 0;
          }
          if (sent) throw Error("Regenerated pack shorter than cached prefix");
          return;
        }
        sent += data.length;
        this.metrics.bytes += data.length;
        yield data;
      }
      return;
    }

    const marker: Marker = {
      repo: this.repo,
      session: crypto.randomUUID(),
      expires: 0,
    };
    let enabled = false;
    try {
      // Evict before writing: at most one bounded pack (including any failed build) per repository.
      await collectPackCache(this.bucket, this.storage, this.now(), true);
      if (!(await this.storage.list({ prefix: MARKERS, limit: 1 })).size) {
        await this.storage.put(MARKERS + marker.session, marker);
        await arm(this.storage, this.now() + 1000);
        enabled = true;
      }
    } catch {
      /* Skip caching if journaling or previous cleanup is unavailable. */
    }
    let buffer: Uint8Array | undefined = enabled
      ? new Uint8Array(CHUNK)
      : undefined;
    let used = 0,
      total = 0,
      complete = false;
    const chunks: Descriptor["chunks"] = [];
    const persist = async () => {
      if (!buffer || !used) return;
      const data = buffer.subarray(0, used),
        hash = digest(data);
      this.metrics.writes++;
      const stored = await this.bucket.put(root(marker) + chunks.length, data, {
        onlyIf: { etagDoesNotMatch: "*" },
        sha256: hash,
      });
      if (!stored) throw Error("Cache chunk collision");
      chunks.push({ size: used, hash });
      used = 0;
    };
    try {
      for await (const chunk of generate()) {
        total += chunk.length;
        if (enabled) {
          try {
            if (total > LIMITS.fetchBytes)
              throw Error("Cache pack exceeds budget");
            for (let offset = 0; offset < chunk.length;) {
              const count = Math.min(CHUNK - used, chunk.length - offset);
              buffer!.set(chunk.subarray(offset, offset + count), used);
              used += count;
              offset += count;
              if (used === CHUNK) await persist();
            }
          } catch {
            enabled = false;
            buffer = undefined;
          }
        }
        yield chunk;
      }
      if (enabled) {
        try {
          await persist();
          const expires = this.now() + TTL;
          const descriptor: Descriptor = {
            ...marker,
            expires,
            selection,
            total,
            chunks,
          };
          // All R2 data precedes the atomically published descriptor and retention marker.
          await this.storage.put({
            [CURRENT]: descriptor,
            [MARKERS + marker.session]: { ...marker, expires },
          });
          complete = true;
          this.metrics.bytes = total;
        } catch {
          /* Generated Git response remains valid even if caching fails. */
        }
      }
    } finally {
      buffer = undefined;
      if (!complete) {
        try {
          await arm(this.storage, this.now() + 1000);
        } catch {}
      }
    }
  }
  private valid(value: Descriptor) {
    if (
      !/^[0-9a-f-]{36}$/.test(value.session) ||
      !Array.isArray(value.chunks) ||
      !Number.isSafeInteger(value.total) ||
      value.total < 32 ||
      value.total > LIMITS.fetchBytes ||
      value.chunks.length !== Math.ceil(value.total / CHUNK)
    )
      return false;
    return value.chunks.every(
      (part, i) =>
        part &&
        part.size === Math.min(CHUNK, value.total - i * CHUNK) &&
        /^[0-9a-f]{64}$/.test(part.hash),
    );
  }
}
