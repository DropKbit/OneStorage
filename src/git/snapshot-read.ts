import { HTTPException } from "hono/http-exception";
import { ObjectStore, type GitObject } from "./objects";
import type { ObjectCache } from "./object-cache";
import type { ForgeRepository } from "./forge";
import { fail } from "../security";
import { streamResponse } from "./pack-stream";
import type { BrowseCache } from "./browse-cache";

const paths = new Set([
  "/browse",
  "/branches",
  "/branch",
  "/tree",
  "/blob",
  "/resolve",
  "/commits",
  "/commit-detail",
  "/tags",
  "/tag",
  "/file",
]);
function readRoute(request: Request) {
  return (
    (request.method === "GET" ||
      (request.method === "HEAD" &&
        new URL(request.url).pathname === "/file")) &&
    paths.has(new URL(request.url).pathname)
  );
}
export function snapshotRead(request: Request) {
  return readRoute(request) && request.headers.get("x-mutation") !== "1";
}
export function shareableOperation(request: Request) {
  const path = new URL(request.url).pathname;
  return (
    snapshotRead(request) ||
    (request.method === "POST" &&
      ["/git/git-upload-pack", "/git/git-receive-pack"].includes(path)) ||
    (request.method === "GET" && path === "/git/info/refs")
  );
}

/** This is an internal scheduling signal, never an HTTP rejection or a new data limit. */
export class SnapshotBudget extends Error {}
export const SNAPSHOT_LIMITS = {
  object: 256 * 1024,
  served: 1024 * 1024,
  calls: 64,
  response: 2 * 1024 * 1024,
};
// DO instances may share an isolate. Permit at most one additional snapshot response across them.
let active = false;
export function acquireSnapshot() {
  if (active) return;
  active = true;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      active = false;
    }
  };
}

/** No ref publication, pack-cache access or shared SQL index mutation is possible on this path. */
export class SnapshotStore extends ObjectStore {
  private calls = 0;
  private served = 0;
  private reserved = 0;
  private closed = false;
  private reads = new Set<Promise<GitObject>>();
  constructor(repo: string, bucket: R2Bucket, shared?: ObjectCache) {
    super(
      repo,
      {
        get: async (key: string) => {
          const result = await bucket.get(key);
          if (result && result.size > SNAPSHOT_LIMITS.object + 64) {
            await result.body?.cancel();
            throw new SnapshotBudget();
          }
          return result;
        },
        put: async () => {
          throw new Error("Snapshot attempted object publication");
        },
      } as Pick<R2Bucket, "get" | "put">,
      shared && {
        get: (repo, oid) => shared.get(repo, oid, SNAPSHOT_LIMITS.object),
        put: (repo, object) => shared.put(repo, object),
      },
    );
  }
  override get(oid: string): Promise<GitObject> {
    if (
      this.closed ||
      ++this.calls > SNAPSHOT_LIMITS.calls ||
      this.served + this.reserved + SNAPSHOT_LIMITS.object >
        SNAPSHOT_LIMITS.served
    )
      return Promise.reject(new SnapshotBudget());
    this.reserved += SNAPSHOT_LIMITS.object;
    const result = super
      .get(oid)
      .then((object) => {
        if (object.data.length > SNAPSHOT_LIMITS.object)
          throw new SnapshotBudget();
        this.served += object.data.length;
        return object;
      })
      .finally(() => {
        this.reserved -= SNAPSHOT_LIMITS.object;
        this.reads.delete(result);
      });
    this.reads.add(result);
    return result;
  }
  async close() {
    this.closed = true;
    while (this.reads.size) await Promise.allSettled([...this.reads]);
  }
}

/** Shared by serial and snapshot requests to keep status, pagination and file conditions identical. */
export async function repositoryRead(
  repo: ForgeRepository,
  request: Request,
  defaultBranch: string,
  cache?: BrowseCache,
) {
  if (!readRoute(request)) return;
  const url = new URL(request.url),
    q = Object.fromEntries(url.searchParams),
    path = url.pathname,
    ref = q.ref || "HEAD",
    file = q.path || "",
    page = { limit: q.limit, cursor: q.cursor };
  switch (path) {
    case "/resolve":
      return Response.json({ sha: await repo.resolve(ref) });
    case "/file":
      return repo.rawFile(request, ref, file);
    case "/commit-detail":
      return Response.json({ commit: await repo.metadata(q.sha || ref) });
    case "/branches":
      return Response.json(repo.listBranches(page));
    case "/tree":
      return Response.json(await repo.tree(ref, file));
    case "/blob":
      return Response.json(await repo.blob(ref, file));
    case "/commits":
      return Response.json(
        await repo.listCommits({ ...page, ref, path: q.path }),
      );
    case "/tags":
      return Response.json(await repo.listTags(page));
    case "/tag": {
      const tag = (await repo.listTags({ limit: 1000 })).tags.find(
        (t) => t.name === (q.name || q.tag),
      );
      if (!tag) fail(404, "Tag not found");
      return Response.json(tag);
    }
    case "/branch": {
      const name = q.branch || q.name || defaultBranch,
        sha = repo.refs["refs/heads/" + name];
      if (!sha) fail(404, "Branch not found");
      return Response.json({ name, sha });
    }
    case "/browse": {
      const started = performance.now();
      const timing = (state: string) => ({
        "Server-Timing": `browse;dur=${(performance.now() - started).toFixed(1)};desc="${state}", r2_reads;desc="${repo.store.ioUsage.r2Reads}"`,
      });
      const branches = repo.listBranches({ limit: 256 }).branches;
      if (!branches.length)
        return Response.json({
          branches,
          default_branch: defaultBranch,
          data: null,
          readme: null,
        });
      const branch = q.ref || defaultBranch,
        blob = q.view === "blob";
      const target = !blob && !file ? cache?.target(repo, branch) : undefined;
      const cached = target ? await cache?.get(repo, target) : undefined;
      if (cached)
        return Response.json(
          { branches, default_branch: defaultBranch, ...cached },
          {
            headers: timing("persistent-hit"),
          },
        );
      const data = blob
        ? await repo.blob(branch, file)
        : await repo.tree(branch, file);
      let readme = null;
      if (
        !blob &&
        !file &&
        "entries" in data &&
        data.entries.some((e) => e.name === "README.md" && e.type === "blob")
      ) {
        try {
          readme = await repo.blob(data.ref, "README.md");
        } catch (error) {
          if (!(error instanceof HTTPException) || error.status !== 413)
            throw error;
        }
      }
      if (target && "entries" in data)
        await cache?.put(repo, target, { data, readme });
      return Response.json(
        {
          branches,
          default_branch: defaultBranch,
          data,
          readme,
        },
        {
          headers: timing(target ? "persistent-miss" : "uncached"),
        },
      );
    }
  }
}

export async function snapshotResponse(response: Response) {
  if (!response.body) return response;
  const data = new Uint8Array(await response.arrayBuffer());
  if (data.length > SNAPSHOT_LIMITS.response) throw new SnapshotBudget();
  async function* body() {
    yield data;
  }
  const headers = new Headers(response.headers);
  headers.set("X-OneStorage-Read-Mode", "snapshot");
  return streamResponse(body(), headers, 20000, response.status);
}
