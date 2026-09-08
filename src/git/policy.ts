import { fail } from "../security";
import { RefPolicy, refOperations } from "../delegation";
import { ObjectStore, Refs, parseCommit, ZERO, LIMITS } from "./objects";
import { verifyCommitSignature } from "./signatures";
export interface WritePolicy {
  rules: RefPolicy[];
  beforePublish?: (
    before: Refs,
    after: Refs,
    ephemeral: boolean,
  ) => Promise<Refs>;
  namespace?: "ephemeral";
  allowForce?: boolean;
  signingKeys?: () => Promise<{ format: string; public_key: string }[]>;
}
async function commits(store: ObjectStore, tip: string | undefined) {
  const visited = new Set<string>(),
    out = new Set<string>(),
    todo = tip ? [tip] : [];
  while (todo.length) {
    const oid = todo.pop()!;
    if (visited.has(oid)) continue;
    visited.add(oid);
    if (visited.size > LIMITS.graph) fail(413, "Commit graph too large");
    const o = await store.get(oid);
    if (o.type === "tag") {
      const { parseTag } = await import("./objects");
      todo.push(parseTag(o).oid);
      continue;
    }
    if (o.type !== "commit") continue;
    out.add(oid);
    if (out.size > LIMITS.graph) fail(413, "Commit graph too large");
    todo.push(...parseCommit(o).parents);
  }
  return out;
}
export async function enforceWritePolicy(
  store: ObjectStore,
  before: Refs,
  after: Refs,
  policy: WritePolicy,
) {
  let keys: { format: string; public_key: string }[] | undefined;
  for (const ref of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const old = before[ref],
      next = after[ref];
    if (old === next) continue;
    const full =
        policy.namespace === "ephemeral"
          ? "refs/namespaces/ephemeral/" + ref
          : ref,
      ops = refOperations(full, policy.rules);
    if (ops.includes("no-push"))
      fail(403, "Ref policy forbids update: " + full);
    if (
      old &&
      next &&
      ops.includes("no-force-push") &&
      !(await fastForward(store, old, next))
    )
      fail(409, "Ref policy forbids non-fast-forward update: " + full);
    if (next && ops.includes("verify-sig")) {
      keys ||= (await policy.signingKeys?.()) || [];
      const previous = await commits(store, old);
      for (const oid of await commits(store, next))
        if (
          !previous.has(oid) &&
          !(await verifyCommitSignature(await store.get(oid), keys))
        )
          fail(403, "Commit signature required from a registered key: " + oid);
    }
  }
}

async function fastForward(store: ObjectStore, old: string, next: string) {
  try {
    const a = await store.resolve(old, {}, ""),
      b = await store.resolve(next, {}, "");
    return store.ancestor(a, b);
  } catch (e) {
    if ((e as any).status === 409) return false;
    throw e;
  }
}
