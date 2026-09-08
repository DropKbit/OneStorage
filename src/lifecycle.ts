import { githubLFS, uploadLFS, downloadLFS } from "./lfs-sync";
import { upstreamURL, upstreamSchema } from "./sync-config";
import type { Env, Repo } from "./types";
import { fail, branch, boundedBody, digest } from "./security";
import { ObjectStore, Refs, canonical, checkRefs, text } from "./git/objects";
import type { ForgeRepository } from "./git/forge";
/** Called only inside the repository's serialized request queue. */
export async function lifecycle(
  request: Request,
  repo: ForgeRepository,
  env: Env,
  storage: DurableObjectStorage,
): Promise<Response | undefined> {
  const path = new URL(request.url).pathname,
    id = repo.store.repoId;
  if (path === "/internal/delete" && request.method === "POST") {
    // A durable tombstone rejects already-authorized in-flight requests too.
    await storage.put("deleted", id);
    await storage.setAlarm(Date.now() + 60000);
    await env.DB.prepare(
      "UPDATE repositories SET deleted_at=datetime('now'),name=? WHERE id=?",
    )
      .bind("deleted_" + id, id)
      .run();
    return Response.json({ deleted: true, cleanup: "scheduled" });
  }
  if (await storage.get("deleted")) fail(404, "Repository deleted");
  if (path === "/internal/configure-upstream" && request.method === "POST") {
    const raw = await request.json();
    const base = raw === null ? null : upstreamSchema.parse(raw);
    if (base) upstreamURL(base, env.SYNC_ALLOWED_HOSTS);
    if (await storage.get("sync-reconcile"))
      fail(409, "Reconcile the upstream outcome before changing configuration");
    await env.DB.prepare(
      "UPDATE repositories SET base_repo=?,sync_status='idle',sync_error=NULL,synced_at=NULL WHERE id=?",
    )
      .bind(base ? JSON.stringify(base) : null, id)
      .run();
    await env.DB.prepare(
      "UPDATE sync_jobs SET status='cancelled' WHERE repo_id=? AND status='pending'",
    )
      .bind(id)
      .run();
    return Response.json({ upstream: base });
  }
  if (path === "/internal/default-branch" && request.method === "POST") {
    const body = (await request.json()) as { default_branch: string };
    const name = branch.parse(body.default_branch);
    if (Object.keys(repo.refs).length && !repo.refs["refs/heads/" + name])
      fail(409, "Default branch must exist");
    // The DO value is authoritative for Git HEAD. Persist before the D1 metadata projection.
    await storage.put("default-branch", name);
    await env.DB.prepare(
      "UPDATE repositories SET default_branch=? WHERE id=? AND deleted_at IS NULL",
    )
      .bind(name, id)
      .run();
    return Response.json({ default_branch: name });
  }
  if (path === "/internal/fork-initialize" && request.method === "POST") {
    // Hold the destination's serialized queue while the source copies objects.
    // A concurrent destination delete cannot finish GC before late fork writes.
    const b = (await request.json()) as {
      source: string;
      ref?: string;
      default_branch: string;
    };
    const target = await env.DB.prepare(
      "SELECT * FROM repositories WHERE id=? AND sync_status='initializing' AND deleted_at IS NULL",
    )
      .bind(id)
      .first<Repo>();
    if (!target || target.fork_source !== b.source || b.source === id)
      fail(409, "Invalid fork reservation");
    const source = await env.DB.prepare(
      "SELECT * FROM repositories WHERE id=? AND deleted_at IS NULL",
    )
      .bind(b.source)
      .first<Repo>();
    if (!source || source.sync_status === "initializing")
      fail(409, "Fork source unavailable");
    const response = await env.REPOSITORIES.get(
      env.REPOSITORIES.idFromName(b.source),
    ).fetch(
      new Request("https://repository/internal/fork-export", {
        method: "POST",
        headers: {
          "x-repo-id": b.source,
          "x-default-branch": source.default_branch,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          destination: id,
          ref: b.ref,
          default_branch: b.default_branch,
        }),
      }),
    );
    if (!response.ok) {
      await response.body?.cancel();
      fail(response.status < 500 ? 409 : 503, "Fork source export failed");
    }
    const exported = (await response.json()) as { refs: Refs };
    return lifecycle(
      new Request("https://repository/internal/fork-install", {
        method: "POST",
        body: JSON.stringify(exported),
      }),
      repo,
      env,
      storage,
    );
  }
  if (path === "/internal/fork-export" && request.method === "POST") {
    const body = (await request.json()) as {
      destination: string;
      ref?: string;
      default_branch: string;
    };
    if (!/^[0-9a-f-]{36}$/.test(body.destination) || body.destination === id)
      fail(400, "Invalid fork target");
    const destination = await env.DB.prepare(
      "SELECT * FROM repositories WHERE id=? AND sync_status='initializing' AND deleted_at IS NULL",
    )
      .bind(body.destination)
      .first<Repo>();
    if (!destination || destination.fork_source !== id)
      fail(409, "Fork target is not reserved");
    const sha = await repo.resolve(body.ref || "HEAD");
    const refs: Refs = body.ref
      ? {}
      : Object.fromEntries(
          Object.entries(repo.refs).filter(([r]) =>
            /^refs\/(heads|tags)\//.test(r),
          ),
        );
    refs["refs/heads/" + branch.parse(body.default_branch)] = sha;
    checkRefs(refs);
    const reachable = await repo.store.walk(Object.values(refs));
    const target = new ObjectStore(body.destination, env.OBJECTS);
    for (const oid of reachable) target.add(await repo.store.get(oid));
    await target.flush();
    // Copy only LFS objects referenced by reachable pointer blobs, not unrelated uploads.
    for (const oid of reachable) {
      const obj = await repo.store.get(oid);
      if (obj.type !== "blob" || obj.data.length > 1024) continue;
      const pointer = text(obj.data).match(
        /^version https:\/\/git-lfs.github.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize (\d+)\n?$/,
      );
      if (!pointer) continue;
      const lfs = await env.OBJECTS.get(`lfs/${id}/${pointer[1]}`);
      if (lfs)
        await env.OBJECTS.put(
          `lfs/${body.destination}/${pointer[1]}`,
          lfs.body,
          { onlyIf: { etagDoesNotMatch: "*" } },
        );
    }
    return Response.json({ refs, sha });
  }
  if (path === "/internal/fork-install" && request.method === "POST") {
    if (Object.keys(repo.refs).length) fail(409, "Fork target is not empty");
    const body = (await request.json()) as { refs: Refs };
    checkRefs(body.refs);
    if (Object.keys(body.refs).some((r) => !/^refs\/(heads|tags)\//.test(r)))
      fail(400, "Invalid fork refs");
    await repo.store.walk(Object.values(body.refs));
    await repo.publish(body.refs);
    await env.DB.prepare(
      "UPDATE repositories SET sync_status='idle' WHERE id=?",
    )
      .bind(id)
      .run();
    return Response.json({ ok: true });
  }
  if (
    path.startsWith("/internal/lfs/") &&
    ["PUT", "GET"].includes(request.method)
  ) {
    const oid = path.slice("/internal/lfs/".length);
    if (!/^[0-9a-f]{64}$/.test(oid)) fail(400, "Invalid LFS oid");
    const metadata = await env.DB.prepare(
      "SELECT * FROM repositories WHERE id=? AND deleted_at IS NULL",
    )
      .bind(id)
      .first<Repo>();
    if (!metadata) fail(404, "Repository deleted");
    if (metadata.base_repo && !githubLFS(metadata))
      fail(409, "LFS is unavailable for generic or public GitHub sync");
    if (request.method === "GET") {
      const existing = await env.OBJECTS.get(`lfs/${id}/${oid}`);
      if (existing)
        return new Response(existing.body, {
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(existing.size),
          },
        });
      if (!githubLFS(metadata)) fail(404, "LFS object missing");
      const size = Number(new URL(request.url).searchParams.get("size"));
      if (!Number.isSafeInteger(size) || size < 0 || size > 16 * 1024 * 1024)
        fail(400, "Missing or invalid LFS size");
      const data = await downloadLFS(env, metadata, oid, size);
      await env.OBJECTS.put(`lfs/${id}/${oid}`, data);
      return new Response(data as BodyInit, {
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(size),
        },
      });
    }
    const data = await boundedBody(request, 16 * 1024 * 1024);
    if ((await digest(data)) !== oid) fail(400, "LFS SHA-256 mismatch");
    if (
      githubLFS(metadata) &&
      request.headers.get("x-namespace") !== "ephemeral"
    )
      await uploadLFS(env, metadata, oid, data);
    await env.OBJECTS.put(`lfs/${id}/${oid}`, data);
    return Response.json({ ok: true });
  }
}
/** Retriable incremental garbage collection. Keep the tombstone permanently. */
export async function collectDeleted(env: Env, storage: DurableObjectStorage) {
  const id = await storage.get<string>("deleted");
  if (!id) return;
  // Retry the metadata retirement if the original D1 update was interrupted.
  await env.DB.prepare(
    "UPDATE repositories SET deleted_at=COALESCE(deleted_at,datetime('now')),name=? WHERE id=?",
  )
    .bind("deleted_" + id, id)
    .run();
  for (const prefix of [`repos/${id}/`, `lfs/${id}/`, `ci/${id}/`]) {
    const page = await env.OBJECTS.list({ prefix, limit: 100 });
    if (page.objects.length) {
      await env.OBJECTS.delete(page.objects.map((o) => o.key));
      await storage.setAlarm(Date.now() + 1000);
      return;
    }
  }
  await env.DB.prepare(
    "DELETE FROM repositories WHERE id=? AND deleted_at IS NOT NULL",
  )
    .bind(id)
    .run();
  await storage.delete(["refs.v2", "snapshot", "default-branch"]);
}
