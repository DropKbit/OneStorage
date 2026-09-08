import type { GitObject } from "./objects";
/** Volatile, bounded LRU of verified immutable objects. Never caches refs or access decisions. */
export class ObjectCache {
  private entries = new Map<string, { object: GitObject; expires: number }>();
  private bytes = 0;
  constructor(
    private budget = 8 * 1024 * 1024,
    private ttl = 300000,
    private now = () => Date.now(),
  ) {}
  get(repo: string, oid: string, maxBytes = Infinity): GitObject | undefined {
    const key = repo + "/" + oid,
      entry = this.entries.get(key);
    if (!entry) return;
    if (entry.object.data.length > maxBytes) return;
    this.remove(key);
    if (entry.expires <= this.now()) return;
    this.entries.set(key, entry);
    this.bytes += entry.object.data.length;
    return { ...entry.object, data: entry.object.data.slice() };
  }
  put(repo: string, object: GitObject) {
    if (object.data.length > Math.min(this.budget, 1024 * 1024)) return;
    const key = repo + "/" + object.oid;
    this.remove(key);
    while (
      this.entries.size >= 512 ||
      this.bytes + object.data.length > this.budget
    )
      this.remove(this.entries.keys().next().value!);
    this.entries.set(key, {
      object: { ...object, data: object.data.slice() },
      expires: this.now() + this.ttl,
    });
    this.bytes += object.data.length;
  }
  private remove(key: string) {
    const entry = this.entries.get(key);
    if (entry) {
      this.bytes -= entry.object.data.length;
      this.entries.delete(key);
    }
  }
  clear() {
    this.entries.clear();
    this.bytes = 0;
  }
}
