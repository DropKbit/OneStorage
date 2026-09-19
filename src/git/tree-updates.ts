import type { ForgeRepository } from "./forge";
import type { RefStorage } from "./repository";
import { parseCommit, parseTree, text, type TreeEntry } from "./objects";
import { parseIdentity } from "./forge-utils";
import { fail } from "../security";

export type FileUpdate = {
  name: string;
  date: string | null;
  commit: string | null;
};
export type TreeUpdates = {
  ref: string;
  path: string;
  updates: FileUpdate[];
  complete: boolean;
  limited: boolean;
};
type Progress = TreeUpdates & {
  repo: string;
  next: string | null;
  steps: number;
  expires: number;
};
const MAX_BYTES = 96 * 1024;
// A bounded first-parent walk records when each current path last changed on
// this branch, including mode changes and merged changes at the merge commit.
export async function updatesAt(
  repo: ForgeRepository,
  ref: string,
  path: string,
  storage: RefStorage,
): Promise<TreeUpdates> {
  if (path) repo.path(path);
  const sha = await repo.resolve(ref);
  const key =
    "tree-updates.v1:" +
    (repo.policy.namespace === "ephemeral" ? "ephemeral" : "ordinary");
  let state = await storage.get<Progress>(key);
  if (
    !state ||
    state.repo !== repo.store.repoId ||
    state.ref !== sha ||
    state.path !== path ||
    state.expires <= Date.now()
  ) {
    const tree = await repo.tree(sha, path);
    state = {
      repo: repo.store.repoId,
      ref: sha,
      path,
      updates: tree.entries.map((e) => ({
        name: e.name,
        date: null,
        commit: null,
      })),
      next: sha,
      steps: 0,
      complete: !tree.entries.length,
      limited: false,
      expires: Date.now() + 7 * 86400000,
    };
    // Avoid unbounded progress values or expensive history scans for huge directories.
    if (JSON.stringify(state).length * 4 > MAX_BYTES) state.limited = true;
  }
  const directory = async (commit: string) => {
    const { tree } = parseCommit(await repo.store.get(commit));
    let oid = tree;
    if (path)
      for (const part of path.split("/")) {
        const child = parseTree((await repo.store.get(oid)).data).find(
          (e) => e.name === part,
        );
        if (!child || child.type !== "tree")
          return new Map<string, TreeEntry>();
        oid = child.sha;
      }
    return new Map(
      parseTree((await repo.store.get(oid)).data).map((e) => [e.name, e]),
    );
  };
  for (
    let batch = 0;
    batch < 16 && !state.complete && !state.limited;
    batch++
  ) {
    if (!state.next) {
      state.complete = true;
      break;
    }
    if (state.steps >= 5000) {
      state.limited = true;
      break;
    }
    const current = state.next,
      object = await repo.store.get(current),
      commit = parseCommit(object);
    const before = commit.parents[0]
      ? await directory(commit.parents[0])
      : new Map<string, TreeEntry>();
    const now = await directory(current);
    const header = text(object.data)
      .split("\n\n")[0]
      .split("\n")
      .find((l) => l.startsWith("committer "));
    if (!header) fail(409, "Commit timestamp unavailable");
    const date = parseIdentity(header.slice(10)).date;
    for (const update of state.updates) {
      if (update.commit) continue;
      const a = now.get(update.name),
        b = before.get(update.name);
      if (a && (a.sha !== b?.sha || a.mode !== b?.mode)) {
        update.date = date;
        update.commit = current;
      }
    }
    state.steps++;
    state.next = commit.parents[0] || null;
    state.complete = !state.next || state.updates.every((u) => u.commit);
  }
  if (new TextEncoder().encode(JSON.stringify(state)).length <= MAX_BYTES)
    await storage.put(key, state);
  else state.limited = true;
  return {
    ref: state.ref,
    path: state.path,
    updates: state.updates,
    complete: state.complete,
    limited: state.limited,
  };
}
