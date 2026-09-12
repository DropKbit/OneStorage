import type { ForgeRepository } from "./forge";
import type { RefStorage } from "./repository";
import { isOid } from "./objects";

// Two fixed slots per repository (ordinary/ephemeral), below the DO per-value limit.
// Only immutable root content is stored; refs, branch lists and authorization stay live.
export const BROWSE_CACHE_BYTES = 96 * 1024;
export const BROWSE_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
export type BrowseContent = {
  data: Awaited<ReturnType<ForgeRepository["tree"]>>;
  readme: Awaited<ReturnType<ForgeRepository["blob"]>> | null;
};
type Entry = BrowseContent & { repo: string; target: string; expires: number };
export class BrowseCache {
  constructor(
    private storage: RefStorage,
    private writable = true,
    private now = () => Date.now(),
  ) {}
  private key(repo: ForgeRepository) {
    return (
      "browse-root.v1:" +
      (repo.policy.namespace === "ephemeral" ? "ephemeral" : "ordinary")
    );
  }
  target(repo: ForgeRepository, ref: string) {
    // Complex/abbreviated revisions retain the authoritative resolver, including
    // its precedence over a branch whose name happens to look like a short SHA.
    if (/^[0-9a-f]{4,39}$/.test(ref) || /[~^]/.test(ref)) return;
    const target =
      ref === "HEAD"
        ? repo.refs["refs/heads/" + repo.defaultBranch]
        : repo.refs[ref] ||
          repo.refs["refs/heads/" + ref] ||
          repo.refs["refs/tags/" + ref] ||
          (isOid(ref) ? ref : undefined);
    return target && isOid(target) ? target : undefined;
  }
  async get(
    repo: ForgeRepository,
    target: string,
  ): Promise<BrowseContent | undefined> {
    try {
      const entry = await this.storage.get<Entry>(this.key(repo));
      if (
        entry?.repo === repo.store.repoId &&
        entry.target === target &&
        entry.expires > this.now()
      )
        return { data: entry.data, readme: entry.readme };
    } catch {
      /* Disposable cache failures fall back to verified R2 objects. */
    }
  }
  async put(repo: ForgeRepository, target: string, content: BrowseContent) {
    if (!this.writable) return;
    const entry: Entry = {
      ...content,
      repo: repo.store.repoId,
      target,
      expires: this.now() + BROWSE_CACHE_TTL,
    };
    if (
      new TextEncoder().encode(JSON.stringify(entry)).length >
      BROWSE_CACHE_BYTES
    )
      return;
    try {
      await this.storage.put(this.key(repo), entry);
    } catch {
      /* Never turn successful Git reads into cache-write failures. */
    }
  }
}
