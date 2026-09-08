import { applyPatch, parsePatch } from "diff";
import { ForgeRepository, CommitInput, FileEdit } from "./forge";
import { bytes, text, concat, TreeEntry, ZERO } from "./objects";
import { fail } from "../security";
import { inflateMember, applyDelta } from "./pack";
const alphabet =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~";
function unquote(value: string) {
  value = value.trim();
  if (!value.startsWith('"')) return value;
  if (!value.endsWith('"')) fail(400, "Invalid quoted patch path");
  const body = value.slice(1, -1),
    out: number[] = [];
  for (let i = 0; i < body.length;) {
    if (body[i] !== "\\") {
      const point = body.codePointAt(i)!;
      const char = String.fromCodePoint(point);
      out.push(...bytes(char));
      i += char.length;
      continue;
    }
    i++;
    const octal = body.slice(i).match(/^[0-7]{1,3}/);
    if (octal) {
      const n = parseInt(octal[0], 8);
      if (n > 255) fail(400, "Invalid path octal escape");
      out.push(n);
      i += octal[0].length;
      continue;
    }
    const escapes: Record<string, number> = {
      a: 7,
      b: 8,
      t: 9,
      n: 10,
      v: 11,
      f: 12,
      r: 13,
      "\\": 92,
      '"': 34,
    };
    if (escapes[body[i]] === undefined) fail(400, "Invalid quoted patch path");
    out.push(escapes[body[i++]]);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(out),
    );
  } catch {
    fail(400, "Patch paths must be UTF-8");
  }
}
function patchPath(value: string) {
  value = unquote(value);
  if (value === "/dev/null") return null;
  if (!/^[ab]\//.test(value))
    fail(400, "Patch paths must use a/ and b/ prefixes");
  return value.slice(2);
}
function binaryData(lines: string[], base: Uint8Array) {
  const m = lines[0]?.match(/^(literal|delta) (\d+)$/);
  if (!m) fail(400, "Invalid binary patch block");
  const blocks = [];
  let i = 1;
  for (; i < lines.length && lines[i]; i++) {
    const row = lines[i],
      c = row.charCodeAt(0),
      n = c >= 65 && c <= 90 ? c - 64 : c >= 97 && c <= 122 ? c - 70 : 0;
    if (!n || row.length !== 1 + Math.ceil(n / 4) * 5)
      fail(400, "Invalid binary patch base85 row");
    const data = new Uint8Array(Math.ceil(n / 4) * 4);
    for (let j = 1, k = 0; j < row.length; j += 5, k += 4) {
      let v = 0;
      for (let x = 0; x < 5; x++) {
        const at = alphabet.indexOf(row[j + x]);
        if (at < 0) fail(400, "Invalid base85 character");
        v = v * 85 + at;
      }
      if (v > 0xffffffff) fail(400, "Base85 integer overflow");
      new DataView(data.buffer).setUint32(k, v);
    }
    blocks.push(data.subarray(0, n));
  }
  const compressed = concat(...blocks),
    inflated = inflateMember(compressed);
  if (
    inflated.consumed !== compressed.length ||
    inflated.data.length !== Number(m[2])
  )
    fail(400, "Binary patch size mismatch");
  return m[1] === "literal" ? inflated.data : applyDelta(base, inflated.data);
}
/** Applies Git-format text and binary patches to staged objects; publication is a single guarded commit. */
export async function applyGitPatch(
  repo: ForgeRepository,
  metadata: Omit<CommitInput, "files">,
  patch: Uint8Array,
) {
  if (patch.length > 16 * 1024 * 1024) fail(413, "Patch exceeds 16 MiB");
  const raw = text(patch);
  if (!raw.startsWith("diff --git ")) fail(400, "Expected Git-format patch");
  const sections = raw.split(/(?=^diff --git )/m).filter(Boolean),
    ref = metadata.target_branch;
  const old = repo.refs["refs/heads/" + ref] || null;
  if (
    metadata.expected_target_sha !== undefined &&
    old !== metadata.expected_target_sha
  )
    fail(409, "Branch moved");
  const base =
    old ||
    (metadata.base_branch || metadata.base_ref
      ? await (repo.peer?.(!!metadata.ephemeral_base) || repo).revision(
          metadata.base_branch || metadata.base_ref!,
        )
      : null);
  const edits: FileEdit[] = [];
  for (const section of sections) {
    const lines = section.split("\n"),
      match = lines[0].match(
        /^diff --git ("(?:[^"\\]|\\.)*"|a\/.*?) ("(?:[^"\\]|\\.)*"|b\/.*)$/,
      );
    if (!match) fail(400, "Invalid patch file header");
    let from = patchPath(match[1]),
      to = patchPath(match[2]);
    if (from) repo.path(from);
    if (to) repo.path(to);
    const copyFrom = lines.find((l) => l.startsWith("copy from ")),
      copyTo = lines.find((l) => l.startsWith("copy to "));
    if (copyFrom || copyTo) {
      if (!copyFrom || !copyTo) fail(400, "Incomplete copy headers");
      from = unquote(copyFrom.slice(10));
      to = unquote(copyTo.slice(8));
      repo.path(from!);
      repo.path(to!);
    }
    const renameFrom = lines.find((l) => l.startsWith("rename from ")),
      renameTo = lines.find((l) => l.startsWith("rename to "));
    if (renameFrom || renameTo) {
      if (!renameFrom || !renameTo) fail(400, "Incomplete rename headers");
      from = unquote(renameFrom.slice(12));
      to = unquote(renameTo.slice(10));
      repo.path(from!);
      repo.path(to!);
    }
    const isNew = lines.some((l) => l.startsWith("new file mode ")),
      deleted = lines.some((l) => l.startsWith("deleted file mode "));
    if (isNew) from = null;
    if (deleted) to = null;
    const entry = from && base ? await repo.maybeEntry(base, from) : undefined;
    if (from && !entry) fail(409, "Patch source file missing: " + from);
    if (isNew && to && base && (await repo.maybeEntry(base, to)))
      fail(409, "Patch adds existing file");
    const input =
      entry?.type === "blob"
        ? (await repo.store.get(entry.sha)).data
        : bytes(entry ? `Subproject commit ${entry.sha}\n` : "");
    const index = lines
      .find((l) => l.startsWith("index "))
      ?.match(/^index ([0-9a-f]+)\.\.([0-9a-f]+)(?: (\d+))?$/);
    if (
      index &&
      entry &&
      !/^0+$/.test(index[1]) &&
      !entry.sha.startsWith(index[1])
    )
      fail(409, "Patch base object does not match");
    const mode =
      lines.find((l) => l.startsWith("new file mode "))?.slice(14) ||
      lines.find((l) => l.startsWith("new mode "))?.slice(9) ||
      index?.[3] ||
      entry?.mode ||
      "100644";
    let output = input;
    const binary = lines.indexOf("GIT binary patch");
    if (binary >= 0) output = binaryData(lines.slice(binary + 1), input);
    else if (lines.some((l) => l.startsWith("@@ "))) {
      const start = lines.findIndex((l) => l.startsWith("--- "));
      if (start < 0) fail(400, "Missing text patch headers");
      let parsed;
      try {
        parsed = parsePatch(lines.slice(start).join("\n"));
      } catch {
        fail(400, "Invalid unified patch");
      }
      if (parsed.length !== 1) fail(400, "Expected one patch per file");
      const result = applyPatch(text(input), parsed[0], {
        fuzzFactor: 0,
        autoConvertLineEndings: false,
      });
      if (result === false) fail(409, "Patch context does not match: " + from);
      output = bytes(result);
    } else if (lines.some((l) => l.startsWith("Binary files ")))
      fail(400, "Binary patch must include GIT binary patch data");
    if (from && from !== to && !copyFrom)
      edits.push({ path: from, operation: "delete", content: null });
    if (to) {
      if (mode === "160000") {
        const m = text(output).match(/^Subproject commit ([0-9a-f]{40})\n?$/);
        if (!m) fail(400, "Invalid gitlink patch");
        edits.push({ path: to, mode, sha: m[1] });
      } else {
        const blob = await repo.store.create("blob", output);
        if (index && !/^0+$/.test(index[2]) && !blob.oid.startsWith(index[2]))
          fail(409, "Patch result hash does not match");
        edits.push({ path: to, mode, sha: blob.oid });
      }
    } else if (from && !edits.some((e) => e.path === from))
      edits.push({ path: from, operation: "delete", content: null });
  }
  return repo.commitFiles({ ...metadata, files: edits });
}
