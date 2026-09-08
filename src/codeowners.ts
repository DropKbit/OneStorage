import { RE2JS } from "re2js";
import { HTTPException } from "hono/http-exception";
import type { Env, Repo } from "./types";
import {
  ObjectStore,
  LIMITS,
  bytes,
  text,
  parseCommit,
  parseTree,
} from "./git/objects";
import { GitRepository } from "./git/repository";
import { fail } from "./security";
import { roleRank } from "./access";

interface Section {
  name: string;
  required: number;
  defaults: string[];
}
interface Rule {
  line: number;
  section: Section;
  owners: string[];
  pattern: string;
  match: RE2JS;
}
export function ownerPattern(pattern: string) {
  if (
    !pattern ||
    pattern.length > 1000 ||
    /[\[\]\\\x00-\x1f]/.test(pattern) ||
    pattern.includes("..")
  )
    throw Error("Unsupported path pattern");
  const rooted =
    pattern.startsWith("/") || pattern.replace(/\/$/, "").includes("/");
  pattern = pattern.replace(/^\//, "").replace(/\/$/, "");
  if (!pattern) throw Error("Empty path pattern");
  let expression = rooted ? "^" : "^(?:.*/)?";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      i++;
      if (pattern[i + 1] === "/") {
        expression += "(?:.*/)?";
        i++;
      } else expression += ".*";
    } else if (c === "*") expression += "[^/]*";
    else if (c === "?") expression += "[^/]";
    else expression += /[.()+{}^$|]/.test(c) ? "\\" + c : c;
  }
  return RE2JS.compile(expression + "(?:/.*)?$");
}
function owners(tokens: string[]) {
  if (
    tokens.some(
      (t) =>
        !/^@[a-z0-9][a-z0-9_-]{0,47}$/i.test(t) &&
        !/^@@(developer|maintainer|owner)$/.test(t),
    )
  )
    throw Error(
      "Owners must be @username, @workspace or @@developer/maintainer/owner",
    );
  return [...new Set(tokens.map((t) => t.toLowerCase()))];
}
export function parseCodeowners(source: string) {
  const rules: Rule[] = [],
    errors: string[] = [];
  if (bytes(source).length > 128 * 1024)
    return { rules, errors: ["CODEOWNERS exceeds 128 KiB"] };
  const lines = source.split(/\r?\n/);
  if (lines.length > 1000)
    return { rules, errors: ["CODEOWNERS exceeds 1000 lines"] };
  let section: Section = { name: "Default", required: 1, defaults: [] };
  const sections = new Map<string, Section>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    try {
      if (/^\^?\[/.test(line)) {
        const heading = line.match(
          /^(\^)?\[([^\]]{1,100})\](?:\[([1-9]|10)\])?(?:\s+(.*))?$/,
        );
        if (!heading)
          throw Error("Invalid section header (approval count 1–10)");
        const key = heading[2].trim().toLowerCase();
        if (!key) throw Error("Empty section name");
        const defaults = owners(
          (heading[4] || "").split(/\s+/).filter(Boolean),
        );
        const required = heading[1] ? 0 : Number(heading[3] || 1);
        section = sections.get(key) || {
          name: heading[2].trim(),
          required,
          defaults,
        };
        section.required = Math.max(section.required, required);
        section.defaults = defaults;
        sections.set(key, section);
        continue;
      }
      // Escaped spaces are the only path escape; no inline comments or email identities.
      const tokens = line.match(/(?:\\ |\S)+/g)!;
      const pattern = tokens.shift()!.replace(/\\ /g, " ");
      const excluded = pattern.startsWith("!");
      if (excluded && tokens.length)
        throw Error("Exclusions cannot specify owners");
      const assigned = excluded
        ? []
        : tokens.length
          ? owners(tokens)
          : [...section.defaults];
      rules.push({
        line: i + 1,
        section,
        owners: assigned,
        pattern,
        match: ownerPattern(excluded ? pattern.slice(1) : pattern),
      });
    } catch (e) {
      errors.push(`Line ${i + 1}: ${(e as Error).message}`);
    }
  }
  return { rules, errors };
}
/** Compare tree entries, including deletions, modes and gitlinks; never read file bodies. */
export async function changedOwnerPaths(
  store: ObjectStore,
  source: string,
  target: string,
) {
  const trees = await Promise.all(
    [source, target].map(async (sha) => parseCommit(await store.get(sha)).tree),
  );
  const paths = new Set<string>();
  let entries = 0;
  async function compare(
    left: string | undefined,
    right: string | undefined,
    prefix: string,
    depth: number,
  ) {
    if (left === right) return;
    if (depth > LIMITS.depth) fail(413, "CODEOWNERS tree depth exceeded");
    const read = async (sha?: string) => {
      if (!sha) return [];
      const o = await store.get(sha);
      if (o.type !== "tree") fail(400, "Git object graph type mismatch");
      const result = parseTree(o.data);
      entries += result.length;
      if (entries > LIMITS.graph * 2)
        fail(413, "CODEOWNERS tree budget exceeded");
      return result;
    };
    const a = new Map((await read(left)).map((e) => [e.name, e]));
    const b = new Map((await read(right)).map((e) => [e.name, e]));
    for (const name of new Set([...a.keys(), ...b.keys()])) {
      const old = a.get(name),
        next = b.get(name),
        path = prefix + name;
      if (old?.sha === next?.sha && old?.mode === next?.mode) continue;
      if (old?.type === "tree" || next?.type === "tree")
        await compare(
          old?.type === "tree" ? old.sha : undefined,
          next?.type === "tree" ? next.sha : undefined,
          path + "/",
          depth + 1,
        );
      if ((old && old.type !== "tree") || (next && next.type !== "tree"))
        paths.add(path);
      if (paths.size > LIMITS.graph) fail(413, "Too many CODEOWNERS paths");
    }
  }
  await compare(trees[1], trees[0], "", 0);
  return [...paths].sort();
}
export async function codeownerGate(
  env: Env,
  repo: Repo,
  mr: any,
  approved: Set<string>,
  store: ObjectStore,
) {
  const git = new GitRepository(store, {} as any, {}, repo.default_branch);
  let file: string | null = null,
    source = "",
    error: string | null = null;
  for (const path of [
    "CODEOWNERS",
    ".gitlab/CODEOWNERS",
    "docs/CODEOWNERS",
    ".github/CODEOWNERS",
  ]) {
    let entry;
    try {
      entry = (await git.entry(mr.target_sha, path)).entry;
    } catch (e) {
      if (e instanceof HTTPException && e.status === 404) continue;
      throw e;
    }
    file = path;
    if (entry.type !== "blob" || entry.mode === "120000") {
      error = "CODEOWNERS must be a regular file";
      break;
    }
    const object = await store.get(entry.sha);
    if (object.data.length > 128 * 1024 || object.data.includes(0)) {
      error = "CODEOWNERS must be UTF-8 text within 128 KiB";
      break;
    }
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(object.data);
    } catch {
      error = "CODEOWNERS must be UTF-8 text";
    }
    break;
  }
  const parsed = parseCodeowners(source),
    errors = error ? [error] : parsed.errors;
  if (!file) errors.push("No CODEOWNERS in the reviewed target commit");
  const requirements: {
    section: string;
    line: number;
    pattern: string;
    paths: string[];
    path_count: number;
    eligible_count: number;
    approved_count: number;
    owners: string[];
    eligible: string[];
    approved: string[];
    required: number;
    allowed: boolean;
  }[] = [];
  if (!errors.length) {
    const paths = await changedOwnerPaths(store, mr.source_sha, mr.target_sha);
    if (paths.length * parsed.rules.length > 250000)
      fail(413, "CODEOWNERS exceeds 250000 path/rule comparisons");
    const selected = new Map<Rule, { paths: string[]; count: number }>();
    for (const path of paths) {
      const last = new Map<Section, Rule>();
      for (const rule of parsed.rules)
        if (rule.match.matcher(path).matches()) last.set(rule.section, rule);
      for (const rule of last.values())
        if (rule.owners.length) {
          const matched = selected.get(rule) || { paths: [], count: 0 };
          matched.count++;
          if (matched.paths.length < 20) matched.paths.push(path);
          selected.set(rule, matched);
        }
    }
    const users = (
      await env.DB.prepare(
        "SELECT u.id,u.username,m.role AS direct,w.role AS inherited FROM users u LEFT JOIN members m ON m.repo_id=? AND m.user_id=u.id LEFT JOIN workspace_members w ON w.workspace_id=? AND w.user_id=u.id WHERE u.disabled=0 AND u.id!=? AND ((? IS NULL AND u.id=?) OR m.role IN('developer','maintainer','owner') OR w.role IN('developer','maintainer','owner')) LIMIT 1001",
      )
        .bind(
          repo.id,
          repo.workspace_id || null,
          mr.author_id,
          repo.workspace_id || null,
          repo.owner_id,
        )
        .all<any>()
    ).results;
    if (users.length > 1000)
      errors.push("CODEOWNERS exceeds 1000 eligible members");
    const workspace = repo.workspace_id
      ? await env.DB.prepare("SELECT slug FROM workspaces WHERE id=?")
          .bind(repo.workspace_id)
          .first<{ slug: string }>()
      : null;
    for (const [rule, matched] of selected) {
      const eligible = users.filter((u) => {
        const role =
          !repo.workspace_id && u.id === repo.owner_id
            ? "owner"
            : roleRank[u.direct || "guest"] >= roleRank[u.inherited || "guest"]
              ? u.direct
              : u.inherited;
        return rule.owners.some(
          (owner) =>
            owner === "@" + u.username.toLowerCase() ||
            owner === "@@" + role ||
            (workspace &&
              owner === "@" + workspace.slug.toLowerCase() &&
              roleRank[u.inherited || "guest"] >= 2),
        );
      });
      const accepted = eligible.filter((u) => approved.has(u.id));
      requirements.push({
        section: rule.section.name,
        line: rule.line,
        pattern: rule.pattern,
        paths: matched.paths,
        path_count: matched.count,
        owners: rule.owners,
        eligible: eligible.slice(0, 50).map((u) => u.username),
        eligible_count: eligible.length,
        approved: accepted.slice(0, 10).map((u) => u.username),
        approved_count: accepted.length,
        required: rule.section.required,
        allowed: accepted.length >= rule.section.required,
      });
    }
  }
  return {
    file,
    target_sha: mr.target_sha,
    errors,
    requirements,
    allowed: !errors.length && requirements.every((r) => r.allowed),
  };
}
