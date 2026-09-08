import type { GitObjectIndex } from "./object-index";
import type { ObjectCache } from "./object-cache";
import { fail } from "../security";
export const LIMITS = {
  object: 8 * 1024 * 1024,
  expanded: 32 * 1024 * 1024,
  pack: 16 * 1024 * 1024,
  objects: 2000,
  graph: 5000,
  transferGraph: 100000,
  fetchBytes: 512 * 1024 * 1024,
  cacheBytes: 8 * 1024 * 1024,
  refs: 256,
  depth: 64,
};
export type ObjectType = "commit" | "tree" | "blob" | "tag";
export interface GitObject {
  oid: string;
  type: ObjectType;
  data: Uint8Array;
}
export type Refs = Record<string, string>;
export const encoder = new TextEncoder(),
  decoder = new TextDecoder();
export const text = (data: Uint8Array) => decoder.decode(data);
export const bytes = (s: string) => encoder.encode(s);
export const ZERO = "0".repeat(40);
export const isOid = (s: string) => /^[0-9a-f]{40}$/.test(s);
export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
export const toHex = (b: Uint8Array) =>
  Array.from(b, (n) => n.toString(16).padStart(2, "0")).join("");
export function fromHex(s: string) {
  if (!/^(?:[0-9a-f]{2})+$/.test(s)) fail(400, "Invalid hexadecimal value");
  return Uint8Array.from(s.match(/../g)!, (h) => parseInt(h, 16));
}
export async function sha1(data: Uint8Array) {
  return toHex(
    new Uint8Array(await crypto.subtle.digest("SHA-1", data as BufferSource)),
  );
}
export function canonical(object: Pick<GitObject, "type" | "data">) {
  return concat(bytes(`${object.type} ${object.data.length}\0`), object.data);
}
export async function makeObject(
  type: ObjectType,
  data: Uint8Array,
): Promise<GitObject> {
  if (data.length > LIMITS.object) fail(413, "Git object exceeds 8 MiB");
  return { oid: await sha1(canonical({ type, data })), type, data };
}
export async function readCanonical(
  data: Uint8Array,
  expected?: string,
): Promise<GitObject> {
  const nul = data.indexOf(0);
  if (nul < 0 || nul > 64) fail(400, "Invalid Git object header");
  const m = text(data.subarray(0, nul)).match(
    /^(commit|tree|blob|tag) (0|[1-9][0-9]*)$/,
  );
  if (!m || Number(m[2]) !== data.length - nul - 1)
    fail(400, "Git object size mismatch");
  const o = await makeObject(m[1] as ObjectType, data.subarray(nul + 1));
  if (expected && o.oid !== expected) fail(400, "Git object hash mismatch");
  return o;
}
export function validRef(ref: string) {
  return (
    /^refs\/(?:namespaces\/ephemeral\/refs\/)?(heads|tags|notes)\//.test(ref) &&
    bytes(ref).length <= 240 &&
    !/[\s~^:?*\[\\\x00-\x1f\x7f]/.test(ref) &&
    !ref.includes("..") &&
    !ref.includes("@{") &&
    ref
      .split("/")
      .every(
        (p) =>
          p && !p.startsWith(".") && !p.endsWith(".") && !p.endsWith(".lock"),
      )
  );
}
export function checkRefs(refs: Refs) {
  const names = Object.keys(refs).sort();
  if (names.length > LIMITS.refs) fail(413, "Maximum 256 refs");
  for (let i = 0; i < names.length; i++) {
    if (!validRef(names[i]) || !isOid(refs[names[i]])) fail(400, "Invalid ref");
    const parts = names[i].split("/");
    for (let j = 1; j < parts.length; j++)
      if (Object.hasOwn(refs, parts.slice(0, j).join("/")))
        fail(409, "Conflicting ref names");
  }
}
export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
  type: "tree" | "blob" | "commit";
}
export function parseTree(data: Uint8Array): TreeEntry[] {
  let pos = 0;
  const out: TreeEntry[] = [];
  const seen = new Set<string>();
  let previous: TreeEntry | undefined;
  while (pos < data.length) {
    const space = data.indexOf(32, pos),
      nul = data.indexOf(0, space + 1);
    if (space < pos || nul < space || nul + 21 > data.length)
      fail(400, "Malformed tree");
    const mode = text(data.subarray(pos, space));
    let name: string;
    try {
      name = new TextDecoder("utf-8", { fatal: true }).decode(
        data.subarray(space + 1, nul),
      );
    } catch {
      fail(400, "Only UTF-8 filenames are supported");
    }
    if (
      !["40000", "100644", "100755", "120000", "160000"].includes(mode) ||
      !name ||
      name.includes("/") ||
      name === "." ||
      name === ".." ||
      name.toLowerCase() === ".git" ||
      seen.has(name)
    )
      fail(400, "Unsafe or duplicate tree entry");
    seen.add(name);
    const entry: TreeEntry = {
      mode,
      name,
      sha: toHex(data.subarray(nul + 1, nul + 21)),
      type: mode === "40000" ? "tree" : mode === "160000" ? "commit" : "blob",
    };
    if (previous && compareEntries(previous, entry) >= 0)
      fail(400, "Unsorted tree entries");
    out.push(entry);
    previous = entry;
    pos = nul + 21;
  }
  return out;
}
function compareEntries(a: TreeEntry, b: TreeEntry) {
  const x = bytes(a.name + (a.type === "tree" ? "/" : "")),
    y = bytes(b.name + (b.type === "tree" ? "/" : ""));
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i] - y[i];
  }
  return x.length - y.length;
}
export function treeBytes(entries: TreeEntry[]) {
  const sorted = [...entries].sort(compareEntries);
  return concat(
    ...sorted.map((e) =>
      concat(bytes(`${e.mode} ${e.name}\0`), fromHex(e.sha)),
    ),
  );
}
export function parseCommit(o: GitObject) {
  if (o.type !== "commit") fail(400, "Expected commit");
  const split = text(o.data).indexOf("\n\n");
  if (split < 0) fail(400, "Malformed commit");
  const raw = text(o.data),
    lines = raw.slice(0, split).split("\n");
  const trees = lines.filter((l) => l.startsWith("tree ")),
    parents = lines
      .filter((l) => l.startsWith("parent "))
      .map((l) => l.slice(7));
  if (
    lines[0] !== trees[0] ||
    trees.length !== 1 ||
    !isOid(trees[0].slice(5)) ||
    parents.some((p) => !isOid(p)) ||
    parents.length > 64 ||
    lines.filter((l) => l.startsWith("author ")).length !== 1 ||
    lines.filter((l) => l.startsWith("committer ")).length !== 1
  )
    fail(400, "Invalid commit headers");
  return {
    tree: trees[0].slice(5),
    parents,
    author: lines.find((l) => l.startsWith("author "))!.slice(7),
    message: raw.slice(split + 2),
  };
}
export function parseTag(o: GitObject) {
  if (o.type !== "tag") fail(400, "Expected tag");
  const lines = text(o.data).split("\n\n")[0].split("\n"),
    oid = lines.find((l) => l.startsWith("object "))?.slice(7),
    type = lines.find((l) => l.startsWith("type "))?.slice(5);
  if (
    !oid ||
    !isOid(oid) ||
    lines[0] !== "object " + oid ||
    lines[1] !== "type " + type ||
    !lines[2]?.startsWith("tag ") ||
    lines[2].length === 4 ||
    !["commit", "tree", "blob", "tag"].includes(type || "")
  )
    fail(400, "Invalid annotated tag");
  return { oid, type: type as ObjectType };
}
export function sameBytes(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
/** Request-local object cache and staging area. No filesystem or native process. */
export class ObjectStore {
  readonly staged = new Map<string, GitObject>();
  private cache = new Map<string, GitObject>();
  private size = 0;
  private stagedSize = 0;
  private peakSize = 0;
  private r2Reads = 0;
  private r2Writes = 0;
  private readBytes = 0;
  private peakStaged = 0;
  private pending = new Map<string, Promise<GitObject>>();
  constructor(
    readonly repoId: string,
    private bucket: Pick<R2Bucket, "get" | "put">,
    private shared?: ObjectCache,
    readonly index?: GitObjectIndex,
  ) {
    if (index && index.repoId !== repoId)
      fail(409, "Git object index scope mismatch");
  }
  get ioUsage() {
    return {
      r2Reads: this.r2Reads,
      r2Writes: this.r2Writes,
      readBytes: this.readBytes,
      peakStagedBytes: this.peakStaged,
      ...this.memoryUsage,
    };
  }
  get memoryUsage() {
    return {
      cachedBytes: this.size,
      peakCachedBytes: this.peakSize,
      stagedBytes: this.stagedSize,
    };
  }
  private remember(o: GitObject) {
    const old = this.cache.get(o.oid);
    if (old && (old.type !== o.type || !sameBytes(old.data, o.data)))
      fail(409, "Conflicting content for Git object ID");
    if (old) {
      this.cache.delete(o.oid);
      this.size -= old.data.length;
    }
    while (
      this.cache.size &&
      (this.size + o.data.length > LIMITS.cacheBytes || this.cache.size >= 1024)
    ) {
      const key = this.cache.keys().next().value!;
      this.size -= this.cache.get(key)!.data.length;
      this.cache.delete(key);
    }
    this.cache.set(o.oid, o);
    this.size += o.data.length;
    this.peakSize = Math.max(this.peakSize, this.size);
    return o;
  }
  async get(oid: string): Promise<GitObject> {
    if (!isOid(oid)) fail(400, "Invalid object ID");
    const existing = this.staged.get(oid) || this.cache.get(oid);
    if (existing) return this.remember(existing);
    const cached = this.shared?.get(this.repoId, oid);
    if (cached) return this.remember(cached);
    const inFlight = this.pending.get(oid);
    if (inFlight) return inFlight;
    const load = (async () => {
      this.r2Reads++;
      const r = await this.bucket.get(`repos/${this.repoId}/objects/${oid}`);
      if (!r) fail(409, "Missing Git object " + oid);
      if (r.size > LIMITS.object + 64) fail(413, "Stored object exceeds limit");
      this.readBytes += r.size;
      const object = this.remember(
        await readCanonical(new Uint8Array(await r.arrayBuffer()), oid),
      );
      this.shared?.put(this.repoId, object);
      return object;
    })().finally(() => this.pending.delete(oid));
    this.pending.set(oid, load);
    return load;
  }
  add(o: GitObject) {
    const old = this.staged.get(o.oid);
    if (old && (old.type !== o.type || !sameBytes(old.data, o.data)))
      fail(409, "Conflicting staged Git object");
    if (!old) {
      if (this.stagedSize + o.data.length > LIMITS.expanded)
        fail(413, "Staged Git objects exceed 32 MiB");
      this.stagedSize += o.data.length;
      this.peakStaged = Math.max(this.peakStaged, this.stagedSize);
    }
    this.remember(o);
    this.staged.set(o.oid, o);
    return o;
  }
  async create(type: ObjectType, data: Uint8Array) {
    return this.add(await makeObject(type, data));
  }
  async flush() {
    const objects = [...this.staged.values()];
    // At most two canonical object buffers/collision reads at a time (8 MiB/object).
    for (let i = 0; i < objects.length; i += 2)
      await settledPair(
        objects.slice(i, i + 2).map(async (o) => {
          const key = `repos/${this.repoId}/objects/${o.oid}`,
            data = canonical(o);
          if ((await sha1(data)) !== o.oid)
            fail(400, "Staged Git object hash mismatch");
          this.r2Writes++;
          const result = await this.bucket.put(key, data, {
            onlyIf: { etagDoesNotMatch: "*" },
            httpMetadata: { contentType: "application/octet-stream" },
          });
          if (result === null) {
            this.r2Reads++;
            const existing = await this.bucket.get(key);
            if (
              !existing ||
              existing.size !== data.length ||
              !sameBytes(new Uint8Array(await existing.arrayBuffer()), data)
            )
              fail(409, "Conflicting stored Git object; refs unchanged");
          }
          this.shared?.put(this.repoId, o);
          this.staged.delete(o.oid);
          this.stagedSize -= o.data.length;
        }),
      );
  }
  async validateClosure(roots: string[]) {
    if (!this.index) {
      await this.walk(roots);
      return;
    }
    if (this.staged.size)
      fail(409, "Persist staged Git objects before indexing");
    await this.index.ensure(roots, (oid) => this.get(oid));
  }
  async walk(roots: string[], exclude = new Set<string>()) {
    if (this.index && !this.staged.size) {
      await this.validateClosure(roots);
      return this.index.walk(roots, exclude);
    }
    const seen = new Set<string>(),
      todo = roots.map((oid) => ({
        oid,
        type: undefined as ObjectType | undefined,
      }));
    while (todo.length) {
      const batch = todo.splice(-2).filter(({ oid }) => !exclude.has(oid));
      const objects = await settledPair(batch.map(({ oid }) => this.get(oid)));
      for (let i = 0; i < batch.length; i++) {
        const { oid, type } = batch[i],
          o = objects[i];
        // Every edge is checked, even when another path already visited this object.
        if (type && o.type !== type)
          fail(400, "Git object graph type mismatch");
        if (seen.has(oid)) continue;
        seen.add(oid);
        if (seen.size > LIMITS.graph)
          fail(413, "Object graph exceeds 5000 objects");
        if (o.type === "commit") {
          const c = parseCommit(o);
          todo.push(
            { oid: c.tree, type: "tree" },
            ...c.parents.map((oid) => ({ oid, type: "commit" as const })),
          );
        } else if (o.type === "tree") {
          for (const e of parseTree(o.data))
            if (e.mode !== "160000")
              todo.push({ oid: e.sha, type: e.type as ObjectType });
        } else if (o.type === "tag") todo.push(parseTag(o));
      }
    }
    return seen;
  }
  async ancestor(base: string, tip: string) {
    const seen = new Set<string>(),
      todo = [tip];
    while (todo.length) {
      const id = todo.pop()!;
      if (id === base) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      if (seen.size > LIMITS.graph) fail(413, "Commit graph too large");
      todo.push(...parseCommit(await this.get(id)).parents);
    }
    return false;
  }
  async resolve(ref: string, refs: Refs, defaultBranch: string) {
    const value =
      ref === "HEAD"
        ? refs[`refs/heads/${defaultBranch}`]
        : refs[ref] ||
          refs["refs/heads/" + ref] ||
          refs["refs/tags/" + ref] ||
          (isOid(ref) ? ref : undefined);
    if (!value) fail(409, "Revision not found");
    let oid = value;
    for (let i = 0; i < LIMITS.depth; i++) {
      const o = await this.get(oid);
      if (o.type === "commit") return oid;
      if (o.type !== "tag") fail(409, "Revision does not name a commit");
      oid = parseTag(o).oid;
    }
    fail(400, "Tag chain too deep");
  }
}

/** Drain in-flight I/O before rejecting, so callers cannot publish or retry while it mutates caches. */
async function settledPair<T>(promises: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(promises);
  for (const result of results)
    if (result.status === "rejected") throw result.reason;
  return results.map((result) => (result as PromiseFulfilledResult<T>).value);
}
