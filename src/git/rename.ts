import { diffLines } from "diff";
import { ObjectStore, TreeEntry, text } from "./objects";
import { fail } from "../security";
/** Conservative one-to-one rename detection; ambiguous matches remain conflicts. */
export async function detectRenames(
  store: ObjectStore,
  base: Map<string, TreeEntry>,
  next: Map<string, TreeEntry>,
) {
  const removed = [...base].filter(([p]) => !next.has(p)),
    added = [...next].filter(([p]) => !base.has(p)),
    result = new Map<string, string>(),
    used = new Set<string>();
  let comparisons = 0;
  for (const [path, old] of removed) {
    let best = "",
      score = 0,
      tie = false;
    for (const [candidate, value] of added) {
      if (
        used.has(candidate) ||
        value.type !== old.type ||
        (value.mode === "120000" && old.mode !== "120000")
      )
        continue;
      let similarity = 0;
      if (value.sha === old.sha) similarity = 1;
      else if (
        value.type === "blob" &&
        value.mode !== "120000" &&
        old.mode !== "120000"
      ) {
        if (++comparisons > 256) fail(413, "Rename comparison budget exceeded");
        const a = await store.get(old.sha),
          b = await store.get(value.sha);
        if (
          a.data.length > 256 * 1024 ||
          b.data.length > 256 * 1024 ||
          a.data.includes(0) ||
          b.data.includes(0)
        )
          continue;
        const changes = diffLines(text(a.data), text(b.data), {
          timeout: 100,
          maxEditLength: 4000,
        });
        if (!changes) continue;
        const common = changes
          .filter((c) => !c.added && !c.removed)
          .reduce((n, c) => n + c.value.length, 0);
        similarity = common / Math.max(a.data.length, b.data.length, 1);
      }
      if (similarity >= 0.5 && similarity > score) {
        score = similarity;
        best = candidate;
        tie = false;
      } else if (similarity === score && score >= 0.5) tie = true;
    }
    if (best && !tie) {
      result.set(path, best);
      used.add(best);
    }
  }
  return result;
}
export async function alignRenames(
  store: ObjectStore,
  base: Map<string, TreeEntry>,
  a: Map<string, TreeEntry>,
  b: Map<string, TreeEntry>,
) {
  const ours = new Map(a),
    theirs = new Map(b),
    original = new Map(base),
    conflicts: any[] = [];
  const ar = await detectRenames(store, base, a),
    br = await detectRenames(store, base, b);
  for (const path of new Set([...ar.keys(), ...br.keys()])) {
    const x = ar.get(path),
      y = br.get(path);
    if (x && y && x !== y) {
      conflicts.push({
        path,
        kind: "rename_rename",
        ours_path: x,
        theirs_path: y,
      });
      continue;
    }
    const target = (x || y)!;
    if ((!x && ours.has(target)) || (!y && theirs.has(target))) {
      conflicts.push({ path: target, kind: "rename_add", original_path: path });
      continue;
    }
    original.set(target, original.get(path)!);
    original.delete(path);
    for (const [map, renamed] of [
      [ours, x],
      [theirs, y],
    ] as const) {
      if (!renamed && map.has(path)) {
        map.set(target, map.get(path)!);
        map.delete(path);
      }
    }
  }
  return { ours, theirs, original, conflicts };
}
