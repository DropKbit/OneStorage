/** OneStorage TypeScript SDK. No dependencies; works in Workers, Node 22+ and browsers. */
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
    private options: { origin: string; token: string; fetch?: typeof fetch },
  ) {
    this.origin = new URL(options.origin).origin;
  }
  async request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const response = await (this.options.fetch || fetch)(
      this.origin + "/api" + path,
      {
        method,
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
      },
    );
    const data = (await response.json()) as T & { error?: string };
    if (!response.ok)
      throw new OneStorageError(
        response.status,
        data.error || response.statusText,
      );
    return data;
  }
  listRepos(query = "", page = 0) {
    return this.request<{ repositories: Project[]; page: number }>(
      `/repos?q=${encodeURIComponent(query)}&page=${page}`,
    );
  }
  createRepo(input: {
    name: string;
    description?: string;
    visibility?: "private" | "public";
    default_branch?: string;
  }) {
    return this.request<Project>("/repos", "POST", input);
  }
  repo(namespace: string, name: string) {
    return new RepositoryClient(
      this,
      `/repos/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`,
    );
  }
}
export class RepositoryClient {
  constructor(
    private client: OneStorage,
    private path: string,
  ) {}
  get() {
    return this.client.request<Project>(this.path);
  }
  branches() {
    return this.client.request<{ branches: { name: string; sha: string }[] }>(
      this.path + "/branches",
    );
  }
  tree(ref = "HEAD", path = "") {
    return this.client.request<{
      ref: string;
      path: string;
      entries: { name: string; sha: string; type: string; mode: string }[];
    }>(
      this.path +
        `/tree?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}`,
    );
  }
  file(path: string, ref = "HEAD") {
    return this.client.request<{
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
    return this.client.request<{ sha: string; branch: string }>(
      this.path + "/commit",
      "POST",
      input,
    );
  }
  search(query: string, ref = "HEAD") {
    return this.client.request<{
      matches: { path: string; line: number; text: string }[];
      truncated: boolean;
    }>(
      this.path +
        `/search?q=${encodeURIComponent(query)}&ref=${encodeURIComponent(ref)}`,
    );
  }
  createIssue(title: string, body = "") {
    return this.client.request<{ id: number }>(this.path + "/issues", "POST", {
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
    return this.client.request<{ id: number }>(
      this.path + "/merges",
      "POST",
      input,
    );
  }
  merge(id: number) {
    return this.client.request<{ sha: string }>(
      this.path + `/merges/${id}/merge`,
      "POST",
    );
  }
}
