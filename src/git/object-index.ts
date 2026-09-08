import { fail } from "../security";
import {
  LIMITS,
  parseCommit,
  parseTree,
  parseTag,
  type GitObject,
  type ObjectType,
} from "./objects";
export type ObjectEdge = { oid: string; type: ObjectType };
export function objectEdges(object: GitObject): ObjectEdge[] {
  if (object.type === "commit") {
    const commit = parseCommit(object);
    return [
      { oid: commit.tree, type: "tree" },
      ...commit.parents.map((oid) => ({ oid, type: "commit" as const })),
    ];
  }
  if (object.type === "tree")
    return parseTree(object.data)
      .filter((e) => e.mode !== "160000")
      .map((e) => ({ oid: e.sha, type: e.type }));
  return object.type === "tag" ? [parseTag(object)] : [];
}
export interface IndexedObject {
  type: ObjectType;
  size: number;
}
/** A per-DO integrity index. Presence is never an authorization or reachability grant. */
export class GitObjectIndex {
  private sql: SqlStorage;
  constructor(
    readonly repoId: string,
    private storage: Pick<DurableObjectStorage, "sql" | "transactionSync">,
  ) {
    this.sql = storage.sql;
    this.sql
      .exec(`CREATE TABLE IF NOT EXISTS git_index_owner_v1(id INTEGER PRIMARY KEY CHECK(id=1),repo_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS git_walk_excluded_v1(oid TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS git_objects_v1(oid TEXT PRIMARY KEY,type TEXT NOT NULL,size INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS git_edges_v1(parent TEXT NOT NULL,position INTEGER NOT NULL,child TEXT NOT NULL,type TEXT NOT NULL,PRIMARY KEY(parent,position));`);
    this.sql.exec(
      "INSERT OR IGNORE INTO git_index_owner_v1(id,repo_id) VALUES(1,?)",
      repoId,
    );
    if (
      this.sql
        .exec<{ repo_id: string }>(
          "SELECT repo_id FROM git_index_owner_v1 WHERE id=1",
        )
        .one().repo_id !== repoId
    )
      fail(409, "Git object index belongs to another repository");
  }
  get(oid: string): IndexedObject | undefined {
    return this.sql
      .exec<{ type: ObjectType; size: number }>(
        "SELECT type,size FROM git_objects_v1 WHERE oid=?",
        oid,
      )
      .toArray()[0];
  }
  private put(oid: string, value: IndexedObject, edges: ObjectEdge[]) {
    // Children already have verified, durable closures. Store all edges and the parent marker atomically.
    this.storage.transactionSync(() => {
      for (let start = 0; start < edges.length; start += 256)
        this.sql.exec(
          "INSERT INTO git_edges_v1(parent,position,child,type) SELECT ?,CAST(key AS INTEGER)+?,json_extract(value,'$.oid'),json_extract(value,'$.type') FROM json_each(?)",
          oid,
          start,
          JSON.stringify(edges.slice(start, start + 256)),
        );
      this.sql.exec(
        "INSERT INTO git_objects_v1(oid,type,size) VALUES(?,?,?)",
        oid,
        value.type,
        value.size,
      );
    });
  }
  async ensure(roots: string[], load: (oid: string) => Promise<GitObject>) {
    type Frame = {
      oid: string;
      type?: ObjectType;
      value?: IndexedObject;
      edges?: ObjectEdge[];
      offset?: number;
    };
    const todo: Frame[] = roots.map((oid) => ({ oid })),
      active = new Set<string>();
    let visited = 0;
    while (todo.length) {
      const frame = todo[todo.length - 1];
      if (!frame.value) {
        const known = this.get(frame.oid);
        if (known) {
          if (frame.type && known.type !== frame.type)
            fail(400, "Git object graph type mismatch");
          todo.pop();
          continue;
        }
        if (active.has(frame.oid)) fail(400, "Cyclic Git object graph");
        if (++visited > LIMITS.transferGraph)
          fail(413, "Git index validation budget exceeded");
        const object = await load(frame.oid);
        if (frame.type && object.type !== frame.type)
          fail(400, "Git object graph type mismatch");
        frame.value = { type: object.type, size: object.data.length };
        frame.edges = objectEdges(object);
        frame.offset = 0;
        active.add(frame.oid);
      }
      if (frame.offset! < frame.edges!.length) {
        todo.push({ ...frame.edges![frame.offset!++] });
        continue;
      }
      this.put(frame.oid, frame.value, frame.edges!);
      active.delete(frame.oid);
      todo.pop();
    }
  }
  walk(roots: string[], exclude: Set<string>) {
    if (!roots.length) return new Set<string>();
    // The recursive UNION deduplicates in SQLite, without retaining object payloads in JavaScript.
    const encoded = JSON.stringify([...exclude]);
    const query = (scratch: boolean) =>
      this.sql
        .exec<{ oid: string }>(
          `WITH RECURSIVE excluded(oid) AS (${scratch ? "SELECT oid FROM git_walk_excluded_v1" : "SELECT value FROM json_each(?)"}), reachable(oid) AS (
      SELECT value FROM json_each(?) WHERE value NOT IN excluded
      UNION SELECT e.child FROM git_edges_v1 e JOIN reachable r ON e.parent=r.oid WHERE e.child NOT IN excluded
    ) SELECT oid FROM reachable LIMIT ?`,
          ...(scratch ? [] : [encoded]),
          JSON.stringify(roots),
          LIMITS.transferGraph + 1,
        )
        .toArray();
    const rows =
      encoded.length <= 1024 * 1024
        ? query(false)
        : this.storage.transactionSync(() => {
            this.sql.exec("DELETE FROM git_walk_excluded_v1");
            const values = [...exclude];
            for (let i = 0; i < values.length; i += 256)
              this.sql.exec(
                "INSERT INTO git_walk_excluded_v1 SELECT value FROM json_each(?)",
                JSON.stringify(values.slice(i, i + 256)),
              );
            const result = query(true);
            this.sql.exec("DELETE FROM git_walk_excluded_v1");
            return result;
          });
    if (rows.length > LIMITS.transferGraph)
      fail(413, "Fetch graph exceeds operation budget");
    return new Set(rows.map((r) => r.oid));
  }
}
