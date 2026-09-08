import { LIMITS, type GitObject } from "./objects";
import { fail } from "../security";

export interface PrefetchOptions {
  size?: (oid: string) => number | undefined;
  observe?: (bytes: number, objects: number) => void;
}

/** Ordered, demand-driven lookahead. Reservations include the object currently yielded. */
export async function* prefetchObjects(
  ids: readonly string[],
  load: (oid: string) => Promise<GitObject>,
  options: PrefetchOptions = {},
): AsyncGenerator<GitObject> {
  type Result = { ok: true; object: GitObject } | { ok: false; error: unknown };
  const queue: { bytes: number; result: Promise<Result> }[] = [];
  let next = 0,
    reserved = 0,
    failed = false,
    failure: unknown;
  const fill = () => {
    while (!failed && next < ids.length && queue.length < 4) {
      const oid = ids[next],
        expected = options.size?.(oid),
        size = expected ?? LIMITS.object;
      if (!Number.isSafeInteger(size) || size < 0 || size > LIMITS.object)
        fail(409, "Invalid indexed Git object size");
      if (reserved + size > LIMITS.cacheBytes) break;
      next++;
      reserved += size;
      // Attach both handlers immediately: later failures must not become unhandled rejections.
      const result: Promise<Result> = Promise.resolve()
        .then(async () => {
          const object = await load(oid);
          if (
            object.oid !== oid ||
            object.data.length > LIMITS.object ||
            (expected !== undefined && object.data.length !== expected)
          )
            fail(409, "Git object differs from verified index");
          return object;
        })
        .then(
          (object) => ({ ok: true as const, object }),
          (error) => {
            failed = true;
            failure = error;
            return { ok: false as const, error };
          },
        );
      queue.push({ bytes: size, result });
      options.observe?.(reserved, queue.length);
    }
  };
  try {
    fill();
    while (queue.length) {
      const entry = queue[0],
        result = await entry.result;
      if (!result.ok) throw result.error;
      if (failed) throw failure;
      yield result.object;
      queue.shift();
      reserved -= entry.bytes;
      fill();
    }
  } finally {
    // A canceled/failed response cannot release the repository barrier while reads still mutate caches.
    await Promise.all(queue.map((entry) => entry.result));
    queue.length = 0;
  }
}
