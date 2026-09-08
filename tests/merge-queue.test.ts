import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support/review-fixture";
import { ForgeRepository } from "../src/git/forge";
import {
  advanceQueue,
  queueMutation,
  validateQueuePublication,
  type QueueEntry,
} from "../src/merge-queue";
import { projectMerge } from "../src/merge-issues";
import { protectRefs } from "../src/review";

async function setup() {
  const f = fixture();
  f.db.exec(
    "UPDATE branch_protections SET require_codeowners=0,require_queue=1; INSERT INTO credentials(hash,id,user_id,name,kind,expires_at) VALUES('credential','credential','o','test','session',9999999999999)",
  );
  const config = {
    runner: "worker",
    steps: [{ type: "file", path: "base.txt" }],
  };
  f.db
    .prepare("INSERT INTO ci_pipelines(repo_id,config) VALUES('r',?)")
    .run(JSON.stringify(config));
  const base = await f.commit({ "base.txt": "base" });
  const source = await f.commit(
    { "base.txt": "base", "feature.txt": "feature" },
    base,
  );
  f.mr(source, base);
  await f.store.flush();
  const state = new Map<string, any>();
  const storage = {
    get: async (k: string) => structuredClone(state.get(k)),
    put: async (k: string, v: any) => {
      state.set(k, structuredClone(v));
    },
    delete: async (k: string) => state.delete(k),
    setAlarm: async (n: number) => {
      state.set("alarm", n);
    },
  } as unknown as DurableObjectStorage;
  const git = new ForgeRepository(
    f.store,
    storage,
    { "refs/heads/main": base, "refs/heads/feature": source },
    "main",
    { rules: [] },
  );
  const entry = (id = 1) =>
    f.db
      .prepare("SELECT * FROM merge_queue WHERE id=?")
      .get(id) as unknown as QueueEntry;
  const enqueue = (id = 1, extra = {}) =>
    queueMutation(f.env, storage, f.repo, git, "enqueue", {
      id,
      actor_id: "o",
      credential: "credential",
      revision: 0,
      strategy: "merge",
      ...extra,
    });
  const published: string[] = [];
  const tick = () =>
    advanceQueue(f.env, storage, f.repo, git, async (e, m) => {
      await validateQueuePublication(f.env, f.repo, git, e, m);
      await protectRefs(
        f.env,
        f.repo,
        f.store,
        git.refs,
        { ...git.refs, "refs/heads/main": e.candidate_sha! },
        { ...m, queue_entry: e },
      );
      await git.publish({ ...git.refs, "refs/heads/main": e.candidate_sha! });
      published.push(e.candidate_sha!);
      await projectMerge(f.env, "r", m.id, {
        sha: e.candidate_sha!,
        actor_id: "o",
        queue_id: e.id,
      });
    });
  const succeed = (id = 1) =>
    f.db
      .prepare("UPDATE ci_runs SET status='succeeded' WHERE id=?")
      .run(entry(id).run_id);
  return {
    ...f,
    git,
    base,
    source,
    storage,
    state,
    entry,
    enqueue,
    tick,
    succeed,
    published,
  };
}
test("merge queue runs CI against an unpublished candidate and publishes exactly that SHA once", async () => {
  const f = await setup();
  await f.enqueue();
  await f.enqueue();
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM merge_queue").get()!.n,
    1,
  );
  await f.tick();
  const sha = f.entry().candidate_sha!;
  assert.notEqual(sha, f.source);
  assert.equal(f.git.refs["refs/heads/main"], f.base);
  assert.equal(f.state.has("refs.v2"), false);
  await f.git.entry(sha, "feature.txt");
  await f.git.entry(sha, "base.txt");
  await f.tick();
  const ci = f.db
    .prepare("SELECT * FROM ci_runs WHERE id=?")
    .get(f.entry().run_id)!;
  assert.equal(ci.sha, sha);
  assert.equal(ci.trigger, "merge_request");
  assert.equal(ci.source_trigger, "merge_request");
  await f.tick();
  assert.equal(f.published.length, 0);
  f.succeed();
  await f.tick();
  await f.tick();
  assert.deepEqual(f.published, [sha]);
  assert.equal(f.entry().state, "merged");
  assert.equal(f.git.refs["refs/heads/main"], sha);
  assert.equal(f.state.has("merge-queue"), false);
  await projectMerge(f.env, "r", 1, { sha, queue_id: 1 });
  assert.equal(
    f.db
      .prepare(
        "SELECT count(*) AS n FROM audit WHERE action='merge_queue.merged'",
      )
      .get()!.n,
    1,
  );
});
test("FIFO waits on failed head; cancel frees the next entry, which refreshes the target and requires new approvals", async () => {
  const f = await setup();
  const second = await f.commit(
    { "base.txt": "base", "second.txt": "second" },
    f.base,
  );
  await f.store.flush();
  f.git.refs["refs/heads/second"] = second;
  f.db
    .prepare(
      "INSERT INTO merge_requests(id,repo_id,author_id,title,body,source,target,source_sha,target_sha) VALUES(2,'r','a','second','','second','main',?,?)",
    )
    .run(second, f.base);
  await f.enqueue();
  await f.enqueue(2);
  await f.tick();
  await f.tick();
  f.db
    .prepare("UPDATE ci_runs SET status='failed' WHERE id=?")
    .run(f.entry().run_id);
  await f.tick();
  await f.tick();
  assert.equal(f.entry().state, "blocked");
  assert.equal(f.entry(2).candidate_sha, null);
  await queueMutation(f.env, f.storage, f.repo, f.git, "cancel", {
    id: 1,
    actor_id: "o",
    credential: "credential",
  });
  const advanced = await f.commit(
    { "base.txt": "base", "advance.txt": "advance" },
    f.base,
  );
  await f.store.flush();
  f.git.refs["refs/heads/main"] = advanced;
  f.db.exec("UPDATE branch_protections SET approvals=1");
  f.db
    .prepare(
      "INSERT INTO merge_reviews(mr_id,user_id,source_sha,target_sha,verdict) VALUES(2,'d',?,?,'approve')",
    )
    .run(second, f.base);
  await f.tick();
  assert.equal(f.entry(2).generation, 1);
  assert.equal(f.entry(2).mr_revision, 1);
  assert.equal(f.entry(2).target_sha, advanced);
  await f.tick();
  assert.equal(f.entry(2).state, "blocked");
  assert.equal(f.entry(2).candidate_sha, null);
  f.db
    .prepare(
      "INSERT INTO merge_reviews(mr_id,user_id,source_sha,target_sha,verdict) VALUES(2,'d',?,?,'approve')",
    )
    .run(second, advanced);
  await f.tick();
  await f.tick();
  f.succeed(2);
  await f.tick();
  assert.equal(f.entry(2).state, "merged");
  await f.git.entry(f.entry(2).merged_sha!, "advance.txt");
  await f.git.entry(f.entry(2).merged_sha!, "second.txt");
});
test("configuration refresh cancels old candidate CI and malformed target JSON blocks visibly", async () => {
  const f = await setup();
  await f.enqueue();
  await f.tick();
  await f.tick();
  const old = f.entry().run_id;
  f.db.exec("UPDATE ci_pipelines SET config='{' ");
  await f.tick();
  assert.equal(f.entry().generation, 1);
  assert.equal(
    f.db.prepare("SELECT status FROM ci_runs WHERE id=?").get(old)!.status,
    "canceled",
  );
  await f.tick();
  await f.tick();
  assert.equal(f.entry().state, "blocked");
  assert.match(f.entry().reason, /configuration is invalid/);
});
test("moved source, closed request, expiration and revoked repository role cancel queue intent", async () => {
  for (const change of ["source", "closed", "expiry", "role"]) {
    const f = await setup();
    if (change === "role") {
      f.db.exec(
        "INSERT INTO members VALUES('r','g','maintainer');UPDATE credentials SET user_id='g'",
      );
    }
    await f.enqueue(1, change === "role" ? { actor_id: "g" } : {});
    if (change === "source") f.git.refs["refs/heads/feature"] = f.base;
    if (change === "closed")
      f.db.exec("UPDATE merge_requests SET state='closed'");
    if (change === "expiry") f.db.exec("UPDATE merge_queue SET expires_at=1");
    if (change === "role") f.db.exec("DELETE FROM members WHERE user_id='g'");
    await f.tick();
    assert.equal(f.entry().state, "canceled", change);
    assert.equal(f.published.length, 0);
  }
});
test("account and lifecycle SQL triggers cancel even an unlinked candidate run; post-revocation CI insertion fails", async () => {
  for (const mutation of [
    "UPDATE users SET auth_epoch=auth_epoch+1 WHERE id='o'",
    "UPDATE repositories SET archived_at=datetime('now') WHERE id='r'",
  ]) {
    const f = await setup();
    await f.enqueue();
    await f.tick();
    await f.tick();
    const run = f.entry().run_id;
    f.db.exec("UPDATE merge_queue SET run_id=NULL");
    f.db.exec(mutation);
    assert.equal(f.entry().state, "canceled");
    assert.equal(
      f.db.prepare("SELECT status FROM ci_runs WHERE id=?").get(run)!.status,
      "canceled",
    );
    assert.throws(
      () =>
        f.db
          .prepare(
            "INSERT INTO ci_runs(id,repo_id,event_id,ref,sha,config,trigger,actor_id,source_trigger) VALUES('late','r','merge-queue:1:0','merge/1',?,'{}','merge_request','o','merge_request')",
          )
          .run(f.entry().candidate_sha),
      /authority changed/,
    );
  }
});
test("queue recovers a CI insert whose D1 response was lost without creating duplicate runs", async () => {
  const f = await setup();
  await f.enqueue();
  await f.tick();
  const original = f.env.DB.prepare.bind(f.env.DB);
  let injected = false;
  f.env.DB.prepare = ((sql: string) => {
    const s = original(sql);
    if (sql.startsWith("INSERT OR IGNORE INTO ci_runs")) {
      const run = s.run.bind(s);
      (s as any).run = async () => {
        const result = await run();
        if (!injected) {
          injected = true;
          throw Error("lost D1 response");
        }
        return result;
      };
    }
    return s;
  }) as any;
  await assert.rejects(f.tick(), /lost D1 response/);
  assert.equal(f.entry().run_id, null);
  await f.tick();
  assert.ok(f.entry().run_id);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM ci_runs").get()!.n, 1);
  f.succeed();
  await f.tick();
  assert.equal(f.entry().state, "merged");
});
test("mandatory queue rejects direct push and ordinary reviewed merge; candidate gate rejects another source pipeline", async () => {
  const f = await setup();
  await assert.rejects(
    protectRefs(f.env, f.repo, f.store, f.git.refs, {
      ...f.git.refs,
      "refs/heads/main": f.source,
    }),
    /reviewed merge/,
  );
  await assert.rejects(
    protectRefs(
      f.env,
      f.repo,
      f.store,
      f.git.refs,
      { ...f.git.refs, "refs/heads/main": f.source },
      f.mr(f.source, f.base),
    ),
    /merge queue/,
  );
  await f.enqueue();
  await f.tick();
  await f.tick();
  f.db
    .prepare(
      "INSERT INTO ci_runs(id,repo_id,ref,sha,config,trigger,actor_id,status) VALUES('source','r','feature',?,'{}','manual','o','succeeded')",
    )
    .run(f.source);
  await assert.rejects(
    validateQueuePublication(
      f.env,
      f.repo,
      f.git,
      f.entry(),
      f.mr(f.source, f.base),
    ),
    /pipeline must succeed/,
  );
  await f.tick();
  assert.equal(f.published.length, 0);
});

test("queue loads pipeline from the target snapshot despite source changes to that file", async () => {
  const f = await setup();
  const target = await f.commit(
    {
      "base.txt": "base",
      "pipeline.json": JSON.stringify({
        runner: "worker",
        steps: [{ type: "file", path: "base.txt" }],
      }),
    },
    f.base,
  );
  const source = await f.commit(
    { "base.txt": "base", "pipeline.json": "not valid JSON" },
    target,
  );
  await f.store.flush();
  f.git.refs["refs/heads/main"] = target;
  f.git.refs["refs/heads/feature"] = source;
  f.mr(source, target);
  f.db.exec(
    "UPDATE ci_pipelines SET source_path='pipeline.json', config='null'",
  );
  await f.enqueue();
  await f.tick();
  await f.tick();
  const run = f.db
    .prepare("SELECT * FROM ci_runs WHERE id=?")
    .get(f.entry().run_id)!;
  assert.equal(run.config_sha, target);
  assert.equal(run.config_path, "pipeline.json");
  assert.equal(JSON.parse(String(run.config)).steps[0].path, "base.txt");
});

test("candidate change after completed CI requires another run; final role loss prevents publication", async () => {
  const f = await setup();
  f.db.exec(
    "INSERT INTO members VALUES('r','g','maintainer'); UPDATE credentials SET user_id='g'",
  );
  await f.enqueue(1, { actor_id: "g" });
  await f.tick();
  await f.tick();
  f.succeed();
  const old = f.entry().run_id;
  const target = await f.commit(
    { "base.txt": "base", "new.txt": "target" },
    f.base,
  );
  await f.store.flush();
  f.git.refs["refs/heads/main"] = target;
  await f.tick();
  await f.tick();
  await f.tick();
  assert.notEqual(f.entry().run_id, old);
  assert.equal(f.published.length, 0);
  f.succeed();
  f.db.exec("DELETE FROM members WHERE user_id='g'");
  await assert.rejects(
    validateQueuePublication(
      f.env,
      f.repo,
      f.git,
      f.entry(),
      f.db.prepare("SELECT * FROM merge_requests WHERE id=1").get(),
    ),
    /authorization/,
  );
  await f.tick();
  assert.equal(f.entry().state, "canceled");
  assert.equal(f.published.length, 0);
});

test("ff-only conflict is blocked, squash has one parent, and no-op still completes queue projection", async () => {
  for (const mode of ["ff_only", "squash", "no_op"]) {
    const f = await setup();
    if (mode === "ff_only") {
      const target = await f.commit(
        { "base.txt": "base", "diverged.txt": "target" },
        f.base,
      );
      await f.store.flush();
      f.git.refs["refs/heads/main"] = target;
      f.mr(f.source, target);
    }
    if (mode === "no_op") {
      f.git.refs["refs/heads/feature"] = f.base;
      f.mr(f.base, f.base);
    }
    await f.enqueue(1, {
      strategy: mode === "ff_only" ? "ff_only" : "ff_prefer",
      squash: mode === "squash",
    });
    await f.tick();
    if (mode === "ff_only") {
      assert.equal(f.entry().state, "blocked");
      assert.equal(f.entry().candidate_sha, null);
      continue;
    }
    if (mode === "squash") {
      const { parseCommit } = await import("../src/git/objects");
      assert.deepEqual(
        parseCommit(await f.store.get(f.entry().candidate_sha!)).parents,
        [f.base],
      );
    }
    await f.tick();
    f.succeed();
    await f.tick();
    assert.equal(f.entry().state, "merged");
    if (mode === "no_op") assert.equal(f.entry().merged_sha, f.base);
  }
});
