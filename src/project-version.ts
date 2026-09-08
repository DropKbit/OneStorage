import type { Env } from "./types";
import { fail } from "./security";
/** D1 owns the version. The DO cache is invalidated durably before changing it. */
async function refreshVersion(
  env: Env,
  storage: DurableObjectStorage,
  id: string,
) {
  const row = await env.DB.prepare(
    "SELECT lifecycle_revision FROM repositories WHERE id=? AND deleted_at IS NULL",
  )
    .bind(id)
    .first<{ lifecycle_revision: number }>();
  if (!row) fail(404, "Repository not found");
  if (!Number.isSafeInteger(row.lifecycle_revision))
    fail(503, "Project version unavailable");
  await storage.put("project-version", row.lifecycle_revision);
  await storage.delete("project-transition");
  return row.lifecycle_revision;
}
export async function projectVersion(
  env: Env,
  storage: DurableObjectStorage,
  id: string,
) {
  const [version, pending] = await Promise.all([
    storage.get<number>("project-version"),
    storage.get("project-transition"),
  ]);
  if (pending || version === undefined) return refreshVersion(env, storage, id);
  return version;
}
/** A failure after D1 commits leaves a durable marker, so the next request recovers before serving Git content. */
export async function withProjectTransition<T>(
  env: Env,
  storage: DurableObjectStorage,
  id: string,
  operation: () => Promise<T>,
) {
  await storage.put("project-transition", true);
  try {
    return await operation();
  } finally {
    await refreshVersion(env, storage, id);
  }
}

export async function checkProjectVersion(
  env: Env,
  storage: DurableObjectStorage,
  id: string,
  request: Request,
) {
  const version = await projectVersion(env, storage, id);
  if (
    request.headers.has("x-lifecycle-revision") &&
    request.headers.get("x-lifecycle-revision") !== String(version)
  )
    fail(
      409,
      "Project moved or lifecycle changed; reload before reading or writing",
    );
}
