import { DurableObject } from "cloudflare:workers";
import { HTTPException } from "hono/http-exception";
import type { Env } from "./types";
import { boundedBody, fail, branch } from "./security";
import { ObjectStore, Refs, LIMITS, text } from "./git/objects";
import { GitRepository } from "./git/repository";
import { advertise, receive, upload } from "./git/protocol";
import { importSnapshot } from "./git/legacy";
/** The per-repository DO serializes requests; immutable R2 objects precede atomic ref publication. */
export class Repository extends DurableObject<Env> {
  private tail: Promise<unknown> = Promise.resolve();
  private waiting = 0;
  async fetch(request: Request): Promise<Response> {
    if (this.waiting >= 16)
      return Response.json(
        { error: "Repository busy; retry shortly" },
        { status: 429 },
      );
    this.waiting++;
    const result = this.tail.then(() => this.handle(request));
    this.tail = result.catch(() => undefined);
    try {
      return await result;
    } catch (e) {
      if (e instanceof HTTPException)
        return Response.json({ error: e.message }, { status: e.status });
      console.error(
        "Git transaction failed",
        e instanceof Error ? e.name : "unknown",
      );
      return Response.json(
        { error: "Git transaction failed; inspect refs before retrying" },
        { status: 503 },
      );
    } finally {
      this.waiting--;
    }
  }
  private async handle(request: Request) {
    const id = request.headers.get("x-repo-id") || "";
    if (!/^[0-9a-f-]{36}$/.test(id)) fail(400, "Invalid repository");
    const defaultBranch = branch.parse(
      request.headers.get("x-default-branch") || "main",
    );
    const url = new URL(request.url),
      store = new ObjectStore(id, this.env.OBJECTS);
    let refs = await this.ctx.storage.get<Refs>("refs.v2");
    if (!refs) {
      const legacy = await this.ctx.storage.get<string>("snapshot");
      if (legacy) {
        const snapshot = await this.env.OBJECTS.get(legacy);
        if (!snapshot) fail(503, "Legacy snapshot missing; restore backup");
        if (snapshot.size > 24 * 1024 * 1024)
          fail(413, "Legacy snapshot exceeds migration limit");
        refs = await importSnapshot(
          new Uint8Array(await snapshot.arrayBuffer()),
          store,
          this.ctx.storage,
        );
      } else refs = {};
    }
    const repo = new GitRepository(
        store,
        this.ctx.storage,
        refs,
        defaultBranch,
      ),
      path = url.pathname;
    if (path === "/git/info/refs" && request.method === "GET") {
      const service = url.searchParams.get("service") || "";
      if (!["git-upload-pack", "git-receive-pack"].includes(service))
        fail(400, "Unsupported Git service");
      return advertise(
        repo,
        service,
        (request.headers.get("git-protocol") || "")
          .split(":")
          .includes("version=2"),
      );
    }
    if (path === "/git/git-receive-pack" && request.method === "POST")
      return receive(repo, await boundedBody(request, LIMITS.pack));
    if (path === "/git/git-upload-pack" && request.method === "POST")
      return upload(repo, await boundedBody(request, 1024 * 1024));
    if (request.method === "GET") {
      const ref = url.searchParams.get("ref") || "HEAD",
        file = url.searchParams.get("path") || "";
      switch (path) {
        case "/branches":
          return Response.json({
            branches: Object.entries(refs)
              .filter(([name]) => name.startsWith("refs/heads/"))
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([name, sha]) => ({ name: name.slice(11), sha })),
          });
        case "/tree":
          return Response.json(await repo.tree(ref, file));
        case "/blob":
          return Response.json(await repo.blob(ref, file));
        case "/commits":
          return Response.json(await repo.commits(ref));
        case "/search":
          return Response.json(
            await repo.search(ref, url.searchParams.get("q") || ""),
          );
        case "/compare":
          return Response.json(
            await repo.compare(
              url.searchParams.get("source") || "",
              url.searchParams.get("target") || "",
            ),
          );
      }
    }
    if (request.method === "POST" && ["/commit", "/merge"].includes(path)) {
      let body;
      try {
        body = JSON.parse(text(await boundedBody(request, 2 * 1024 * 1024)));
      } catch (e) {
        if (e instanceof HTTPException) throw e;
        fail(400, "Invalid JSON");
      }
      if (path === "/commit")
        return Response.json(await repo.commit(body), { status: 201 });
      return Response.json(await repo.merge(body));
    }
    fail(404, "Git endpoint not found");
  }
}
