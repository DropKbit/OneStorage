import { activeRepo, contributionSource, familySQL } from "./fork-reviews";
import { enqueueRun, pipelineSchema } from "./ci";
import type { Hono, Context } from "hono";
import type { App, Repo } from "./types";
import { z } from "zod";
import { branch, sha, fail, slug } from "./security";
import { jsonInput, identity } from "./workspaces";
import { repositoryRole, roleRank } from "./access";
import { reviewGate } from "./review";
interface Helpers {
  access(c: Context<App>, level?: "read" | "write" | "maintain"): Promise<Repo>;
  engine(
    c: Context<App>,
    r: Repo,
    path: string,
    payload?: unknown,
  ): Promise<any>;
  audit(
    c: Context<App>,
    action: string,
    id: string,
    detail?: string,
  ): Promise<void>;
}
export function registerCollaboration(app: Hono<App>, h: Helpers) {
  const base = "/api/repos/:namespace/:repo";
  const access = async (
    c: Context<App>,
    level: "read" | "write" | "maintain" = "read",
  ) => {
    if (c.get("delegation"))
      fail(403, "Git delegation cannot manage collaboration");
    if (level !== "read") identity(c);
    return h.access(c, level);
  };
  const mrFor = async (
    c: Context<App>,
    level: "read" | "write" | "maintain" = "read",
  ) => {
    const repo = await access(c, level);
    const mr = await c.env.DB.prepare(
      "SELECT m.*,u.username AS author FROM merge_requests m JOIN users u ON u.id=m.author_id WHERE m.repo_id=? AND m.id=?",
    )
      .bind(repo.id, c.req.param("id"))
      .first<any>();
    if (!mr) fail(404, "Merge request not found");
    return { repo, mr };
  };
  const currentForkSHA = async (c: Context<App>, mr: any) => {
    const source = await activeRepo(c.env, mr.source_repo_id);
    if (!source)
      fail(409, "Source fork unavailable; the reviewed snapshot is retained");
    const tip = await h.engine(
      c,
      source,
      "/resolve?ref=" + encodeURIComponent("refs/heads/" + mr.source),
    );
    return tip.sha;
  };
  const snapshotFor = async (
    c: Context<App>,
    target: Repo,
    sourceBranch: string,
    targetBranch: string,
    sourceId?: string | null,
    refresh = false,
  ) => {
    const user = identity(c),
      source = sourceId ? await activeRepo(c.env, sourceId) : target;
    if (!source) fail(404, "Source repository not found");
    if (source.id === target.id) {
      if (roleRank[await repositoryRole(c.env, target, user)] < 2)
        fail(403, "Write access required");
    } else await contributionSource(c.env, target, source, user, refresh);
    if (source.id === target.id && sourceBranch === targetBranch)
      fail(400, "Select different branches");
    const [left, right] = await Promise.all([
      h.engine(
        c,
        source,
        "/resolve?ref=" + encodeURIComponent("refs/heads/" + sourceBranch),
      ),
      h.engine(
        c,
        target,
        "/resolve?ref=" + encodeURIComponent("refs/heads/" + targetBranch),
      ),
    ]);
    if (source.id !== target.id)
      await h.engine(c, target, "/internal/merge-import", {
        source_id: source.id,
        source_sha: left.sha,
        actor_id: user.id,
        refresh,
      });
    return { source, source_sha: left.sha, target_sha: right.sha };
  };
  app.get(base + "/merge-sources", async (c) => {
    const target = await access(c),
      user = identity(c);
    const rows = await c.env.DB.prepare(
      familySQL +
        " SELECT r.id,r.namespace,r.name,r.default_branch,r.visibility FROM repositories r JOIN family f ON f.id=r.id WHERE r.deleted_at IS NULL AND r.sync_status!='initializing' AND ((r.workspace_id IS NULL AND r.owner_id=?) OR EXISTS(SELECT 1 FROM members m WHERE m.repo_id=r.id AND m.user_id=? AND m.role IN('developer','maintainer','owner')) OR EXISTS(SELECT 1 FROM workspace_members w WHERE w.workspace_id=r.workspace_id AND w.user_id=? AND w.role IN('developer','maintainer','owner'))) ORDER BY r.namespace,r.name LIMIT 100",
    )
      .bind(target.id, user.id, user.id, user.id)
      .all();
    return c.json({ repositories: rows.results });
  });
  app.post(base + "/merges", async (c) => {
    const target = await access(c),
      user = identity(c),
      b = z
        .object({
          title: z.string().trim().min(1).max(240),
          body: z.string().max(20000).default(""),
          source: branch,
          target: branch,
          source_repo: z.string().min(1).max(260).optional(),
        })
        .parse(await jsonInput(c));
    const source = b.source_repo
      ? await c.env.DB.prepare(
          "SELECT * FROM repositories WHERE deleted_at IS NULL AND (id=? OR namespace||'/'||name=?)",
        )
          .bind(b.source_repo, b.source_repo)
          .first<Repo>()
      : target;
    if (!source) fail(404, "Source repository not found");
    const snapshot = await snapshotFor(
      c,
      target,
      b.source,
      b.target,
      source.id,
    );
    const mr = await c.env.DB.prepare(
      "INSERT INTO merge_requests(repo_id,author_id,title,body,source,target,source_sha,target_sha,source_repo_id,source_namespace,source_name) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM repositories WHERE id=? AND deleted_at IS NULL) RETURNING *",
    )
      .bind(
        target.id,
        user.id,
        b.title,
        b.body,
        b.source,
        b.target,
        snapshot.source_sha,
        snapshot.target_sha,
        source.id === target.id ? null : source.id,
        source.namespace,
        source.name,
        target.id,
      )
      .first();
    if (!mr) fail(409, "Target repository changed");
    await h.audit(c, "merge_request.create", target.id, b.title);
    return c.json(mr, 201);
  });
  const discussionPage = async (
    c: Context<App>,
    mrId: number,
    cursor: string | undefined,
  ) => {
    const after = Number(cursor || 0);
    if (!Number.isSafeInteger(after) || after < 0)
      fail(400, "Invalid discussion cursor");
    const rows = await c.env.DB.prepare(
      "SELECT d.rowid AS cursor,d.*,u.username AS author,(SELECT COUNT(*) FROM merge_discussion_comments WHERE discussion_id=d.id) AS comments_count FROM merge_discussions d JOIN users u ON u.id=d.author_id WHERE d.mr_id=? AND d.rowid>? ORDER BY d.rowid LIMIT 100",
    )
      .bind(mrId, after)
      .all<any>();
    return {
      discussions: rows.results,
      next: rows.results.length === 100 ? rows.results.at(-1).cursor : null,
    };
  };
  app.get(base + "/protections", async (c) => {
    const r = await access(c);
    return c.json({
      rules: (
        await c.env.DB.prepare(
          "SELECT * FROM branch_protections WHERE repo_id=? ORDER BY branch",
        )
          .bind(r.id)
          .all()
      ).results,
    });
  });
  app.put(base + "/protections", async (c) => {
    const r = await access(c, "maintain"),
      b = z
        .object({
          branch,
          require_mr: z.boolean().default(true),
          approvals: z.number().int().min(0).max(10).default(1),
          require_ci: z.boolean().default(false),
          require_resolved: z.boolean().default(false),
        })
        .parse(await jsonInput(c));
    await c.env.DB.prepare(
      "INSERT INTO branch_protections(repo_id,branch,require_mr,approvals,require_ci,require_resolved) VALUES(?,?,?,?,?,?) ON CONFLICT(repo_id,branch) DO UPDATE SET require_mr=excluded.require_mr,approvals=excluded.approvals,require_ci=excluded.require_ci,require_resolved=excluded.require_resolved",
    )
      .bind(
        r.id,
        b.branch,
        +b.require_mr,
        b.approvals,
        +b.require_ci,
        +b.require_resolved,
      )
      .run();
    await h.audit(c, "protection.update", r.id, b.branch);
    return c.json({ ok: true });
  });
  app.delete(base + "/protections", async (c) => {
    const r = await access(c, "maintain"),
      b = z.object({ branch }).parse(await jsonInput(c));
    await c.env.DB.prepare(
      "DELETE FROM branch_protections WHERE repo_id=? AND branch=?",
    )
      .bind(r.id, b.branch)
      .run();
    await h.audit(c, "protection.delete", r.id, b.branch);
    return c.json({ ok: true });
  });
  app.get(base + "/merges/:id", async (c) => {
    const { repo, mr } = await mrFor(c);
    const [comparison, gate, discussions] = await Promise.all([
      h.engine(
        c,
        repo,
        `/compare?source=${mr.source_sha}&target=${mr.target_sha}`,
      ),
      reviewGate(c.env, repo, mr),
      discussionPage(c, mr.id, c.req.query("discussions_after")),
    ]);
    let stale = false;
    try {
      const sourceRepo = mr.source_repo_id
        ? await activeRepo(c.env, mr.source_repo_id)
        : repo;
      if (!sourceRepo) throw Error("Source unavailable");
      const [source, target] = await Promise.all([
        h.engine(
          c,
          sourceRepo,
          "/resolve?ref=" + encodeURIComponent("refs/heads/" + mr.source),
        ),
        h.engine(
          c,
          repo,
          "/resolve?ref=" + encodeURIComponent("refs/heads/" + mr.target),
        ),
      ]);
      stale = source.sha !== mr.source_sha || target.sha !== mr.target_sha;
    } catch {
      stale = true;
    }
    return c.json({
      ...mr,
      diff: comparison.diff,
      discussions: discussions.discussions,
      discussions_next: discussions.next,
      gate: { ...gate, allowed: gate.allowed && !stale },
      stale,
    });
  });
  app.post(base + "/merges/:id/reviews", async (c) => {
    const { repo, mr } = await mrFor(c, "read"),
      user = identity(c),
      b = z
        .object({
          verdict: z.enum(["approve", "changes", "comment"]),
          body: z.string().max(20000).default(""),
          source_sha: sha,
          target_sha: sha,
        })
        .parse(await jsonInput(c));
    const row = await h.engine(c, repo, "/review-submit", {
      ...b,
      id: mr.id,
      actor_id: user.id,
    });
    await h.audit(c, "merge_request.review", repo.id, String(mr.id));
    return c.json(row, 201);
  });
  app.patch(base + "/merges/:id", async (c) => {
    const { repo, mr } = await mrFor(c, "read"),
      u = identity(c);
    if (u.id !== mr.author_id && roleRank[c.get("repoRole")] < 3)
      fail(403, "Author or maintainer required");
    if (mr.state === "merged") fail(409, "Already merged");
    const b = z
      .object({
        state: z.enum(["open", "closed"]).optional(),
        refresh: z.boolean().optional(),
        revision: z.number().int().min(0).optional(),
        title: z.string().trim().min(1).max(240).optional(),
        body: z.string().max(20000).optional(),
      })
      .parse(await jsonInput(c));
    let source = mr.source_sha,
      target = mr.target_sha;
    if (b.refresh) {
      const snapshot = await snapshotFor(
        c,
        repo,
        mr.source,
        mr.target,
        mr.source_repo_id,
        true,
      );
      source = snapshot.source_sha;
      target = snapshot.target_sha;
    }
    await h.engine(c, repo, "/review-update", {
      id: mr.id,
      actor_id: u.id,
      ...b,
      revision: b.revision ?? mr.revision,
      source_sha: source,
      target_sha: target,
    });
    await h.audit(c, "merge_request.update", repo.id, String(mr.id));
    return c.json({ ok: true });
  });
  app.post(base + "/merges/:id/merge", async (c) => {
    const { repo, mr } = await mrFor(c, "maintain");
    const b =
      c.req.header("content-length") === "0" || !c.req.raw.body
        ? {}
        : await jsonInput(c);
    const options = z
      .object({
        strategy: z
          .enum(["ff_prefer", "ff_only", "merge"])
          .default("ff_prefer"),
        squash: z.boolean().default(false),
      })
      .parse(b);
    const result = await h.engine(c, repo, "/review-merge", {
      id: mr.id,
      ...options,
      actor_id: identity(c).id,
      source_sha:
        mr.source_repo_id && mr.state === "open"
          ? await currentForkSHA(c, mr)
          : mr.source_sha,
    });
    await h.audit(c, "merge_request.merge", repo.id, String(mr.id));
    return c.json(result);
  });
  app.post(base + "/merges/:id/pipeline", async (c) => {
    const { repo, mr } = await mrFor(c, "maintain");
    if (mr.state !== "open") fail(409, "Merge request is closed");
    const saved = await c.env.DB.prepare(
      "SELECT config FROM ci_pipelines WHERE repo_id=?",
    )
      .bind(repo.id)
      .first<{ config: string }>();
    if (!saved) fail(409, "Save a target repository pipeline first");
    const run = await enqueueRun(
      c.env,
      repo,
      "merge/" + mr.id,
      mr.source_sha,
      pipelineSchema.parse(JSON.parse(saved.config)),
      "merge_request",
      identity(c).id,
    );
    await h.audit(c, "ci.run.create", repo.id, run!.id);
    return c.json(run, 201);
  });
  app.get(base + "/merges/:id/discussions", async (c) => {
    const { mr } = await mrFor(c);
    return c.json(await discussionPage(c, mr.id, c.req.query("after")));
  });
  app.post(base + "/merges/:id/discussions", async (c) => {
    const { repo, mr } = await mrFor(c),
      user = identity(c),
      b = await jsonInput(c);
    const result = await h.engine(c, repo, "/review-discussion", {
      ...b,
      id: mr.id,
      actor_id: user.id,
    });
    await h.audit(c, "merge_request.discussion", repo.id, String(mr.id));
    return c.json(result, 201);
  });
  app.get(base + "/merges/:id/discussions/:discussion", async (c) => {
    const { mr } = await mrFor(c),
      thread = await c.env.DB.prepare(
        "SELECT * FROM merge_discussions WHERE id=? AND mr_id=?",
      )
        .bind(c.req.param("discussion"), mr.id)
        .first();
    if (!thread) fail(404, "Discussion not found");
    const after = Number(c.req.query("after") || 0);
    if (!Number.isSafeInteger(after) || after < 0)
      fail(400, "Invalid comment cursor");
    const comments = await c.env.DB.prepare(
      "SELECT x.*,u.username AS author FROM merge_discussion_comments x JOIN users u ON u.id=x.author_id WHERE x.discussion_id=? AND x.id>? ORDER BY x.id LIMIT 100",
    )
      .bind(c.req.param("discussion"), after)
      .all<any>();
    return c.json({
      thread,
      comments: comments.results,
      next: comments.results.length === 100 ? comments.results.at(-1).id : null,
    });
  });
  for (const [method, suffix, operation] of [
    ["post", "/comments", "/review-reply"],
    ["patch", "", "/review-resolve"],
  ] as const)
    app[method](
      base + "/merges/:id/discussions/:discussion" + suffix,
      async (c) => {
        const { repo, mr } = await mrFor(c),
          user = identity(c),
          b = await jsonInput(c);
        const result = await h.engine(c, repo, operation, {
          ...b,
          id: mr.id,
          actor_id: user.id,
          discussion: c.req.param("discussion"),
        });
        await h.audit(
          c,
          "merge_request.discussion.update",
          repo.id,
          String(mr.id),
        );
        return c.json(result, method === "post" ? 201 : 200);
      },
    );
  app.get(base + "/planning", async (c) => {
    const r = await access(c);
    const [labels, milestones] = await Promise.all([
      c.env.DB.prepare(
        "SELECT * FROM labels WHERE repo_id=? ORDER BY name LIMIT 200",
      )
        .bind(r.id)
        .all(),
      c.env.DB.prepare(
        "SELECT m.*,(SELECT count(*) FROM issues i WHERE i.milestone_id=m.id) AS total,(SELECT count(*) FROM issues i WHERE i.milestone_id=m.id AND i.state='closed') AS closed FROM milestones m WHERE repo_id=? ORDER BY title LIMIT 200",
      )
        .bind(r.id)
        .all(),
    ]);
    return c.json({ labels: labels.results, milestones: milestones.results });
  });
  app.post(base + "/labels", async (c) => {
    const r = await access(c, "write"),
      b = z
        .object({
          name: z.string().trim().min(1).max(50),
          color: z
            .string()
            .regex(/^[0-9a-fA-F]{6}$/)
            .default("64748b"),
        })
        .parse(await jsonInput(c)),
      id = crypto.randomUUID();
    await c.env.DB.prepare(
      "INSERT INTO labels(id,repo_id,name,color) VALUES(?,?,?,?)",
    )
      .bind(id, r.id, b.name, b.color)
      .run();
    return c.json({ id, ...b }, 201);
  });
  app.delete(base + "/labels/:id", async (c) => {
    const r = await access(c, "write");
    await c.env.DB.prepare("DELETE FROM labels WHERE repo_id=? AND id=?")
      .bind(r.id, c.req.param("id"))
      .run();
    return c.json({ ok: true });
  });
  const milestoneSchema = z.object({
    title: z.string().trim().min(1).max(120),
    description: z.string().max(20000).default(""),
    due_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .default(null),
    state: z.enum(["open", "closed"]).default("open"),
  });
  app.post(base + "/milestones", async (c) => {
    const r = await access(c, "write"),
      b = milestoneSchema.parse(await jsonInput(c)),
      id = crypto.randomUUID();
    await c.env.DB.prepare(
      "INSERT INTO milestones(id,repo_id,title,description,due_date,state) VALUES(?,?,?,?,?,?)",
    )
      .bind(id, r.id, b.title, b.description, b.due_date, b.state)
      .run();
    return c.json({ id, ...b }, 201);
  });
  app.patch(base + "/milestones/:id", async (c) => {
    const r = await access(c, "write"),
      b = z
        .object({
          title: z.string().trim().min(1).max(120).optional(),
          description: z.string().max(20000).optional(),
          due_date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .nullable()
            .optional(),
          state: z.enum(["open", "closed"]).optional(),
        })
        .parse(await jsonInput(c));
    const old = await c.env.DB.prepare(
      "SELECT * FROM milestones WHERE id=? AND repo_id=?",
    )
      .bind(c.req.param("id"), r.id)
      .first<any>();
    if (!old) fail(404, "Milestone not found");
    const next = { ...old, ...b };
    await c.env.DB.prepare(
      "UPDATE milestones SET title=?,description=?,due_date=?,state=? WHERE id=? AND repo_id=?",
    )
      .bind(
        next.title,
        next.description,
        next.due_date,
        next.state,
        old.id,
        r.id,
      )
      .run();
    return c.json({ ok: true });
  });
  app.put(base + "/issues/:id/planning", async (c) => {
    const r = await access(c, "write"),
      b = z
        .object({
          assignee: z.string().nullable().default(null),
          milestone_id: z.string().nullable().default(null),
          labels: z.array(z.string()).max(20).default([]),
        })
        .parse(await jsonInput(c));
    const issue = await c.env.DB.prepare(
      "SELECT id FROM issues WHERE id=? AND repo_id=?",
    )
      .bind(c.req.param("id"), r.id)
      .first<any>();
    if (!issue) fail(404, "Issue not found");
    let assignee = null;
    if (b.assignee) {
      const u = await c.env.DB.prepare(
        "SELECT id,username,admin FROM users WHERE username=? AND disabled=0",
      )
        .bind(b.assignee)
        .first<any>();
      if (!u || roleRank[await repositoryRole(c.env, r, u)] < 1)
        fail(400, "Assignee must be a repository member");
      assignee = u.id;
    }
    if (
      b.milestone_id &&
      !(await c.env.DB.prepare(
        "SELECT id FROM milestones WHERE repo_id=? AND id=?",
      )
        .bind(r.id, b.milestone_id)
        .first())
    )
      fail(400, "Milestone not in repository");
    for (const id of b.labels)
      if (
        !(await c.env.DB.prepare(
          "SELECT id FROM labels WHERE repo_id=? AND id=?",
        )
          .bind(r.id, id)
          .first())
      )
        fail(400, "Label not in repository");
    await c.env.DB.batch(
      [
        c.env.DB.prepare(
          "UPDATE issues SET assignee_id=?,milestone_id=? WHERE id=? AND repo_id=?",
        ).bind(assignee, b.milestone_id, issue.id, r.id),
        c.env.DB.prepare("DELETE FROM issue_labels WHERE issue_id=?").bind(
          issue.id,
        ),
        ...new Set(b.labels),
      ].map((v: any) =>
        typeof v === "string"
          ? c.env.DB.prepare("INSERT INTO issue_labels VALUES(?,?)").bind(
              issue.id,
              v,
            )
          : v,
      ),
    );
    await h.audit(c, "issue.assign", r.id, String(issue.id));
    return c.json({ ok: true });
  });
  app.get(base + "/releases", async (c) => {
    const r = await access(c);
    return c.json({
      releases: (
        await c.env.DB.prepare(
          "SELECT x.*,u.username AS author FROM releases x JOIN users u ON u.id=x.author_id WHERE repo_id=? ORDER BY created_at DESC LIMIT 100",
        )
          .bind(r.id)
          .all()
      ).results,
    });
  });
  app.post(base + "/releases", async (c) => {
    const r = await access(c, "maintain"),
      u = identity(c),
      b = z
        .object({
          tag: branch,
          title: z.string().trim().min(1).max(200),
          body: z.string().max(20000).default(""),
          prerelease: z.boolean().default(false),
        })
        .parse(await jsonInput(c));
    const commit = await h.engine(
      c,
      r,
      "/resolve?ref=" + encodeURIComponent("refs/tags/" + b.tag),
    );
    const id = crypto.randomUUID();
    await c.env.DB.prepare(
      "INSERT INTO releases(id,repo_id,tag,sha,title,body,prerelease,author_id) VALUES(?,?,?,?,?,?,?,?)",
    )
      .bind(
        id,
        r.id,
        b.tag,
        commit.sha || commit.commit_sha,
        b.title,
        b.body,
        +b.prerelease,
        u.id,
      )
      .run();
    await h.audit(c, "release.create", r.id, b.tag);
    return c.json({ id, ...b }, 201);
  });
  app.delete(base + "/releases/:id", async (c) => {
    const r = await access(c, "maintain");
    await c.env.DB.prepare("DELETE FROM releases WHERE repo_id=? AND id=?")
      .bind(r.id, c.req.param("id"))
      .run();
    await h.audit(c, "release.delete", r.id, c.req.param("id"));
    return c.json({ ok: true });
  });
  app.get(base + "/deployments", async (c) => {
    const r = await access(c);
    identity(c);
    if (!roleRank[c.get("repoRole")]) fail(404, "Not found");
    const [deployments, environments] = await Promise.all([
      c.env.DB.prepare(
        "SELECT id,run_id,environment,sha,created_at FROM deployments WHERE repo_id=? ORDER BY created_at DESC LIMIT 100",
      )
        .bind(r.id)
        .all(),
      c.env.DB.prepare(
        "SELECT * FROM environments WHERE repo_id=? ORDER BY name",
      )
        .bind(r.id)
        .all<any>(),
    ]);
    return c.json({
      deployments: deployments.results,
      environments: environments.results.map((e) => ({
        ...e,
        url: c.env.APPS_ORIGIN + "/apps/" + r.id + "/" + e.name + "/",
      })),
    });
  });
  app.put(base + "/environments/:name", async (c) => {
    const r = await access(c, "maintain"),
      b = z
        .object({
          deployment_id: z.string().uuid().nullable(),
          expected_deployment_id: z.string().uuid().nullable(),
          public: z.boolean().default(false),
        })
        .parse(await jsonInput(c));
    const name = z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,39}$/)
      .parse(c.req.param("name"));
    if (
      b.deployment_id &&
      !(await c.env.DB.prepare(
        "SELECT d.id FROM deployments d JOIN ci_runs c ON c.id=d.run_id WHERE d.id=? AND d.repo_id=? AND d.environment=? AND c.status='succeeded'",
      )
        .bind(b.deployment_id, r.id, name)
        .first())
    )
      fail(
        400,
        "Successful deployment in this repository/environment required",
      );
    const result = await c.env.DB.prepare(
      "UPDATE environments SET deployment_id=?,public=?,updated_at=datetime('now') WHERE repo_id=? AND name=? AND deployment_id IS ?",
    )
      .bind(b.deployment_id, +b.public, r.id, name, b.expected_deployment_id)
      .run();
    if (!result.meta.changes)
      fail(409, "Environment changed; refresh before publishing or rollback");
    await h.audit(c, "deployment.activate", r.id, name + ":" + b.deployment_id);
    return c.json({ ok: true });
  });
  registerCommunity(app, h, access);
}
function registerCommunity(
  app: Hono<App>,
  h: Helpers,
  access: Helpers["access"],
) {
  const base = "/api/repos/:namespace/:repo";
  app.get(base + "/wiki", async (c) => {
    const r = await access(c);
    return c.json({
      pages: (
        await c.env.DB.prepare(
          "SELECT slug,title,version,updated_at FROM wiki_pages WHERE repo_id=? ORDER BY title LIMIT 200",
        )
          .bind(r.id)
          .all()
      ).results,
    });
  });
  app.get(base + "/wiki/:page", async (c) => {
    const r = await access(c);
    const version = c.req.query("version");
    const row = version
      ? await c.env.DB.prepare(
          "SELECT * FROM wiki_history WHERE repo_id=? AND slug=? AND version=?",
        )
          .bind(r.id, c.req.param("page"), Number(version))
          .first()
      : await c.env.DB.prepare(
          "SELECT * FROM wiki_pages WHERE repo_id=? AND slug=?",
        )
          .bind(r.id, c.req.param("page"))
          .first();
    if (!row) fail(404, "Wiki page not found");
    return c.json({
      ...row,
      history: (
        await c.env.DB.prepare(
          "SELECT version,title,created_at FROM wiki_history WHERE repo_id=? AND slug=? ORDER BY version DESC LIMIT 100",
        )
          .bind(r.id, c.req.param("page"))
          .all()
      ).results,
    });
  });
  app.put(base + "/wiki/:page", async (c) => {
    const r = await access(c, "write"),
      u = identity(c),
      page = slug.parse(c.req.param("page")),
      b = z
        .object({
          title: z.string().trim().min(1).max(200),
          body: z.string().max(100000),
          expected_version: z.number().int().min(0),
        })
        .parse(await jsonInput(c));
    const result = await c.env.DB.prepare(
      "INSERT INTO wiki_pages(repo_id,slug,title,body,version,author_id) SELECT ?,?,?,?,1,? WHERE ?=0 ON CONFLICT(repo_id,slug) DO UPDATE SET title=excluded.title,body=excluded.body,version=wiki_pages.version+1,author_id=excluded.author_id,updated_at=datetime('now') WHERE wiki_pages.version=? RETURNING version",
    )
      .bind(
        r.id,
        page,
        b.title,
        b.body,
        u.id,
        b.expected_version,
        b.expected_version,
      )
      .first<any>();
    if (!result) {
      if (b.expected_version > 0) {
        const update = await c.env.DB.prepare(
          "UPDATE wiki_pages SET title=?,body=?,version=version+1,author_id=?,updated_at=datetime('now') WHERE repo_id=? AND slug=? AND version=? RETURNING version",
        )
          .bind(b.title, b.body, u.id, r.id, page, b.expected_version)
          .first<any>();
        if (!update) fail(409, "Wiki changed; reload before saving");
        await h.audit(c, "wiki.update", r.id, page);
        return c.json(update);
      }
      fail(409, "Wiki changed; reload before saving");
    }
    await h.audit(c, "wiki.update", r.id, page);
    return c.json(result);
  });
  for (const kind of ["star", "watch"] as const) {
    const table = kind === "star" ? "repository_stars" : "repository_watches";
    app.put(base + "/" + kind, async (c) => {
      const r = await access(c),
        u = identity(c);
      await c.env.DB.prepare(`INSERT OR IGNORE INTO ${table} VALUES(?,?)`)
        .bind(r.id, u.id)
        .run();
      return c.json({ ok: true });
    });
    app.delete(base + "/" + kind, async (c) => {
      const r = await access(c),
        u = identity(c);
      await c.env.DB.prepare(
        `DELETE FROM ${table} WHERE repo_id=? AND user_id=?`,
      )
        .bind(r.id, u.id)
        .run();
      return c.json({ ok: true });
    });
  }
  app.get(base + "/social", async (c) => {
    const r = await access(c),
      u = c.get("user");
    return c.json(
      await c.env.DB.prepare(
        "SELECT (SELECT count(*) FROM repository_stars WHERE repo_id=?) AS stars,EXISTS(SELECT 1 FROM repository_stars WHERE repo_id=? AND user_id=?) AS starred,EXISTS(SELECT 1 FROM repository_watches WHERE repo_id=? AND user_id=?) AS watching",
      )
        .bind(r.id, r.id, u?.id || "", r.id, u?.id || "")
        .first(),
    );
  });
  app.get("/api/notifications", async (c) => {
    const u = identity(c),
      rows = (
        await c.env.DB.prepare(
          "SELECT n.*,r.namespace,r.name,r.visibility,r.owner_id,r.workspace_id,r.id AS repository_id FROM notifications n JOIN repositories r ON r.id=n.repo_id WHERE n.user_id=? AND r.deleted_at IS NULL ORDER BY n.id DESC LIMIT 100",
        )
          .bind(u.id)
          .all<any>()
      ).results;
    const visible = [];
    for (const row of rows)
      if (
        row.visibility === "public" ||
        roleRank[
          await repositoryRole(
            c.env,
            { ...row, id: row.repository_id } as Repo,
            u,
          )
        ] > 0
      )
        visible.push(row);
    return c.json({ notifications: visible });
  });
  app.post("/api/notifications/read", async (c) => {
    const u = identity(c),
      b = z
        .object({ through_id: z.number().int().positive() })
        .parse(await jsonInput(c));
    await c.env.DB.prepare(
      "UPDATE notifications SET read=1 WHERE user_id=? AND id<=?",
    )
      .bind(u.id, b.through_id)
      .run();
    return c.json({ ok: true });
  });
}
