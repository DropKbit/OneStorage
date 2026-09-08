import { fail } from "./security";
// Each wrapper belongs to one request. Never change the shared Worker environment/binding.
const snapshots = new WeakMap<
  object,
  Array<{ id: string; revision: number }>
>();
const originals = new WeakMap<object, D1Database>();
const statements = new WeakMap<
  object,
  { native: D1PreparedStatement; read: boolean }
>();
export const unguardDatabase = (db: D1Database) => originals.get(db) || db;
/** Keep the namespace authorization snapshot valid through the D1 write transaction. */
export function projectDatabase(
  db: D1Database,
  repoId: string,
  revision: number,
): D1Database {
  const native = unguardDatabase(db);
  const required = [...(snapshots.get(db) || []), { id: repoId, revision }];
  if (required.length > 8)
    fail(400, "Too many project authorization snapshots");
  const guard = async <T>(
    input: D1PreparedStatement[],
  ): Promise<D1Result<T>[]> => {
    const id = crypto.randomUUID();
    try {
      const result = await native.batch<T>([
        native
          .prepare(
            "INSERT INTO mutation_guards(id,accepted) SELECT ?,CASE WHEN NOT EXISTS(SELECT 1 FROM json_each(?) j WHERE NOT EXISTS(SELECT 1 FROM repositories r WHERE r.id=json_extract(j.value,'$.id') AND r.lifecycle_revision=json_extract(j.value,'$.revision') AND r.deleted_at IS NULL)) THEN 1 ELSE 0 END",
          )
          .bind(id, JSON.stringify(required)),
        ...input.map((s) => statements.get(s)?.native || s),
        native.prepare("DELETE FROM mutation_guards WHERE id=?").bind(id),
      ]);
      return result.slice(1, -1);
    } catch (error) {
      // Preserve other business CHECK errors (issue CAS etc.) if our snapshot remains current.
      if (
        error instanceof Error &&
        /CHECK constraint failed/.test(error.message)
      ) {
        for (const snapshot of required) {
          const current = await native
            .prepare(
              "SELECT lifecycle_revision FROM repositories WHERE id=? AND deleted_at IS NULL",
            )
            .bind(snapshot.id)
            .first<{ lifecycle_revision: number }>();
          if (!current || current.lifecycle_revision !== snapshot.revision)
            fail(
              409,
              "Project moved or lifecycle changed; reload before writing",
            );
        }
      }
      throw error;
    }
  };
  const wrap = (
    query: string,
    prepared: D1PreparedStatement,
  ): D1PreparedStatement => {
    // Only literal SELECTs bypass the write barrier; WITH/PRAGMA/unknown commands are guarded.
    const read = /^\s*SELECT\b/i.test(query);
    const run = async <T>() => (await guard<T>([prepared]))[0];
    const result = {
      bind: (...values: unknown[]) => wrap(query, prepared.bind(...values)),
      run: <T>() => (read ? prepared.run<T>() : run<T>()),
      all: <T>() => (read ? prepared.all<T>() : run<T>()),
      first: async <T>(column?: string) => {
        if (read)
          return column === undefined
            ? prepared.first<T>()
            : prepared.first<T>(column);
        const rows = (await run<Record<string, unknown>>()).results;
        if (!rows.length) return null;
        if (column === undefined) return rows[0] as T;
        if (!Object.hasOwn(rows[0], column)) throw Error("D1 column not found");
        return rows[0][column] as T;
      },
      raw: async () => {
        throw Error("Project-scoped raw queries are unsupported; use all()");
      },
    } as D1PreparedStatement;
    statements.set(result, { native: prepared, read });
    return result;
  };
  const result = {
    prepare: (query: string) => wrap(query, native.prepare(query)),
    batch: <T>(input: D1PreparedStatement[]) =>
      input.every((s) => statements.get(s)?.read)
        ? native.batch<T>(input.map((s) => statements.get(s)!.native))
        : guard<T>(input),
    exec: async () => {
      throw Error(
        "Project-scoped exec is unsupported; use prepared statements",
      );
    },
    dump: async () => {
      throw Error("Project-scoped dump is unsupported");
    },
    withSession: () => {
      throw Error("Project-scoped sessions are unsupported");
    },
  } as unknown as D1Database;
  originals.set(result, native);
  snapshots.set(result, required);
  return result;
}
