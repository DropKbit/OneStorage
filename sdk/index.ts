/** OneStorage TypeScript SDK. No runtime dependencies. */
import { createToken, Signer, Scope } from "./auth";
import {
  CommitBuilder,
  CommitOptions,
  CommitResult,
  Content,
  diffStream,
  streamNDJSON,
} from "./stream";
export * from "./auth";
export * from "./stream";
export interface Page {
  limit?: number;
  cursor?: string;
  ephemeral?: boolean;
}
export function query(options: object = {}) {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || value === null) continue;
    for (const v of Array.isArray(value) ? value : [value])
      q.append(key, String(v));
  }
  return q.size ? "?" + q.toString() : "";
}

export interface Project {
  id: string;
  namespace: string;
  name: string;
  description: string;
  visibility: "public" | "private";
  default_branch: string;
  clone_url?: string;
}
export class OneStorageError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "OneStorageError";
  }
}
export class OneStorage {
  private origin: string;
  constructor(
    private options: {
      origin: string;
      token?: string | (() => Promise<string>);
      signer?: Signer;
      fetch?: typeof fetch;
    },
  ) {
    this.origin = new URL(options.origin).origin;
  }
  async raw(
    path: string,
    method = "GET",
    body?: BodyInit | null,
    headers: HeadersInit = {},
    auth?: { repo?: string; scopes: Scope[] },
  ) {
    const token =
      typeof this.options.token === "function"
        ? await this.options.token()
        : this.options.token;
    let jwt = token;
    if (!jwt && this.options.signer) {
      if (!auth) throw Error("Explicit scope context required when signing");
      jwt = await createToken({ ...this.options.signer, ...auth });
    }
    const h = new Headers(headers);
    if (jwt) h.set("Authorization", "Bearer " + jwt);
    const init: RequestInit & { duplex?: string } = {
      method,
      body,
      headers: h,
      redirect: "manual",
    };
    if (body instanceof ReadableStream) init.duplex = "half";
    const response = await (this.options.fetch || fetch)(
      this.origin + "/api" + path,
      init,
    );
    if (!response.ok && response.status !== 304) {
      let error;
      try {
        error = ((await response.json()) as any).error;
      } catch {}
      throw new OneStorageError(response.status, error || response.statusText);
    }
    return response;
  }
  async request<T = any>(
    path: string,
    method = "GET",
    body?: unknown,
    auth?: { repo?: string; scopes: Scope[] },
  ): Promise<T> {
    const response = await this.raw(
      path,
      method,
      body === undefined ? undefined : JSON.stringify(body),
      body === undefined ? {} : { "Content-Type": "application/json" },
      auth,
    );
    return response.json() as Promise<T>;
  }
  async resolveRepo(id: string, repository?: string) {
    if (this.options.signer && !repository) {
      for await (const item of this.repositories())
        if (item.id === id) {
          repository = item.namespace + "/" + item.name;
          break;
        }
      if (!repository) throw new OneStorageError(404, "Repository not found");
    }
    return this.request<{
      id: string;
      url: string;
      ephemeral_url: string;
      import_url: string;
    }>("/repo-url/" + encodeURIComponent(id), "GET", undefined, {
      scopes: ["git:read"],
      repo: repository || id,
    });
  }
  async *repositories(options: { q?: string; limit?: number } = {}) {
    let cursor: string | undefined;
    do {
      const page = await this.request<any>(
        "/repos" + query({ ...options, cursor }),
        "GET",
        undefined,
        { scopes: ["org:read"] },
      );
      yield* page.repositories;
      cursor = page.next_cursor || undefined;
    } while (cursor);
  }
  async gitURL(
    namespace: string,
    name: string,
    options: {
      namespace?: "ephemeral" | "import";
      authenticated?: boolean;
      scopes?: Scope[];
    } = {},
  ) {
    const url = new URL(
      this.origin +
        "/" +
        encodeURIComponent(namespace) +
        "/" +
        encodeURIComponent(name) +
        (options.namespace ? "+" + options.namespace : "") +
        ".git",
    );
    if (options.authenticated) {
      const token = this.options.signer
        ? await createToken({
            ...this.options.signer,
            repo: namespace + "/" + name,
            scopes: options.scopes || ["git:read", "git:write"],
          })
        : typeof this.options.token === "function"
          ? await this.options.token()
          : this.options.token;
      if (!token) throw Error("Authentication is not configured");
      url.username = "x";
      url.password = token;
    }
    return url.href;
  }
  listRepos(query = "", page = 0) {
    return this.request<{ repositories: Project[]; page: number }>(
      `/repos?q=${encodeURIComponent(query)}&page=${page}`,
      "GET",
      undefined,
      { scopes: ["org:read"] },
    );
  }
  createRepo(input: {
    name?: string;
    id?: string;
    base_repo?: Record<string, unknown>;
    description?: string;
    visibility?: "private" | "public";
    default_branch?: string;
  }) {
    const name = input.name || input.id || crypto.randomUUID();
    return this.request<Project>(
      "/repos",
      "POST",
      { ...input, name },
      {
        scopes: input.base_repo?.id
          ? ["repo:write", "git:read"]
          : ["repo:write"],
        repo: this.options.signer?.issuer + "/" + name,
      },
    );
  }
  repo(namespace: string, name: string) {
    return new RepositoryClient(
      this,
      `/repos/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`,
      namespace + "/" + name,
    );
  }
}
export class RepositoryClient {
  constructor(
    private client: OneStorage,
    private path: string,
    readonly id: string,
  ) {}
  private request<T = any>(path: string, method = "GET", body?: unknown) {
    const operation = path.slice(this.path.length).split("?")[0];
    const scope: Scope =
      ["/git-credentials", "/upstream"].some((p) => operation.startsWith(p)) ||
      (!operation && method !== "GET")
        ? "repo:write"
        : method === "GET" || ["/grep", "/archive"].includes(operation)
          ? "git:read"
          : "git:write";
    return this.client.request<T>(path, method, body, {
      repo: this.id,
      scopes: [scope],
    });
  }
  update(options: {
    description?: string;
    visibility?: "private" | "public";
    default_branch?: string;
  }) {
    return this.request(this.path, "PATCH", options);
  }
  delete() {
    return this.request(this.path, "DELETE");
  }
  listBranches(options: Page = {}) {
    return this.request(this.path + "/branches" + query(options));
  }
  getBranch(branch: string, ephemeral = false) {
    return this.request(this.path + "/branch" + query({ branch, ephemeral }));
  }
  createBranch(options: {
    target_branch: string;
    base_branch?: string;
    base_ref?: string;
    base_is_ephemeral?: boolean;
    ephemeral?: boolean;
    expected_target_sha?: string | null;
  }) {
    return this.request(this.path + "/branches/create", "POST", options);
  }
  deleteBranch(
    branch: string,
    options: { ephemeral?: boolean; expected_sha?: string } = {},
  ) {
    return this.request(this.path + "/branches", "DELETE", {
      branch,
      ...options,
    });
  }
  listTags(options: Page = {}) {
    return this.request(this.path + "/tags" + query(options));
  }
  getTag(name: string, ephemeral = false) {
    return this.request(this.path + "/tag" + query({ name, ephemeral }));
  }
  createTag(name: string, ref = "HEAD", ephemeral = false) {
    return this.request(this.path + "/tags", "POST", { name, ref, ephemeral });
  }
  deleteTag(name: string, ephemeral = false) {
    return this.request(
      this.path + "/tags/" + encodeURIComponent(name) + query({ ephemeral }),
      "DELETE",
    );
  }
  listCommits(options: Page & { ref?: string; path?: string } = {}) {
    return this.request(this.path + "/commits" + query(options));
  }
  getCommit(ref = "HEAD", ephemeral = false) {
    return this.request(this.path + "/commit" + query({ ref, ephemeral }));
  }
  getDiff(
    options: {
      ref?: string;
      base?: string;
      path?: string[];
      ephemeral?: boolean;
    } = {},
  ) {
    return this.request(this.path + "/diff" + query(options));
  }
  diffBranches(source: string, target: string, options: Page = {}) {
    return this.request(
      this.path + "/branches/diff" + query({ source, target, ...options }),
    );
  }
  listFiles(
    options: Page & {
      ref?: string;
      path?: string;
      recursive?: boolean;
      metadata?: boolean;
    } = {},
  ) {
    const { metadata, ...q } = options;
    return this.request(
      this.path + (metadata ? "/files/metadata" : "/files") + query(q),
    );
  }
  getFile(
    path: string,
    options: {
      ref?: string;
      ephemeral?: boolean;
      headers?: HeadersInit;
      head?: boolean;
    } = {},
  ) {
    const { headers, head, ...q } = options;
    return this.client.raw(
      this.path + "/file" + query({ path, ...q }),
      head ? "HEAD" : "GET",
      undefined,
      headers,
      { repo: this.id, scopes: ["git:read"] },
    );
  }
  getArchive(options: Record<string, unknown> = {}) {
    return this.client.raw(
      this.path + "/archive",
      "POST",
      JSON.stringify(options),
      { "Content-Type": "application/json" },
      { repo: this.id, scopes: ["git:read"] },
    );
  }
  grep(options: {
    query: { pattern: string; case_sensitive?: boolean };
    [key: string]: unknown;
  }) {
    return this.request(this.path + "/grep", "POST", options);
  }
  blame(
    path: string,
    options: {
      ref?: string;
      range?: string[];
      detect_moves?: boolean;
      ephemeral?: boolean;
    } = {},
  ) {
    return this.request(this.path + "/blame" + query({ path, ...options }));
  }
  getNote(sha: string, notes_ref?: string, ephemeral = false) {
    return this.request(
      this.path + "/notes" + query({ sha, notes_ref, ephemeral }),
    );
  }
  listNotesRefs(options: Page & { prefix?: string } = {}) {
    return this.request(this.path + "/notes/refs" + query(options));
  }
  createNote(sha: string, note: string, options: Record<string, unknown> = {}) {
    return this.request(this.path + "/notes", "POST", {
      sha,
      note,
      ...options,
    });
  }
  appendNote(sha: string, note: string, options: Record<string, unknown> = {}) {
    return this.createNote(sha, note, { ...options, operation: "append" });
  }
  deleteNote(sha: string, options: Record<string, unknown> = {}) {
    return this.request(this.path + "/notes", "DELETE", { sha, ...options });
  }
  previewMerge(options: {
    source_ref?: string;
    source_branch?: string;
    target_branch: string;
    source_is_ephemeral?: boolean;
    target_is_ephemeral?: boolean;
    include_content?: boolean;
  }) {
    return this.request(this.path + "/merge/preview" + query(options));
  }
  mergeBranches(options: {
    source_ref?: string;
    source_branch?: string;
    target_branch: string;
    strategy?: "merge" | "ff_only" | "ff_prefer";
    squash?: boolean;
    expected_target_sha?: string;
    [key: string]: unknown;
  }) {
    return this.request(this.path + "/merge", "POST", options);
  }
  private async sendStream(
    endpoint: string,
    stream: ReadableStream<Uint8Array>,
  ) {
    const response = await this.client.raw(
      this.path + "/" + endpoint,
      "POST",
      stream,
      { "Content-Type": "application/x-ndjson" },
      { repo: this.id, scopes: ["git:write"] },
    );
    return response.json() as Promise<CommitResult>;
  }
  createCommit(options: CommitOptions) {
    return new CommitBuilder(options, (stream) =>
      this.sendStream("commit-pack", stream),
    );
  }
  createDiffCommit(options: CommitOptions, diff: Content) {
    return this.sendStream("diff-commit", diffStream(options, diff));
  }
  restoreCommit(options: CommitOptions & { base_ref: string }) {
    async function* lines() {
      yield { metadata: options };
    }
    return this.sendStream("restore-commit", streamNDJSON(lines()));
  }
  unsetBaseRepo() {
    return this.client.request(this.path + "/base", "DELETE", undefined, {
      repo: this.id,
      scopes: ["repo:write"],
    });
  }
  pullUpstream() {
    return this.request(this.path + "/pull-upstream", "POST", {});
  }
  syncStatus() {
    return this.request(this.path + "/sync-status");
  }
  configureUpstream(base: Record<string, unknown> | null) {
    return this.request(this.path + "/upstream", "PUT", base);
  }
  listGitCredentials() {
    return this.request(this.path + "/git-credentials");
  }
  createGitCredential(password: string, username?: string) {
    return this.request(this.path + "/git-credentials", "POST", {
      password,
      username,
    });
  }
  updateGitCredential(password: string, username?: string) {
    return this.request(this.path + "/git-credentials", "PUT", {
      password,
      username,
    });
  }
  deleteGitCredential(id: string) {
    return this.request(
      this.path + "/git-credentials/" + encodeURIComponent(id),
      "DELETE",
    );
  }
  createWebhook(url: string, events: string[] = ["*"]) {
    return this.request(this.path + "/webhooks", "POST", { url, events });
  }
  listWebhooks() {
    return this.request(this.path + "/webhooks");
  }
  deleteWebhook(id: string) {
    return this.request(
      this.path + "/webhooks/" + encodeURIComponent(id),
      "DELETE",
    );
  }
  get() {
    return this.request<Project>(this.path);
  }
  branches() {
    return this.request<{ branches: { name: string; sha: string }[] }>(
      this.path + "/branches",
    );
  }
  tree(ref = "HEAD", path = "") {
    return this.request<{
      ref: string;
      path: string;
      entries: { name: string; sha: string; type: string; mode: string }[];
    }>(
      this.path +
        `/tree?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}`,
    );
  }
  file(path: string, ref = "HEAD") {
    return this.request<{
      ref: string;
      path: string;
      content: string | null;
      binary: boolean;
      size: number;
    }>(
      this.path +
        `/blob?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}`,
    );
  }
  commit(input: {
    branch: string;
    expected_sha: string | null;
    message: string;
    files: { path: string; content: string | null }[];
  }) {
    return this.request<{ sha: string; branch: string }>(
      this.path + "/commit",
      "POST",
      input,
    );
  }
  search(query: string, ref = "HEAD") {
    return this.request<{
      matches: { path: string; line: number; text: string }[];
      truncated: boolean;
    }>(
      this.path +
        `/search?q=${encodeURIComponent(query)}&ref=${encodeURIComponent(ref)}`,
    );
  }
  createIssue(title: string, body = "") {
    return this.request<{ id: number }>(this.path + "/issues", "POST", {
      title,
      body,
    });
  }
  createMergeRequest(input: {
    title: string;
    body?: string;
    source: string;
    target: string;
  }) {
    return this.request<{ id: number }>(this.path + "/merges", "POST", input);
  }
  merge(id: number) {
    return this.request<{ sha: string }>(
      this.path + `/merges/${id}/merge`,
      "POST",
    );
  }
}
