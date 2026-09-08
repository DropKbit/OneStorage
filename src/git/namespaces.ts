import { ForgeRepository } from "./forge";
import { RefStorage } from "./repository";
import { ObjectStore, Refs, checkRefs } from "./objects";
import type { WritePolicy } from "./policy";
import { fail } from "../security";
export const EPHEMERAL = "refs/namespaces/ephemeral/";
export function namespaceRepositories(
  store: ObjectStore,
  storage: RefStorage,
  initial: Refs,
  defaultBranch: string,
  policy: WritePolicy,
) {
  let all = initial;
  const select = (ephemeral = false): ForgeRepository => {
    const refs = Object.fromEntries(
      Object.entries(all)
        .filter(([ref]) =>
          ephemeral ? ref.startsWith(EPHEMERAL) : !ref.startsWith(EPHEMERAL),
        )
        .map(([ref, sha]) => [
          ephemeral ? ref.slice(EPHEMERAL.length) : ref,
          sha,
        ]),
    );
    const scoped: RefStorage = {
      get: async <T>(key: string) =>
        key === "refs.v2" ? (refs as T) : storage.get<T>(key),
      put: async (key, value) => {
        if (key !== "refs.v2") fail(400, "Unexpected namespace storage key");
        const next = value as Refs;
        for (const name of Object.keys(next))
          if (!/^refs\/(heads|tags|notes)\//.test(name))
            fail(400, "Nested namespace writes are not allowed");
        const merged = Object.fromEntries(
          Object.entries(all).filter(([ref]) =>
            ephemeral ? !ref.startsWith(EPHEMERAL) : ref.startsWith(EPHEMERAL),
          ),
        );
        for (const [ref, sha] of Object.entries(next))
          merged[(ephemeral ? EPHEMERAL : "") + ref] = sha;
        checkRefs(merged);
        await storage.put("refs.v2", merged);
        all = merged;
      },
    };
    const repo = new ForgeRepository(
      store,
      scoped,
      refs,
      ephemeral ? "" : defaultBranch,
      { ...policy, namespace: ephemeral ? "ephemeral" : undefined },
    );
    repo.peer = select;
    return repo;
  };
  return select;
}
