import { blameRanges } from "./blame-range";
import { literalPatch } from "./binary-patch";
import { alignRenames } from "./rename";
import { diffLines, createTwoFilesPatch } from "diff";
import { diff3Merge } from "node-diff3";
import { RE2JS } from "re2js";
import { GitRepository } from "./repository";
import {
  ObjectStore,
  Refs,
  TreeEntry,
  GitObject,
  bytes,
  text,
  concat,
  parseCommit,
  parseTag,
  parseTree,
  treeBytes,
  isOid,
  ZERO,
  LIMITS,
} from "./objects";
import { fail } from "../security";
import { base64, unbase64, commitSignature } from "./signatures";
import {
  paginate,
  PageOptions,
  identity,
  parseIdentity,
  lineTokens,
  pathFilter,
  tarEntries,
  streamFrom,
} from "./forge-utils";
export interface SignatureIdentity {
  name: string;
  email: string;
  timestamp?: number;
}
export interface FileEdit {
  path: string;
  content?: string | null;
  data?: string;
  mode?: string;
  sha?: string;
  operation?: "upsert" | "delete";
}
export interface CommitInput {
  target_branch: string;
  expected_target_sha?: string | null;
  base_branch?: string;
  base_ref?: string;
  ephemeral_base?: boolean;
  commit_message: string;
  author: SignatureIdentity;
  committer?: SignatureIdentity;
  files: FileEdit[];
}
export class ForgeRepository extends GitRepository {
  peer?: (ephemeral: boolean) => ForgeRepository;
  async revision(ref = "HEAD"): Promise<string> {
    if (/^[0-9a-f]{4,39}$/.test(ref)) {
      const matches = [
        ...(await this.store.walk(Object.values(this.refs))),
      ].filter((id) => id.startsWith(ref));
      if (matches.length !== 1)
        fail(409, "Short object ID is missing or ambiguous");
      ref = matches[0];
    }
    const match = ref.match(/^(.*?)([~^])(\d*)$/);
    if (match) {
      let id = await this.revision(match[1]);
      const n = Number(match[3] || 1);
      if (!Number.isSafeInteger(n) || n > LIMITS.graph)
        fail(400, "Invalid ancestry selector");
      if (match[2] === "^") {
        if (n === 0) return id;
        const c = parseCommit(await this.store.get(id));
        if (!c.parents[n - 1]) fail(409, "Parent not found");
        return c.parents[n - 1];
      }
      for (let i = 0; i < n; i++) {
        const c = parseCommit(await this.store.get(id));
        if (!c.parents[0]) fail(409, "Ancestor not found");
        id = c.parents[0];
      }
      return id;
    }
    return this.resolve(ref);
  }
  async resolve(ref = "HEAD"): Promise<string> {
    if (/^[0-9a-f]{4,39}$/.test(ref) || /[~^]\d*$/.test(ref))
      return this.revision(ref);
    return super.resolve(ref);
  }
  async metadata(ref: string) {
    const sha = await this.revision(ref),
      o = await this.store.get(sha),
      c = parseCommit(o),
      raw = text(o.data),
      headers = raw.slice(0, raw.indexOf("\n\n")).split("\n"),
      a = parseIdentity(c.author),
      committer = parseIdentity(
        headers.find((l) => l.startsWith("committer "))!.slice(10),
      ),
      sig = commitSignature(o);
    return {
      sha,
      tree_sha: c.tree,
      parent_shas: c.parents,
      message: c.message,
      author: a.name,
      author_name: a.name,
      author_email: a.email,
      committer_name: committer.name,
      committer_email: committer.email,
      date: committer.date,
      raw_date: committer.date,
      ...(sig.signature
        ? {
            signature: sig.signature,
            payload: text(sig.payload),
            payload_base64: base64(sig.payload),
          }
        : {}),
    };
  }
  async commitHistory(ref = "HEAD", path?: string) {
    const root = await this.revision(ref),
      seen = new Set<string>(),
      todo = [root],
      all = [];
    while (todo.length) {
      const id = todo.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      if (seen.size > LIMITS.graph) fail(413, "History traversal too large");
      const c = parseCommit(await this.store.get(id));
      todo.push(...c.parents);
      let include = true;
      if (path) {
        this.path(path);
        const current = await this.maybeEntry(id, path);
        include = !c.parents.length
          ? !!current
          : !(
              await Promise.all(c.parents.map((p) => this.maybeEntry(p, path)))
            ).some(
              (previous) =>
                previous?.sha === current?.sha &&
                previous?.mode === current?.mode,
            );
      }
      if (include) all.push(await this.metadata(id));
    }
    all.sort(
      (a, b) => b.date.localeCompare(a.date) || a.sha.localeCompare(b.sha),
    );
    return { root, all };
  }
  async maybeEntry(ref: string, path: string) {
    try {
      return (await this.entry(ref, path)).entry;
    } catch (e) {
      if ((e as any).status === 404) return undefined;
      throw e;
    }
  }
  async listCommits(options: PageOptions & { ref?: string; path?: string }) {
    const { root, all } = await this.commitHistory(
        options.ref || "HEAD",
        options.path,
      ),
      p = paginate(
        all,
        options,
        root + ":commits:" + JSON.stringify(options.path || ""),
      );
    return {
      commits: p.items,
      next_cursor: p.next_cursor,
      has_more: p.has_more,
      ref: root,
    };
  }
  listBranches(options: PageOptions = {}) {
    const branches = Object.entries(this.refs)
        .filter(([r]) => r.startsWith("refs/heads/"))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([ref, sha]) => ({ name: ref.slice(11), sha })),
      p = paginate(branches, options, JSON.stringify(branches));
    return {
      branches: p.items,
      next_cursor: p.next_cursor,
      has_more: p.has_more,
    };
  }
  async createBranch(b: {
    target_branch: string;
    base_ref?: string;
    base_branch?: string;
    base_is_ephemeral?: boolean;
    expected_target_sha?: string | null;
  }) {
    const name = this.branch(b.target_branch),
      ref = "refs/heads/" + name,
      old = this.refs[ref];
    if (old) fail(409, "Branch already exists");
    if (b.expected_target_sha) fail(409, "Branch does not exist");
    const source = this.peer?.(!!b.base_is_ephemeral) || this,
      sha = await source.revision(b.base_ref || b.base_branch || "HEAD");
    await this.updates([{ ref, old: ZERO, next: sha }]);
    return { target_branch: name, sha };
  }
  async deleteBranch(name: string, expected?: string) {
    this.branch(name);
    const ref = "refs/heads/" + name,
      old = this.refs[ref];
    if (!old) fail(404, "Branch not found");
    if (expected && expected !== old) fail(409, "Branch moved");
    await this.updates([{ ref, old, next: ZERO }]);
    return { deleted: true, name };
  }
  async listTags(options: PageOptions = {}) {
    const tags = [];
    for (const [ref, oid] of Object.entries(this.refs)
      .filter(([r]) => r.startsWith("refs/tags/"))
      .sort(([a], [b]) => a.localeCompare(b))) {
      let target = await this.store.get(oid),
        depth = 0;
      while (target.type === "tag") {
        if (++depth > LIMITS.depth) fail(413, "Tag chain too deep");
        target = await this.store.get(parseTag(target).oid);
      }
      tags.push({
        name: ref.slice(10),
        sha: target.oid,
        object_sha: oid,
        type: target.type,
      });
    }
    const p = paginate(tags, options, JSON.stringify(tags));
    return { tags: p.items, next_cursor: p.next_cursor, has_more: p.has_more };
  }
  async createTag(name: string, ref = "HEAD") {
    const target = "refs/tags/" + name;
    if (this.refs[target]) fail(409, "Tag already exists");
    const sha = await this.revision(ref);
    await this.updates([{ ref: target, old: ZERO, next: sha }]);
    return { name, sha };
  }
  async deleteTag(name: string) {
    const ref = "refs/tags/" + name,
      old = this.refs[ref];
    if (!old) fail(404, "Tag not found");
    await this.updates([{ ref, old, next: ZERO }]);
    return { deleted: true, name };
  }
  async buildTree(files: Map<string, TreeEntry>) {
    type Directory = Map<string, TreeEntry | Directory>;
    const root: Directory = new Map();
    for (const [path, e] of files) {
      this.path(path);
      let dir = root;
      const parts = path.split("/");
      if (parts.length > LIMITS.depth) fail(413, "Directory nesting too deep");
      for (const part of parts.slice(0, -1)) {
        const found = dir.get(part);
        if (found && !(found instanceof Map))
          fail(409, "File/directory conflict");
        if (!found) dir.set(part, new Map());
        dir = dir.get(part) as Directory;
      }
      const last = parts.at(-1)!;
      if (dir.get(last) instanceof Map) fail(409, "File/directory conflict");
      dir.set(last, { ...e, name: last });
    }
    const build = async (dir: Directory): Promise<string> => {
      const entries: TreeEntry[] = [];
      for (const [name, item] of dir)
        entries.push(
          item instanceof Map
            ? { name, sha: await build(item), type: "tree", mode: "40000" }
            : item,
        );
      return (await this.store.create("tree", treeBytes(entries))).oid;
    };
    return build(root);
  }
  async writeCommit(
    tree: string,
    parents: string[],
    b: {
      commit_message: string;
      author: SignatureIdentity;
      committer?: SignatureIdentity;
    },
  ) {
    if (
      typeof b.commit_message !== "string" ||
      !b.commit_message.trim() ||
      b.commit_message.length > 10000 ||
      b.commit_message.includes("\0")
    )
      fail(400, "Invalid commit message");
    const author = identity(b.author),
      committer = identity(b.committer || b.author);
    return this.store.create(
      "commit",
      bytes(
        `tree ${tree}\n${parents.map((p) => "parent " + p + "\n").join("")}author ${author}\ncommitter ${committer}\n\n${b.commit_message}${b.commit_message.endsWith("\n") ? "" : "\n"}`,
      ),
    );
  }
  async commitFiles(b: CommitInput) {
    this.branch(b.target_branch);
    const ref = "refs/heads/" + b.target_branch,
      old = this.refs[ref] || null;
    if (b.expected_target_sha !== undefined && b.expected_target_sha !== old)
      fail(409, "Branch moved; refresh expected_target_sha");
    let parent = old;
    if (!parent && (b.base_branch || b.base_ref))
      parent = await (this.peer?.(!!b.ephemeral_base) || this).revision(
        b.base_branch || b.base_ref!,
      );
    if (b.ephemeral_base && !b.base_branch && !b.base_ref)
      fail(400, "Ephemeral base requires a base ref");
    const files = parent
      ? (await this.files(parent)).files
      : new Map<string, TreeEntry>();
    if (!Array.isArray(b.files) || !b.files.length || b.files.length > 1000)
      fail(400, "Commit requires 1–1000 operations");
    const seen = new Set<string>();
    for (const file of b.files) {
      this.path(file.path);
      if (seen.has(file.path)) fail(400, "Duplicate operation path");
      seen.add(file.path);
      if (file.operation === "delete" || file.content === null) {
        for (const p of files.keys())
          if (p === file.path || p.startsWith(file.path + "/")) files.delete(p);
        continue;
      }
      const previous = files.get(file.path);
      const mode = file.mode || previous?.mode || "100644";
      if (!["100644", "100755", "120000", "160000"].includes(mode))
        fail(400, "Invalid Git file mode");
      let sha: string;
      if (mode === "160000") {
        if (!file.sha || !isOid(file.sha))
          fail(400, "Gitlink requires a full commit SHA");
        sha = file.sha;
      } else {
        if (file.sha && file.data === undefined && file.content === undefined) {
          const object = await this.store.get(file.sha);
          if (object.type !== "blob") fail(400, "File must reference a blob");
          sha = object.oid;
        } else {
          const data =
            file.data !== undefined
              ? unbase64(file.data)
              : typeof file.content === "string"
                ? bytes(file.content)
                : undefined;
          if (!data) fail(400, "File requires content or base64 data");
          sha = (await this.store.create("blob", data)).oid;
        }
      }
      files.set(file.path, {
        name: file.path.split("/").at(-1)!,
        mode,
        type: mode === "160000" ? "commit" : "blob",
        sha,
      });
    }
    const tree = await this.buildTree(files),
      commit = await this.writeCommit(tree, parent ? [parent] : [], b);
    await this.publish({ ...this.refs, [ref]: commit.oid });
    return {
      sha: commit.oid,
      commit_sha: commit.oid,
      tree_sha: tree,
      target_branch: b.target_branch,
      blob_count: b.files.filter(
        (f) => f.operation !== "delete" && f.content !== null,
      ).length,
      ref_update: {
        branch: b.target_branch,
        old_sha: old || ZERO,
        new_sha: commit.oid,
      },
    };
  }
  async restore(b: Omit<CommitInput, "files"> & { base_ref: string }) {
    this.branch(b.target_branch);
    const ref = "refs/heads/" + b.target_branch,
      old = this.refs[ref];
    if (!old) fail(404, "Target branch not found");
    if (b.expected_target_sha !== undefined && b.expected_target_sha !== old)
      fail(409, "Branch moved");
    const source = await (this.peer?.(!!b.ephemeral_base) || this).root(
        b.base_ref,
      ),
      commit = await this.writeCommit(source.tree, [old], b);
    await this.publish({ ...this.refs, [ref]: commit.oid });
    return {
      sha: commit.oid,
      commit_sha: commit.oid,
      tree_sha: source.tree,
      ref_update: {
        branch: b.target_branch,
        old_sha: old,
        new_sha: commit.oid,
      },
    };
  }
  notesRef(value = "commits") {
    const ref = value.startsWith("refs/notes/") ? value : "refs/notes/" + value;
    if (!/^refs\/notes\//.test(ref)) fail(400, "Invalid notes ref");
    this.branch(ref.slice(11));
    return ref;
  }
  async noteFiles(ref: string) {
    const tip = this.refs[ref];
    return tip ? (await this.files(tip)).files : new Map<string, TreeEntry>();
  }
  async getNote(oid: string, notes = "commits") {
    if (!isOid(oid)) fail(400, "Note target requires full SHA");
    await this.store.get(oid);
    const ref = this.notesRef(notes),
      files = await this.noteFiles(ref);
    const found = [...files.entries()].find(
      ([path]) => path.replaceAll("/", "") === oid,
    );
    if (!found) fail(404, "Note not found");
    return {
      sha: oid,
      notes_ref: ref,
      note: text((await this.store.get(found[1].sha)).data),
      note_sha: found[1].sha,
      ref_sha: this.refs[ref],
    };
  }
  async writeNote(b: {
    sha: string;
    note?: string;
    notes_ref?: string;
    operation?: "create" | "append" | "delete";
    expected_ref_sha?: string | null;
    author: SignatureIdentity;
  }) {
    if (!isOid(b.sha)) fail(400, "Note target requires full SHA");
    await this.store.get(b.sha);
    const ref = this.notesRef(b.notes_ref),
      old = this.refs[ref] || null;
    if (b.expected_ref_sha !== undefined && b.expected_ref_sha !== old)
      fail(409, "Notes ref moved");
    const files = await this.noteFiles(ref),
      found = [...files.entries()].find(
        ([p]) => p.replaceAll("/", "") === b.sha,
      ),
      op = b.operation || "create";
    if (op === "create" && found) fail(409, "Note already exists");
    if (op === "delete" && !found) fail(404, "Note not found");
    if (op === "delete") files.delete(found![0]);
    else {
      if (typeof b.note !== "string" || bytes(b.note).length > 1024 * 1024)
        fail(400, "Invalid note content");
      let content = b.note;
      if (op === "append" && found)
        content =
          text((await this.store.get(found[1].sha)).data).replace(/\n*$/, "") +
          "\n\n" +
          content;
      if (!content.endsWith("\n")) content += "\n";
      const blob = await this.store.create("blob", bytes(content)),
        path = found?.[0] || b.sha;
      files.set(path, {
        name: path.split("/").at(-1)!,
        type: "blob",
        mode: "100644",
        sha: blob.oid,
      });
    }
    const tree = await this.buildTree(files),
      commit = await this.writeCommit(tree, old ? [old] : [], {
        commit_message: op + " Git note for " + b.sha,
        author: b.author,
      });
    await this.publish({ ...this.refs, [ref]: commit.oid });
    return {
      sha: b.sha,
      notes_ref: ref,
      ref_sha: commit.oid,
      deleted: op === "delete",
    };
  }
  async listFiles(
    options: PageOptions & {
      ref?: string;
      path?: string;
      recursive?: boolean;
      metadata?: boolean;
    },
  ) {
    const root = await this.root(options.ref || "HEAD"),
      path = options.path || "";
    if (path) this.path(path);
    let entries: any[] = [];
    if (options.recursive !== false) {
      for (const [p, e] of (await this.files(root.oid)).files)
        if (!path || p === path || p.startsWith(path + "/"))
          entries.push({
            path: p,
            ...e,
            type:
              e.mode === "120000"
                ? "symlink"
                : e.mode === "160000"
                  ? "submodule"
                  : e.type,
          });
    } else {
      const tree = await this.tree(root.oid, path);
      entries = tree.entries.map((e) => ({
        path: (path ? path + "/" : "") + e.name,
        ...e,
        type:
          e.mode === "120000"
            ? "symlink"
            : e.mode === "160000"
              ? "submodule"
              : e.type,
      }));
    }
    entries.sort((a, b) => a.path.localeCompare(b.path));
    const page = paginate(
      entries,
      options,
      root.oid + ":files:" + path + ":" + options.recursive,
      options.metadata ? 1000 : 5000,
    );
    if (options.metadata)
      for (const e of page.items) {
        const history = await this.commitHistory(root.oid, e.path);
        e.commit = history.all[0] || null;
      }
    return {
      ref: root.oid,
      files: page.items,
      paths: page.items.map((e) => e.path),
      has_more: page.has_more,
      next_cursor: page.next_cursor,
    };
  }
  async rawFile(request: Request, ref: string, path: string) {
    const { oid, entry } = await this.entry(ref, this.path(path));
    if (entry.type !== "blob") fail(400, "Path is not a file");
    const o = await this.store.get(entry.sha),
      meta =
        (await this.commitHistory(oid, path)).all[0] ||
        (await this.metadata(oid)),
      etag = '"' + o.oid + '"',
      modified = new Date(meta.date).toUTCString(),
      headers = new Headers({
        "content-type": "application/octet-stream",
        etag: etag,
        "last-modified": modified,
        "accept-ranges": "bytes",
        "x-git-commit": oid,
        "x-git-object": o.oid,
        "cache-control": "private, max-age=0, must-revalidate",
      });
    const matches = (value: string | null, weak = false) =>
      value?.split(",").some((v) => {
        v = v.trim();
        if (weak) v = v.replace(/^W\//, "");
        return v === "*" || v === etag;
      });
    if (
      request.headers.has("if-match") &&
      !matches(request.headers.get("if-match"))
    )
      return new Response(null, { status: 412, headers });
    if (
      !request.headers.has("if-match") &&
      request.headers.has("if-unmodified-since") &&
      Date.parse(modified) >
        Date.parse(request.headers.get("if-unmodified-since")!)
    )
      return new Response(null, { status: 412, headers });
    if (
      matches(request.headers.get("if-none-match"), true) ||
      (!request.headers.has("if-none-match") &&
        request.headers.has("if-modified-since") &&
        Date.parse(modified) <=
          Date.parse(request.headers.get("if-modified-since")!))
    )
      return new Response(null, { status: 304, headers });
    let start = 0,
      end = o.data.length - 1,
      status = 200;
    const range = request.headers.get("range"),
      ifRange = request.headers.get("if-range");
    if (
      range &&
      (!ifRange ||
        ifRange === etag ||
        Date.parse(ifRange) >= Date.parse(modified))
    ) {
      const m = range.match(/^bytes=(\d*)-(\d*)$/);
      if (!m || (!m[1] && !m[2]) || !o.data.length) {
        headers.set("content-range", "bytes */" + o.data.length);
        return new Response(null, { status: 416, headers });
      }
      if (m[1]) {
        start = Number(m[1]);
        end = m[2] ? Math.min(Number(m[2]), end) : end;
      } else {
        const n = Number(m[2]);
        if (n === 0) start = o.data.length;
        else start = Math.max(0, o.data.length - n);
      }
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        start >= o.data.length
      ) {
        headers.set("content-range", "bytes */" + o.data.length);
        return new Response(null, { status: 416, headers });
      }
      status = 206;
      headers.set("content-range", `bytes ${start}-${end}/${o.data.length}`);
    }
    headers.set("content-length", String(Math.max(0, end - start + 1)));
    return new Response(
      request.method === "HEAD"
        ? null
        : (o.data.subarray(start, end + 1) as BodyInit),
      { status, headers },
    );
  }
  async archive(options: {
    ref: string;
    archive?: { prefix?: string };
    include_globs?: string[];
    exclude_globs?: string[];
    max_blob_size?: number;
  }) {
    const { oid, files } = await this.files(options.ref || "HEAD"),
      meta = await this.metadata(oid),
      self = this;
    const selected = [...files].filter(
      ([path, e]) => e.type === "blob" && pathFilter(path, options),
    );
    const entries = async function* () {
      for (const [path, e] of selected) {
        const data = (await self.store.get(e.sha)).data;
        if (
          options.max_blob_size !== undefined &&
          data.length > options.max_blob_size
        )
          continue;
        yield { path, data, mode: e.mode };
      }
    };
    const prefix = options.archive?.prefix || "";
    if (
      prefix &&
      (prefix.startsWith("/") ||
        prefix.split("/").some((p) => p === ".." || p === ".") ||
        /[\0\r\n]/.test(prefix))
    )
      fail(400, "Invalid archive prefix");
    const stream = (
      streamFrom(
        tarEntries(entries(), prefix, Math.floor(Date.parse(meta.date) / 1000)),
      ) as ReadableStream<BufferSource>
    ).pipeThrough(new CompressionStream("gzip"));
    return new Response(stream, {
      headers: {
        "content-type": "application/gzip",
        "content-disposition": `attachment; filename="${oid}.tar.gz"`,
        "x-git-commit": oid,
      },
    });
  }
  async grep(options: any) {
    const query = options.query?.pattern;
    if (typeof query !== "string" || !query || query.length > 1024)
      fail(400, "Search pattern requires 1–1024 characters");
    let re;
    try {
      re = RE2JS.compile(
        query,
        options.query.case_sensitive === false ? RE2JS.CASE_INSENSITIVE : 0,
      );
    } catch {
      fail(400, "Invalid or unsupported RE2 expression");
    }
    const before = Number(options.context?.before || 0),
      after = Number(options.context?.after || 0),
      maxFile = Number(options.limits?.max_matches_per_file ?? 200),
      maxLines = Number(options.limits?.max_lines ?? 2000);
    if (
      ![before, after, maxFile, maxLines].every(Number.isInteger) ||
      before < 0 ||
      before > 50 ||
      after < 0 ||
      after > 50 ||
      maxFile < 1 ||
      maxFile > 2000 ||
      maxLines < 1 ||
      maxLines > 2000
    )
      fail(400, "Invalid search limits");
    const { oid, files } = await this.files(
        options.ref || options.rev || "HEAD",
      ),
      matches: any[] = [];
    let count = 0,
      outputBytes = 0,
      searchWork = 0;
    for (const [path, e] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
      if (
        e.type !== "blob" ||
        !pathFilter(path, { ...options.file_filters, paths: options.paths })
      )
        continue;
      const data = (await this.store.get(e.sha)).data;
      if (data.includes(0)) continue;
      searchWork += data.length * Math.max(query.length, 1);
      if (searchWork > 64 * 1024 * 1024)
        fail(
          413,
          "Search computation budget exceeded; narrow the file filters",
        );
      const lines = text(data).split("\n");
      let fileCount = 0;
      for (let i = 0; i < lines.length; i++) {
        const m = re.matcher(lines[i]);
        if (!m.find()) continue;
        const record = {
          path,
          line: i + 1,
          text: lines[i],
          column: m.start() + 1,
          match: m.group(),
          before: lines.slice(Math.max(0, i - before), i),
          after: lines.slice(i + 1, i + 1 + after),
        };
        const size =
          record.text.length +
          record.before.reduce((n, s) => n + s.length, 0) +
          record.after.reduce((n, s) => n + s.length, 0);
        if (size > 1024 * 1024)
          fail(413, "Search result too large; reduce context");
        outputBytes += bytes(JSON.stringify(record)).length;
        if (outputBytes > 4 * 1024 * 1024)
          fail(
            413,
            "Search results exceed 4 MiB; narrow query or reduce max_lines",
          );
        matches.push(record);
        fileCount++;
        count++;
        if (fileCount >= maxFile || count >= maxLines) break;
      }
      if (count >= maxLines) break;
    }
    const key =
        oid +
        ":grep:" +
        JSON.stringify({
          ...options,
          pagination: undefined,
          cursor: undefined,
          limit: undefined,
        }),
      p = paginate(matches, options.pagination || options, key, 2000);
    return {
      ref: oid,
      matches: p.items,
      next_cursor: p.next_cursor,
      has_more: p.has_more,
      truncated: count >= maxLines,
    };
  }
  async diff(
    source: string,
    target?: string,
    options: { paths?: string[]; context?: number } = {},
  ) {
    const src = await this.revision(source),
      commit = parseCommit(await this.store.get(src)),
      base = target ? await this.revision(target) : commit.parents[0],
      a = base ? (await this.files(base)).files : new Map<string, TreeEntry>(),
      b = (await this.files(src)).files;
    const result: any[] = [];
    let patch = "",
      added = 0,
      removed = 0;
    const context = options.context ?? 3;
    if (!Number.isInteger(context) || context < 0 || context > 100)
      fail(400, "Invalid diff context");
    for (const path of [...new Set([...a.keys(), ...b.keys()])].sort()) {
      if (!pathFilter(path, { paths: options.paths })) continue;
      const old = a.get(path),
        next = b.get(path);
      if (old?.sha === next?.sha && old?.mode === next?.mode) continue;
      const left =
          old?.type === "blob"
            ? (await this.store.get(old.sha)).data
            : bytes(old ? `Subproject commit ${old.sha}\n` : ""),
        right =
          next?.type === "blob"
            ? (await this.store.get(next.sha)).data
            : bytes(next ? `Subproject commit ${next.sha}\n` : ""),
        binary = left.includes(0) || right.includes(0);
      let value = `diff --git ${JSON.stringify("a/" + path)} ${JSON.stringify("b/" + path)}\n`;
      if (!old) value += "new file mode " + next!.mode + "\n";
      else if (!next) value += "deleted file mode " + old.mode + "\n";
      else if (old.mode !== next.mode)
        value += `old mode ${old.mode}\nnew mode ${next.mode}\n`;
      value += `index ${old?.sha || ZERO}..${next?.sha || ZERO}\n`;
      if (binary)
        value +=
          "GIT binary patch\n" + literalPatch(right) + literalPatch(left);
      else {
        const hunks = createTwoFilesPatch(
          old ? "a/" + path : "/dev/null",
          next ? "b/" + path : "/dev/null",
          text(left),
          text(right),
          "",
          "",
          { context, timeout: 500, maxEditLength: 20000 },
        );
        if (!hunks) fail(413, "Diff computation budget exceeded");
        value += hunks.replace(/^=+\n/, "");
        for (const part of diffLines(text(left), text(right), {
          timeout: 500,
          maxEditLength: 20000,
        }) || [])
          if (part.added) added += part.count || 0;
          else if (part.removed) removed += part.count || 0;
      }
      patch += value;
      if (bytes(patch).length > 4 * 1024 * 1024)
        fail(413, "Diff exceeds 4 MiB");
      result.push({
        path,
        status: !old ? "added" : !next ? "deleted" : "modified",
        old_sha: old?.sha || null,
        new_sha: next?.sha || null,
        old_mode: old?.mode || null,
        new_mode: next?.mode || null,
        binary,
        patch: value,
      });
    }
    return {
      source_sha: src,
      target_sha: base || null,
      diff: patch,
      patch,
      files: result,
      stats: { files: result.length, additions: added, deletions: removed },
    };
  }
  async diffBranches(source: string, target: string, paths: string[] = []) {
    const a = await this.revision(source),
      b = await this.revision(target),
      bases = await this.mergeBases(a, b);
    if (!bases.length) fail(409, "Unrelated histories");
    if (bases.length > 1)
      fail(
        409,
        "Multiple merge bases; supply an explicit base to the diff endpoint",
      );
    return {
      ...(await this.diff(a, bases[0], { paths })),
      merge_base_sha: bases[0],
      source_tip_sha: a,
      target_tip_sha: b,
    };
  }
  async compare(source: string, target: string) {
    return this.diff(source, target) as Promise<any>;
  }
  async mergeBases(a: string, b: string) {
    const ancestors = async (tip: string) => {
      const seen = new Set<string>(),
        todo = [tip];
      while (todo.length) {
        const id = todo.pop()!;
        if (seen.has(id)) continue;
        seen.add(id);
        if (seen.size > LIMITS.graph) fail(413, "Merge history too large");
        todo.push(...parseCommit(await this.store.get(id)).parents);
      }
      return seen;
    };
    const ours = await ancestors(a),
      theirs = await ancestors(b),
      common = [...ours].filter((id) => theirs.has(id)),
      parents = new Set<string>();
    for (const id of common)
      for (const p of parseCommit(await this.store.get(id)).parents)
        parents.add(p);
    return common.filter((id) => !parents.has(id));
  }
  async previewMerge(b: {
    source_ref?: string;
    source_branch?: string;
    target_branch: string;
    source_is_ephemeral?: boolean;
    allow_unrelated_histories?: boolean;
    include_content?: boolean;
  }) {
    this.branch(b.target_branch);
    const sourceRepo = this.peer?.(!!b.source_is_ephemeral) || this,
      source = await sourceRepo.revision(b.source_ref || b.source_branch || ""),
      target = await this.revision(b.target_branch),
      bases = await this.mergeBases(target, source);
    if (!bases.length && !b.allow_unrelated_histories)
      fail(409, "Unrelated histories");

    const base = bases[0],
      result =
        source === target || (await this.store.ancestor(source, target))
          ? "no_op"
          : (await this.store.ancestor(target, source))
            ? "fast_forward"
            : "merge_commit",
      left = (await this.files(target)).files,
      right = (await sourceRepo.files(source)).files,
      ancestor = base
        ? (await this.files(base)).files
        : new Map<string, TreeEntry>();
    const { ours, theirs, original, conflicts } = await alignRenames(
        this.store,
        ancestor,
        left,
        right,
      ),
      merged = new Map(ours);
    if (bases.length > 1) {
      for (const other of bases.slice(1)) {
        const files = (await this.files(other)).files;
        for (const path of new Set([...ancestor.keys(), ...files.keys()])) {
          const a = ancestor.get(path),
            b = files.get(path),
            x = left.get(path),
            y = right.get(path);
          if (
            (a?.sha !== b?.sha || a?.mode !== b?.mode) &&
            (x?.sha !== y?.sha || x?.mode !== y?.mode) &&
            !conflicts.some((c) => c.path === path)
          )
            conflicts.push({
              path,
              kind: "ambiguous_merge_base",
              base_shas: bases,
            });
        }
      }
    }
    const equal = (x: TreeEntry | undefined, y: TreeEntry | undefined) =>
      x?.sha === y?.sha && x?.mode === y?.mode;
    for (const path of [
      ...new Set([...original.keys(), ...ours.keys(), ...theirs.keys()]),
    ].sort()) {
      const o = original.get(path),
        a = ours.get(path),
        c = theirs.get(path);
      if (equal(a, c) || equal(o, c)) continue;
      if (equal(o, a)) {
        if (c) merged.set(path, c);
        else merged.delete(path);
        continue;
      }
      let conflict = true,
        content: string | undefined;
      if (
        a &&
        c &&
        o &&
        a.type === "blob" &&
        c.type === "blob" &&
        o.type === "blob" &&
        a.mode !== "120000" &&
        c.mode !== "120000"
      ) {
        const data = await Promise.all(
          [a, o, c].map((e) => this.store.get(e.sha)),
        );
        if (data.every((x) => !x.data.includes(0))) {
          const lines = data.map((x) => lineTokens(text(x.data)));
          if (
            lines.some((l) => l.length > 20000) ||
            lines[1].length * (lines[0].length + lines[2].length) > 8000000
          )
            fail(413, "Merge text budget exceeded");
          const parts = diff3Merge(lines[0], lines[1], lines[2], {
            excludeFalseConflicts: true,
          });
          conflict = parts.some((p) => !!p.conflict);
          content = parts
            .map((p) =>
              p.ok
                ? p.ok.join("")
                : `<<<<<<< ${b.target_branch}\n${p.conflict!.a.join("")}=======\n${p.conflict!.b.join("")}>>>>>>> ${b.source_ref || b.source_branch}\n`,
            )
            .join("");
          const mode =
            a.mode === c.mode
              ? a.mode
              : a.mode === o.mode
                ? c.mode
                : c.mode === o.mode
                  ? a.mode
                  : undefined;
          if (!mode) conflict = true;
          if (!conflict) {
            const blob = await this.store.create("blob", bytes(content));
            merged.set(path, { ...a, sha: blob.oid, mode: mode! });
          }
        }
      }
      if (conflict)
        conflicts.push({
          path,
          base: o?.sha || null,
          ours: a?.sha || null,
          theirs: c?.sha || null,
          ...(b.include_content
            ? {
                result: {
                  content: content?.slice(0, 65536) || null,
                  truncated: (content?.length || 0) > 65536,
                  binary: !content,
                },
              }
            : {}),
        });
    }
    // Git trees cannot contain both a file and descendants beneath that same path.
    for (const path of merged.keys()) {
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) {
        const parent = parts.slice(0, i).join("/");
        if (merged.has(parent) && !conflicts.some((c) => c.path === parent))
          conflicts.push({ path: parent, kind: "file_directory" });
      }
    }
    return {
      status: conflicts.length ? "conflicted" : "clean",
      result,
      source_branch: b.source_ref || b.source_branch,
      target_branch: b.target_branch,
      source_tip_sha: source,
      target_tip_sha: target,
      merge_base_sha: base || null,
      merge_base_shas: bases,
      conflict_paths: conflicts.map((c) => c.path),
      conflicts: b.include_content ? conflicts : [],
      filtered_conflicts: !b.include_content
        ? conflicts.map((c) => ({
            path: c.path,
            reason: "content_not_requested",
          }))
        : [],
      merged,
    };
  }
  async mergeBranches(b: any) {
    if (!["merge", "ff_only", "ff_prefer"].includes(b.strategy || "ff_prefer"))
      fail(400, "Invalid merge strategy");
    if (b.squash && b.strategy === "ff_only")
      fail(400, "Squash is incompatible with ff_only");
    const preview = await this.previewMerge(b);
    if (
      b.expected_target_sha !== undefined &&
      b.expected_target_sha !== preview.target_tip_sha
    )
      fail(409, "Target branch moved");
    if (preview.status === "conflicted")
      fail(409, "Merge conflicts: " + preview.conflict_paths.join(", "));
    if (preview.result === "no_op")
      return {
        sha: preview.target_tip_sha,
        commit_sha: preview.target_tip_sha,
        result: "no_op",
      };
    if (preview.result !== "fast_forward" && b.strategy === "ff_only")
      fail(409, "Merge is not fast-forward");
    let sha = preview.source_tip_sha,
      result = preview.result;
    if (
      b.squash ||
      preview.result === "merge_commit" ||
      b.strategy === "merge"
    ) {
      const tree = await this.buildTree(preview.merged),
        commit = await this.writeCommit(
          tree,
          b.squash
            ? [preview.target_tip_sha]
            : [preview.target_tip_sha, preview.source_tip_sha],
          b,
        );
      sha = commit.oid;
      result = b.squash ? "squash" : "merge_commit";
    }
    await this.publish({
      ...this.refs,
      ["refs/heads/" + b.target_branch]: sha,
    });
    return {
      sha,
      commit_sha: sha,
      result,
      ref_update: {
        branch: b.target_branch,
        old_sha: preview.target_tip_sha,
        new_sha: sha,
      },
    };
  }
  async blame(options: {
    ref?: string;
    path: string;
    range?: string[];
    detect_moves?: boolean;
  }) {
    this.path(options.path);
    const tip = await this.revision(options.ref || "HEAD"),
      memo = new Map<string, any[]>();
    let visits = 0;
    const annotate = async (sha: string, path: string): Promise<any[]> => {
      const key = sha + ":" + path;
      if (memo.has(key)) return memo.get(key)!;
      if (++visits > 1000) fail(413, "Blame history budget exceeded");
      const e = await this.maybeEntry(sha, path);
      if (!e || e.type !== "blob") return [];
      const data = (await this.store.get(e.sha)).data;

      const lines = lineTokens(text(data));
      if (lines.length > 20000) fail(413, "Blame line budget exceeded");
      const commit = await this.metadata(sha),
        out = lines.map((content, i) => ({
          line: i + 1,
          original_line: i + 1,
          content: content.replace(/\n$/, ""),
          sha,
          author: commit.author_name,
          author_email: commit.author_email,
          date: commit.date,
          committer_name: commit.committer_name,
          committer_email: commit.committer_email,
          committer_date: commit.date,
          summary: commit.message.split("\n")[0],
          previous_commit_sha: commit.parent_shas[0] || null,
          path,
        }));
      for (const parent of commit.parent_shas) {
        let parentPath = path,
          old = await this.maybeEntry(parent, path);
        if (!old && options.detect_moves !== false) {
          const candidate = [...(await this.files(parent)).files].find(
            ([, x]) => x.sha === e.sha,
          );
          if (candidate) {
            parentPath = candidate[0];
            old = candidate[1];
          }
        }
        if (options.detect_moves !== false) {
          const parentFiles = (await this.files(parent)).files;
          let compared = 0;
          for (const [candidate, entry] of parentFiles) {
            if (!out.some((l) => l.sha === sha)) break;
            if (entry.type !== "blob" || ++compared > 256) continue;
            const oldLines = lineTokens(
              text((await this.store.get(entry.sha)).data),
            ).map((l) => l.replace(/\n$/, ""));
            if (oldLines.length > 20000) continue;
            const positions = new Map<string, number[]>();
            for (let i = 0; i < oldLines.length; i++) {
              const value = oldLines[i];
              const list = positions.get(value) || [];
              if (list.length < 64) list.push(i);
              positions.set(value, list);
            }
            let prior: any[] | undefined;
            for (let j = 0; j < out.length; j++) {
              if (out[j].sha !== sha || !out[j].content.trim()) continue;
              let best = 0,
                where = -1;
              for (const i of positions.get(out[j].content) || []) {
                let n = 0,
                  score = 0;
                while (
                  j + n < out.length &&
                  i + n < oldLines.length &&
                  out[j + n].sha === sha &&
                  out[j + n].content === oldLines[i + n]
                ) {
                  score += out[j + n].content.replace(
                    /[^a-zA-Z0-9]/g,
                    "",
                  ).length;
                  n++;
                }
                if (score > (candidate === path ? 20 : 40) && n > best) {
                  best = n;
                  where = i;
                }
              }
              if (where < 0) continue;
              prior ||= await annotate(parent, candidate);
              for (let k = 0; k < best; k++)
                if (prior[where + k])
                  out[j + k] = {
                    ...prior[where + k],
                    line: j + k + 1,
                    content: out[j + k].content,
                  };
              j += best - 1;
            }
          }
        }
        if (!old || old.type !== "blob") continue;
        const previous = await annotate(parent, parentPath),
          previousText = previous.map((l) => l.content + "\n").join(""),
          oldData = text((await this.store.get(old.sha)).data),
          changes = diffLines(oldData, text(data), {
            timeout: 500,
            maxEditLength: 20000,
          });
        if (!changes) fail(413, "Blame diff budget exceeded");
        let i = 0,
          j = 0;
        for (const change of changes) {
          const n = change.count || 0;
          if (change.added) j += n;
          else if (change.removed) i += n;
          else {
            for (let k = 0; k < n; k++)
              if (out[j + k].sha === sha && previous[i + k])
                out[j + k] = {
                  ...previous[i + k],
                  line: j + k + 1,
                  content: out[j + k].content,
                };
            i += n;
            j += n;
          }
        }
      }
      memo.set(key, out);
      return out;
    };
    const lines = await annotate(tip, options.path);
    if (!lines.length && !(await this.maybeEntry(tip, options.path)))
      fail(404, "File not found");
    const selected = options.range?.length
      ? blameRanges(lines, options.range)
      : lines;
    return { ref: tip, path: options.path, lines: selected };
  }
}
