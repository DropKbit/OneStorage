import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import {
  ObjectStore,
  bytes,
  treeBytes,
  type TreeEntry,
} from "../../src/git/objects";
import type { Env, Repo } from "../../src/types";
export function fixture() {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync("migrations").sort())
    db.exec(readFileSync("migrations/" + f, "utf8"));
  db.exec(
    "INSERT INTO users(id,username,password) VALUES('o','owner','x'),('a','author','x'),('d','dev','x'),('g','guest','x');INSERT INTO repositories(id,owner_id,namespace,name,visibility) VALUES('r','o','owner','repo','private'),('other','o','owner','other','private');INSERT INTO members VALUES('r','a','developer'),('r','d','developer');INSERT INTO merge_requests(id,repo_id,author_id,title,body,source,target,source_sha,target_sha) VALUES(1,'r','a','MR','','feature','main','src','dst');INSERT INTO branch_protections(repo_id,branch,require_mr,approvals,require_ci,require_codeowners) VALUES('r','main',1,0,0,1)",
  );
  const DB = {
    prepare(sql: string) {
      let values: any[] = [];
      return {
        bind(...v: any[]) {
          values = v;
          return this;
        },
        async first() {
          return db.prepare(sql).get(...values) || null;
        },
        async all() {
          return { results: db.prepare(sql).all(...values) };
        },
        async run() {
          return { meta: db.prepare(sql).run(...values) };
        },
      };
    },
    async batch(statements: any[]) {
      db.exec("BEGIN");
      try {
        const result = [];
        for (const s of statements) result.push(await s.run());
        db.exec("COMMIT");
        return result;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
  const objects = new Map<string, Uint8Array>();
  const bucket = {
    async get(key: string) {
      const data = objects.get(key);
      return data
        ? { size: data.length, arrayBuffer: async () => data.slice().buffer }
        : null;
    },
    async put(key: string, data: Uint8Array) {
      if (objects.has(key)) return null;
      objects.set(key, data);
      return {};
    },
  };
  const env = { DB, OBJECTS: bucket } as unknown as Env;
  const store = new ObjectStore("r", bucket as any);
  const repo = db
    .prepare("SELECT * FROM repositories WHERE id='r'")
    .get() as unknown as Repo;
  async function commit(
    files: Record<string, string>,
    parent?: string,
    message = "Change",
  ) {
    async function tree(prefix: string): Promise<string> {
      const names = new Set(
        Object.keys(files)
          .filter((k) => k.startsWith(prefix))
          .map((k) => k.slice(prefix.length).split("/")[0]),
      );
      const entries: TreeEntry[] = [];
      for (const name of names) {
        const path = prefix + name,
          directory = !Object.hasOwn(files, path);
        const sha = directory
          ? await tree(path + "/")
          : (await store.create("blob", bytes(files[path]))).oid;
        entries.push({
          name,
          mode: directory ? "40000" : "100644",
          type: directory ? "tree" : "blob",
          sha,
        });
      }
      return (await store.create("tree", treeBytes(entries))).oid;
    }
    return (
      await store.create(
        "commit",
        bytes(
          `tree ${await tree("")}\n${parent ? "parent " + parent + "\n" : ""}author A <a@b> 1 +0000\ncommitter A <a@b> 1 +0000\n\n${message}`,
        ),
      )
    ).oid;
  }
  function mr(source: string, target: string, body = "") {
    db.prepare(
      "UPDATE merge_requests SET source_sha=?,target_sha=?,body=? WHERE id=1",
    ).run(source, target, body);
    return db.prepare("SELECT * FROM merge_requests WHERE id=1").get() as any;
  }
  function approve(
    source: string,
    target: string,
    user = "d",
    verdict = "approve",
  ) {
    db.prepare(
      "INSERT INTO merge_reviews(mr_id,user_id,source_sha,target_sha,verdict) VALUES(1,?,?,?,?)",
    ).run(user, source, target, verdict);
  }
  return { db, env, repo, store, objects, bucket, commit, mr, approve };
}
