import { assertDeployGitRequest } from "./deploy-tokens";
import { advanceCodeIndex } from "./code-index";
import {
  advanceQueue,
  queueMutation,
  validateQueuePublication,
} from "./merge-queue";
import { RequestGate } from "./git/request-gate";
import { BrowseCache } from "./git/browse-cache";
import {
  acquireSnapshot,
  SnapshotBudget,
  SnapshotStore,
  repositoryRead,
  snapshotRead,
  shareableOperation,
  snapshotResponse,
} from "./git/snapshot-read";
import { PackCache, collectPackCache } from "./git/pack-cache";
import { responseCompletion } from "./git/pack-stream";
import { receiveStream } from "./git/receive-stream";
import { collectIncoming } from "./git/incoming-area";
import { gitStage, reportGitFailure } from "./git/diagnostics";
import { GitObjectIndex } from "./git/object-index";
import { checkProjectVersion, withProjectTransition } from "./project-version";
import { transferProject } from "./project-transfer";
import {
  assertRepositoryWritable,
  assertProjectRevision,
  changeProjectState,
  archiveError,
} from "./project-state";
import {
  plannedIssueClosures,
  projectMerge,
  type MergeResult,
} from "./merge-issues";
import { importContribution } from "./fork-reviews";
import { reviewMutation, reviewActor } from "./review-mutations";
import { z } from "zod";
import { protectRefs, reviewGate } from "./review";
import { ObjectCache } from "./git/object-cache";
import { upstreamClient, pullRepository, scheduleSync } from "./sync";
import { forgeEvent, dispatchEvent, ForgeEvent } from "./events";
import type { Repo } from "./types";
import type { RefStorage } from "./git/repository";
import { lifecycle, collectDeleted, projectDefaultBranch } from "./lifecycle";
import { DurableObject } from "cloudflare:workers";
import { HTTPException } from "hono/http-exception";
import {
  assertGitReceiptCapacity,
  drainGitReceipts,
  stageGitReceipt,
  putRefPublication,
} from "./git/receipts";
import type { Env } from "./types";
import { boundedBody, fail, branch, slug, repoName } from "./security";
import { ObjectStore, Refs, LIMITS, text } from "./git/objects";
import { namespaceRepositories } from "./git/namespaces";
import { normalizePolicies } from "./delegation";
import { parseCommitStream } from "./git/commit-stream";
import { applyGitPatch } from "./git/patch";
import { paginate } from "./git/forge-utils";
import { advertise, upload } from "./git/protocol";
import { importSnapshot } from "./git/legacy";
/** The per-repository DO serializes requests; immutable R2 objects precede atomic ref publication. */
export class Repository extends DurableObject<Env> {
  private gate = new RequestGate();
  private get waiting() {
    return this.gate.waiting;
  }
  private objectCache = new ObjectCache();
  private objectIndex?: GitObjectIndex;
  async fetch(request: Request): Promise<Response> {
    const started = performance.now();
    let admitted = started;
    try {
      // Internal cross-fork queue checks never wait on the other repository's writer gate.
      // Only published refs are visible; no R2 reads or nested source locks are acquired.
      if (
        request.method === "GET" &&
        new URL(request.url).pathname === "/internal/queue-source"
      ) {
        const id = request.headers.get("x-repo-id") || "";
        if (!/^[0-9a-f-]{36}$/.test(id)) fail(400, "Invalid repository");
        if (await this.ctx.storage.get("deleted"))
          fail(404, "Repository deleted");
        await checkProjectVersion(this.env, this.ctx.storage, id, request);
        const ref = new URL(request.url).searchParams.get("ref") || "";
        if (!ref.startsWith("refs/heads/")) fail(400, "Branch required");
        branch.parse(ref.slice(11));
        const refs = (await this.ctx.storage.get<Refs>("refs.v2")) || {};
        return Response.json({ sha: refs[ref] || null });
      }
      const response = await this.gate.run(
        shareableOperation(request),
        async (ready) => {
          admitted = performance.now();
          await assertDeployGitRequest(this.env, request);
          return this.handle(request, ready);
        },
        snapshotRead(request)
          ? async () => {
              admitted = performance.now();
              await assertDeployGitRequest(this.env, request);
              return this.handleSnapshot(request);
            }
          : undefined,
      );
      try {
        await assertDeployGitRequest(this.env, request);
      } catch (e) {
        await response.body?.cancel();
        throw e;
      }
      if (new URL(request.url).pathname === "/browse") {
        response.headers.append(
          "Server-Timing",
          `repo_queue;dur=${(admitted - started).toFixed(1)}, repo_total;dur=${(performance.now() - started).toFixed(1)}`,
        );
      }
      return response;
    } catch (e) {
      if (e instanceof HTTPException)
        return Response.json({ error: e.message }, { status: e.status });
      if (archiveError(e))
        return Response.json({ error: "Repository archived" }, { status: 409 });
      const incident = reportGitFailure(
        e,
        request.headers.get("x-repo-id") || "",
        "repository",
      );
      return Response.json(
        {
          error:
            "Git transaction failed; inspect refs before retrying; incident " +
            incident,
          incident_id: incident,
        },
        { status: 503, headers: { "X-OneStorage-Incident": incident } },
      );
    }
  }
  async alarm() {
    // An alarm has a 15-minute wall-clock budget. Never spend it waiting for an HTTP stream.
    if (this.waiting) {
      await this.ctx.storage.setAlarm(Date.now() + 30000);
      return;
    }
    await this.gate.run(false, async () => {
      if (await this.ctx.storage.get("deleted")) {
        this.objectCache.clear();
        await collectDeleted(this.env, this.ctx.storage);
        return new Response(null, { status: 204 });
      }
      await projectDefaultBranch(this.env, this.ctx.storage);
      const receipts = await drainGitReceipts(this.env, this.ctx.storage);
      try {
        await collectPackCache(this.env.OBJECTS, this.ctx.storage);
      } catch {
        // A disposable cache must not stall event delivery or upstream reconciliation.
        await this.ctx.storage.setAlarm(Date.now() + 30000);
      }
      const incomingPending = await collectIncoming(
        this.env.OBJECTS,
        this.ctx.storage,
      );
      for (const [key, pending] of await this.ctx.storage.list<{
        repo_id: string;
        mr_id: number;
        result: MergeResult;
      }>({ prefix: "merge-projection:", limit: 10 })) {
        await projectMerge(
          this.env,
          pending.repo_id,
          pending.mr_id,
          pending.result,
        );
        await this.ctx.storage.delete(key);
      }
      for (const [key, event] of await this.ctx.storage.list<ForgeEvent>({
        prefix: "event:",
        limit: 20,
      })) {
        await dispatchEvent(this.env, event);
        if (["push", "repo.sync.succeeded"].includes(event.event))
          await this.ctx.storage.put("code-index", event.repository_id);
        await this.ctx.storage.delete(key);
      }
      const queueRepo = await this.ctx.storage.get<string>("merge-queue");
      if (queueRepo) {
        await this.ctx.storage.setAlarm(Date.now() + 15000);
        const live = await this.env.DB.prepare(
          "SELECT * FROM repositories WHERE id=? AND deleted_at IS NULL",
        )
          .bind(queueRepo)
          .first<Repo>();
        if (!live || live.archived_at)
          await this.ctx.storage.delete("merge-queue");
        else
          await this.handle(
            new Request("http://repository/internal/merge-queue-tick", {
              method: "POST",
              headers: {
                "x-repo-id": live.id,
                "x-lifecycle-revision": String(live.lifecycle_revision),
                "x-default-branch": live.default_branch,
                "x-actor": "OneStorage merge queue",
              },
            }),
          );
      }
      const codeRepo = await this.ctx.storage.get<string>("code-index");
      if (codeRepo) {
        await this.ctx.storage.setAlarm(Date.now() + 1000);
        try {
          const live = await this.env.DB.prepare(
            "SELECT * FROM repositories WHERE id=? AND deleted_at IS NULL",
          )
            .bind(codeRepo)
            .first<Repo>();
          if (!live) await this.ctx.storage.delete("code-index");
          else if (live.sync_status === "initializing")
            await this.ctx.storage.setAlarm(Date.now() + 30000);
          else {
            // Prewarm after published push/sync events, before the heavier code
            // index traversal. Cache failure cannot block index maintenance.
            try {
              const refs = (await this.ctx.storage.get<Refs>("refs.v2")) || {};
              const target = refs["refs/heads/" + live.default_branch];
              if (
                target &&
                target !== (await this.ctx.storage.get("browse-warmed.v1"))
              ) {
                const response = await this.handle(
                  new Request("http://repository/browse", {
                    headers: {
                      "x-repo-id": live.id,
                      "x-lifecycle-revision": String(live.lifecycle_revision),
                      "x-default-branch": live.default_branch,
                    },
                  }),
                );
                await response.body?.cancel();
                if (response.ok)
                  await this.ctx.storage.put("browse-warmed.v1", target);
              }
            } catch {
              /* The next foreground read can rebuild the disposable cache. */
            }
            await this.handle(
              new Request("http://repository/internal/code-index-tick", {
                method: "POST",
                headers: {
                  "x-repo-id": live.id,
                  "x-lifecycle-revision": String(live.lifecycle_revision),
                  "x-default-branch": live.default_branch,
                },
              }),
            );
          }
          await this.ctx.storage.delete("code-index-failures");
        } catch {
          const attempts =
            ((await this.ctx.storage.get<number>("code-index-failures")) || 0) +
            1;
          await this.ctx.storage.put("code-index-failures", attempts);
          await this.ctx.storage.setAlarm(
            Date.now() + Math.min(300000, 1000 * 2 ** Math.min(attempts, 9)),
          );
          await this.env.DB.prepare(
            "UPDATE code_index_state SET status='failed',error='Index update temporarily unavailable; automatic retry pending',checked_at=? WHERE repo_id=?",
          )
            .bind(Date.now(), codeRepo)
            .run();
        }
      }
      const id = await this.ctx.storage.get<string>("sync-reconcile");
      if (
        id &&
        ((await this.ctx.storage.get<number>("sync-retries")) || 0) < 5
      ) {
        const metadata = await this.env.DB.prepare(
          "SELECT * FROM repositories WHERE id=? AND deleted_at IS NULL",
        )
          .bind(id)
          .first<Repo>();
        if (metadata) {
          try {
            await pullRepository(
              this.env,
              this.ctx.storage,
              metadata,
              new ObjectStore(id, this.env.OBJECTS),
            );
            await this.ctx.storage.delete("sync-retries");
          } catch {
            const n =
              ((await this.ctx.storage.get<number>("sync-retries")) || 0) + 1;
            await this.ctx.storage.put("sync-retries", n);
            if (n < 5) await this.ctx.storage.setAlarm(Date.now() + 300000);
          }
        }
      }
      if (
        receipts.pending ||
        incomingPending ||
        (await this.ctx.storage.list({ prefix: "event:", limit: 1 })).size ||
        (await this.ctx.storage.list({ prefix: "merge-projection:", limit: 1 }))
          .size
      )
        await this.ctx.storage.setAlarm(
          Date.now() + (receipts.failed ? 30000 : 1000),
        );
      return new Response(null, { status: 204 });
    });
  }
  private async handleSnapshot(
    request: Request,
  ): Promise<Response | undefined> {
    const release = acquireSnapshot();
    if (!release) return;
    let store: SnapshotStore | undefined, completion: Promise<void> | undefined;
    const id = request.headers.get("x-repo-id") || "";
    try {
      if (!/^[0-9a-f-]{36}$/.test(id) || this.objectIndex?.repoId !== id)
        fail(400, "Invalid repository");
      if (await this.ctx.storage.get("deleted"))
        fail(404, "Repository deleted");
      const version = await this.ctx.storage.get<number>("project-version");
      if (
        version === undefined ||
        (await this.ctx.storage.get("project-transition"))
      )
        throw new SnapshotBudget();
      if (
        request.headers.has("x-lifecycle-revision") &&
        request.headers.get("x-lifecycle-revision") !== String(version)
      )
        fail(
          409,
          "Project moved or lifecycle changed; reload before reading or writing",
        );
      const ephemeral = request.headers.get("x-namespace") === "ephemeral";
      if (!ephemeral && (await this.ctx.storage.get("sync-reconcile")))
        fail(
          409,
          "Upstream outcome is being reconciled; pull upstream before reading",
        );
      const defaultBranch = branch.parse(
        (await this.ctx.storage.get<string>("default-branch")) ||
          request.headers.get("x-default-branch") ||
          "main",
      );
      const refs = (await this.ctx.storage.get<Refs>("refs.v2")) || {};
      store = new SnapshotStore(id, this.env.OBJECTS, this.objectCache);
      const readonlyStorage: RefStorage = {
        get: <T>(key: string) => this.ctx.storage.get<T>(key),
        put: async () => {
          throw Error("Snapshot attempted ref publication");
        },
      };
      const repo = namespaceRepositories(
        store,
        readonlyStorage,
        refs,
        defaultBranch,
        { rules: [] },
      )(ephemeral);
      // Explicit unpublished/ancestry selectors retain their existing serialized API semantics.
      const query = new URL(request.url).searchParams;
      for (const selector of [query.get("ref"), query.get("sha")]) {
        if (!selector) continue;
        if (
          /[~^]/.test(selector) ||
          /^[0-9a-f]{4,39}$/.test(selector) ||
          (/^[0-9a-f]{40}$/.test(selector) &&
            !Object.values(repo.refs).includes(selector))
        )
          throw new SnapshotBudget();
      }
      const result = await repositoryRead(
        repo,
        request,
        defaultBranch,
        new BrowseCache(this.ctx.storage, false),
      );
      if (!result) throw new SnapshotBudget();
      const response = await snapshotResponse(result);
      completion = responseCompletion(response);
      return response;
    } catch (error) {
      if (error instanceof SnapshotBudget) return;
      throw error;
    } finally {
      await store?.close();
      if (completion)
        this.ctx.waitUntil(
          completion.then(() => {
            release();
            console.info("Git snapshot drained", {
              repoId: id,
              ...store?.ioUsage,
            });
          }),
        );
      else release();
    }
  }
  private async handle(request: Request, ready: () => void = () => {}) {
    const id = request.headers.get("x-repo-id") || "";
    if (!/^[0-9a-f-]{36}$/.test(id)) fail(400, "Invalid repository");
    if (await this.ctx.storage.get("deleted")) fail(404, "Repository deleted");
    await gitStage("metadata", () =>
      checkProjectVersion(this.env, this.ctx.storage, id, request),
    );
    const defaultBranch = branch.parse(
      (await this.ctx.storage.get<string>("default-branch")) ||
        request.headers.get("x-default-branch") ||
        "main",
    );
    const url = new URL(request.url),
      store = new ObjectStore(
        id,
        this.env.OBJECTS,
        this.objectCache,
        (this.objectIndex ||= await gitStage(
          "object-index",
          async () => new GitObjectIndex(id, this.ctx.storage),
        )),
      );
    // Public API access was checked against fresh D1 metadata by the outer Worker.
    // Reads use durable refs/tombstone and the recoverable version cache; mutations also load authoritative metadata.
    const metadata =
      ["GET", "HEAD"].includes(request.method) &&
      url.searchParams.get("service") !== "git-receive-pack"
        ? null
        : await gitStage("metadata", () =>
            this.env.DB.prepare(
              "SELECT * FROM repositories WHERE id=? AND deleted_at IS NULL",
            )
              .bind(id)
              .first<Repo>(),
          );
    if (metadata || !["GET", "HEAD"].includes(request.method))
      assertProjectRevision(metadata, request);
    assertRepositoryWritable(metadata, request);
    if (
      ["/internal/lifecycle", "/internal/transfer"].includes(url.pathname) &&
      request.method === "POST"
    ) {
      if (!metadata) fail(404, "Repository not found");
      const body = z
        .object({
          actor_id: z.string(),
          archived: z.boolean().optional(),
          namespace: slug.optional(),
          name: repoName.optional(),
          revision: z.number().int().min(0),
        })
        .parse(JSON.parse(text(await boundedBody(request, 4096))));
      if (await this.ctx.storage.get("sync-reconcile"))
        fail(409, "Reconcile upstream before changing project state");
      if (metadata.sync_status === "initializing")
        fail(409, "Project initialization is in progress");
      // Complete already-published merges before freezing D1 collaboration tables.
      for (const [key, pending] of await this.ctx.storage.list<{
        repo_id: string;
        mr_id: number;
        result: MergeResult;
      }>({ prefix: "merge-projection:" })) {
        await projectMerge(
          this.env,
          pending.repo_id,
          pending.mr_id,
          pending.result,
        );
        await this.ctx.storage.delete(key);
      }
      if (url.pathname === "/internal/transfer") {
        if (!body.namespace || !body.name)
          fail(400, "Destination namespace and name required");
        return Response.json(
          await withProjectTransition(this.env, this.ctx.storage, id, () =>
            transferProject(
              this.env,
              metadata,
              body.actor_id,
              body.namespace!,
              body.name!,
              body.revision,
            ),
          ),
        );
      }
      if (body.archived === undefined) fail(400, "Archived state required");
      return Response.json(
        await withProjectTransition(this.env, this.ctx.storage, id, () =>
          changeProjectState(
            this.env,
            id,
            body.actor_id,
            body.archived!,
            body.revision,
          ),
        ),
      );
    }
    if (url.pathname === "/internal/sync" && request.method === "POST") {
      if (!metadata) fail(404, "Repository not found");
      return Response.json(
        await pullRepository(this.env, this.ctx.storage, metadata, store),
      );
    }
    if (
      (await this.ctx.storage.get("sync-reconcile")) &&
      url.pathname !== "/internal/delete" &&
      request.headers.get("x-namespace") !== "ephemeral"
    )
      fail(
        409,
        "Upstream outcome is being reconciled; pull upstream before retrying",
      );
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
    ready();
    const policy = JSON.parse(
      request.headers.get("x-write-policy") || '{"rules":[]}',
    );
    let forwarded = false;
    let reviewedMerge: any = null;
    const publication: RefStorage = {
      get: <T>(key: string) => this.ctx.storage.get<T>(key),
      put: async (key, value) => {
        if (key !== "refs.v2") fail(400, "Unexpected Git state key");
        const next = value as Refs;
        const before = (await this.ctx.storage.get<Refs>("refs.v2")) || {};
        const values: Record<string, unknown> = { "refs.v2": next };
        if (reviewedMerge) {
          values["merge-result:" + reviewedMerge.id] = {
            sha: next["refs/heads/" + reviewedMerge.target],
            issue_ids: reviewedMerge.issue_ids,
            actor_id: reviewedMerge.actor_id,
            ...(reviewedMerge.queue_entry
              ? { queue_id: reviewedMerge.queue_entry.id }
              : {}),
          };
          values["merge-projection:" + reviewedMerge.id] = {
            repo_id: id,
            mr_id: reviewedMerge.id,
            result: values["merge-result:" + reviewedMerge.id],
          };
        }
        let refsUpdated = 0;
        for (const ref of new Set([
          ...Object.keys(before),
          ...Object.keys(next),
        ]))
          if (before[ref] !== next[ref]) {
            refsUpdated++;
            const event = forgeEvent(id, "push", {
              ref,
              before: before[ref] || "0".repeat(40),
              after: next[ref] || "0".repeat(40),
              actor: request.headers.get("x-actor") || null,
            });
            values["event:" + event.id] = event;
          }
        if (
          request.method === "POST" &&
          url.pathname === "/git/git-receive-pack"
        )
          await stageGitReceipt(
            this.ctx.storage,
            values,
            {
              repository_id: id,
              actor_id: request.headers.get("x-actor-id") || null,
            },
            refsUpdated,
          );
        await this.ctx.storage.setAlarm(Date.now() + 1000);
        await putRefPublication(this.ctx.storage, values);
        if (forwarded) {
          await scheduleSync(this.env, metadata!);
          await this.ctx.storage.delete(["sync-reconcile", "sync-retries"]);
        }
      },
    };
    const select = namespaceRepositories(
      store,
      publication,
      refs,
      defaultBranch,
      {
        beforePublish: async (before, after, ephemeral) => {
          if (reviewedMerge?.queue_entry && metadata)
            await validateQueuePublication(
              this.env,
              metadata,
              select(false),
              reviewedMerge.queue_entry,
              reviewedMerge,
            );
          if (!ephemeral && metadata)
            await protectRefs(
              this.env,
              metadata,
              store,
              before,
              after,
              reviewedMerge,
            );
          if (!metadata?.base_repo || ephemeral) return after;
          const config = JSON.parse(metadata.base_repo);
          if (config.provider === "github" && config.mode === "public")
            return after;
          const client = await upstreamClient(this.env, metadata);
          await this.ctx.storage.put("sync-reconcile", id);
          await this.ctx.storage.setAlarm(Date.now() + 1000);
          await client.push(store, before, after);
          forwarded = true;
          return after;
        },
        rules: normalizePolicies(policy.rules),
        allowForce: policy.allowForce === true,
        signingKeys: async () =>
          (
            await this.env.DB.prepare(
              "SELECT format,public_key FROM signing_keys WHERE user_id=?",
            )
              .bind(request.headers.get("x-repo-owner-id") || "")
              .all<{ format: string; public_key: string }>()
          ).results,
      },
    );
    const ephemeral = request.headers.get("x-namespace") === "ephemeral",
      repo = select(ephemeral),
      path = url.pathname;
    if (path === "/internal/code-index-wake" && request.method === "POST") {
      await this.ctx.storage.put("code-index", id);
      await this.ctx.storage.setAlarm(Date.now() + 1000);
      return Response.json({ scheduled: true });
    }
    if (path === "/internal/code-index-tick" && request.method === "POST") {
      if (!metadata) fail(404, "Repository not found");
      const pending = await advanceCodeIndex(this.env, metadata, repo);
      if (!pending) await this.ctx.storage.delete("code-index");
      return Response.json({ pending });
    }
    if (path === "/internal/merge-queue-tick" && request.method === "POST") {
      if (!metadata) fail(404, "Repository not found");
      await advanceQueue(
        this.env,
        this.ctx.storage,
        metadata,
        repo,
        async (entry, mr) => {
          reviewedMerge = {
            ...mr,
            actor_id: entry.actor_id,
            queue_entry: entry,
            issue_ids: await plannedIssueClosures(
              this.env,
              metadata,
              mr,
              store,
              defaultBranch,
            ),
          };
          await repo.publish({
            ...repo.refs,
            ["refs/heads/" + mr.target]: entry.candidate_sha!,
          });
          await projectMerge(this.env, id, mr.id, {
            sha: entry.candidate_sha!,
            actor_id: entry.actor_id,
            issue_ids: reviewedMerge.issue_ids,
            queue_id: entry.id,
          });
          await this.ctx.storage.delete("merge-projection:" + mr.id);
        },
      );
      return Response.json({ ok: true });
    }
    if (
      [
        "/internal/merge-queue-enqueue",
        "/internal/merge-queue-cancel",
      ].includes(path) &&
      request.method === "POST"
    ) {
      if (!metadata) fail(404, "Repository not found");
      const body = JSON.parse(text(await boundedBody(request, 8192)));
      const key = z.number().int().positive().parse(body.id);
      const mrId = path.endsWith("enqueue")
        ? key
        : (
            await this.env.DB.prepare(
              "SELECT mr_id FROM merge_queue WHERE id=? AND repo_id=?",
            )
              .bind(key, id)
              .first<{ mr_id: number }>()
          )?.mr_id;
      const completed = mrId
        ? await this.ctx.storage.get<MergeResult>("merge-result:" + mrId)
        : undefined;
      if (completed) {
        await projectMerge(this.env, id, mrId!, completed);
        fail(409, "Merge request already merged");
      }
      return Response.json(
        await queueMutation(
          this.env,
          this.ctx.storage,
          metadata,
          repo,
          path.endsWith("cancel") ? "cancel" : "enqueue",
          body,
        ),
      );
    }
    if (path === "/review-context" && request.method === "GET") {
      const metadata = await this.env.DB.prepare(
        "SELECT * FROM repositories WHERE id=? AND deleted_at IS NULL",
      )
        .bind(id)
        .first<Repo>();
      const mr = await this.env.DB.prepare(
        "SELECT * FROM merge_requests WHERE id=? AND repo_id=?",
      )
        .bind(url.searchParams.get("id"), id)
        .first<any>();
      if (!metadata || !mr) fail(404, "Merge request not found");
      if (String(mr.revision) !== url.searchParams.get("revision"))
        fail(409, "Merge request changed; reload the review");
      return Response.json({
        gate: await reviewGate(this.env, metadata, mr, store),
        closing_issues: await plannedIssueClosures(
          this.env,
          metadata,
          mr,
          store,
          defaultBranch,
        ),
      });
    }
    if (path === "/internal/merge-import" && request.method === "POST") {
      if (!metadata) fail(404, "Repository unavailable");
      const b = z
        .object({
          source_id: z.string().uuid(),
          source_sha: z.string().regex(/^[a-f0-9]{40}$/),
          actor_id: z.string(),
          refresh: z.boolean().optional(),
        })
        .parse(JSON.parse(text(await boundedBody(request, 8192))));
      return Response.json(
        await importContribution(this.env, repo, metadata, b),
      );
    }
    if (
      [
        "/review-update",
        "/review-submit",
        "/review-discussion",
        "/review-reply",
        "/review-resolve",
      ].includes(path) &&
      request.method === "POST"
    ) {
      if (!metadata) fail(404, "Repository unavailable");
      const raw = JSON.parse(text(await boundedBody(request, 128 * 1024)));
      const reviewId = z.coerce.number().int().positive().parse(raw.id);
      const completed = await this.ctx.storage.get<MergeResult>(
        "merge-result:" + reviewId,
      );
      if (completed) {
        await projectMerge(this.env, id, reviewId, completed);
        fail(409, "Merge request already merged");
      }
      return Response.json(
        await reviewMutation(this.env, repo, metadata, path, raw),
      );
    }
    if (path === "/review-merge" && request.method === "POST") {
      const body = JSON.parse(text(await boundedBody(request, 8192)));
      const mr = await this.env.DB.prepare(
        "SELECT * FROM merge_requests WHERE id=? AND repo_id=?",
      )
        .bind(body.id, id)
        .first<any>();
      if (!mr || !metadata) fail(404, "Merge request not found");
      if ((await reviewActor(this.env, metadata, body.actor_id)).rank < 3)
        fail(403, "Maintainer required");
      const previous = await this.ctx.storage.get<MergeResult>(
        "merge-result:" + mr.id,
      );
      if (previous || mr.state === "merged") {
        const result = previous || { sha: mr.merged_sha };
        await projectMerge(this.env, id, mr.id, result);
        return Response.json(result);
      }
      if (mr.state !== "open") fail(409, "Merge request closed");
      if (
        await this.env.DB.prepare(
          "SELECT branch FROM branch_protections WHERE repo_id=? AND branch=? AND require_queue=1",
        )
          .bind(id, mr.target)
          .first()
      )
        fail(403, "Protected branch requires the merge queue");
      if (body.revision !== mr.revision)
        fail(409, "Merge request changed; reload before merging");
      if (
        (mr.source_repo_id
          ? body.source_sha !== mr.source_sha
          : refs["refs/heads/" + mr.source] !== mr.source_sha) ||
        refs["refs/heads/" + mr.target] !== mr.target_sha
      )
        fail(409, "Branches moved; refresh the merge request and review again");
      const gate = await reviewGate(this.env, metadata, mr, store);
      if (!gate.allowed) fail(409, gate.reasons.join("; "));
      reviewedMerge = {
        ...mr,
        actor_id: body.actor_id,
        issue_ids: await plannedIssueClosures(
          this.env,
          metadata,
          mr,
          store,
          defaultBranch,
        ),
      };
      const result = await repo.mergeBranches({
        source_ref: mr.source_sha,
        target_branch: mr.target,
        expected_target_sha: mr.target_sha,
        strategy: body.strategy || "ff_prefer",
        squash: !!body.squash,
        commit_message: "Merge !" + mr.id + ": " + mr.title,
        author: {
          name: request.headers.get("x-actor") || "OneStorage",
          email: "merge@onestorage.invalid",
        },
      });
      if (result.result === "no_op") {
        const gate = await reviewGate(this.env, metadata, mr, store);
        if (!gate.allowed) fail(409, gate.reasons.join("; "));
        await publication.put("refs.v2", refs);
      }
      await projectMerge(this.env, id, mr.id, {
        sha: result.sha,
        issue_ids: reviewedMerge.issue_ids,
        actor_id: body.actor_id,
      });
      await this.ctx.storage.delete("merge-projection:" + mr.id);
      return Response.json(result);
    }
    const life = await lifecycle(request, repo, this.env, this.ctx.storage);
    if (life) return life;
    if (metadata?.sync_status === "initializing")
      fail(409, "Repository initialization is in progress");
    const q = Object.fromEntries(url.searchParams),
      page = { limit: q.limit, cursor: q.cursor };
    const sharedRead = await repositoryRead(
      repo,
      request,
      defaultBranch,
      new BrowseCache(this.ctx.storage),
    );
    if (sharedRead) return sharedRead;
    if (request.method === "GET") {
      switch (path) {
        case "/files":
        case "/files/metadata":
          return Response.json(
            await repo.listFiles({
              ...page,
              ref: q.ref,
              path: q.path,
              recursive: q.recursive !== "false",
              metadata: path.endsWith("metadata"),
            }),
          );
        case "/diff":
          return Response.json(
            await repo.diff(q.sha || q.ref || "HEAD", q.base, {
              paths: url.searchParams.getAll("path"),
            }),
          );
        case "/branches/diff":
          return Response.json(
            await repo.diffBranches(
              q.branch || q.source || "HEAD",
              q.base || q.target || defaultBranch,
              url.searchParams.getAll("path"),
            ),
          );
        case "/notes":
          return Response.json(
            await repo.getNote(q.sha || "", q.notes_ref || q.ref),
          );
        case "/notes/refs": {
          const list = Object.entries(repo.refs)
              .filter(([ref]) => ref.startsWith(q.prefix || "refs/notes/"))
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([ref, sha]) => ({ ref, sha })),
            p = paginate(list, page, JSON.stringify(list));
          return Response.json({
            refs: p.items,
            has_more: p.has_more,
            next_cursor: p.next_cursor,
          });
        }
        case "/blame":
          return Response.json(
            await repo.blame({
              ref: q.ref,
              path: q.path || "",
              range: [
                ...url.searchParams.getAll("range"),
                ...url.searchParams.getAll("ranges"),
              ],
              detect_moves: q.detect_moves !== "false",
            }),
          );
        case "/merge/preview": {
          const p = await select(
            q.target_is_ephemeral === "true" || ephemeral,
          ).previewMerge({
            source_ref: q.source_ref || q.source_branch,
            target_branch: q.target_branch,
            source_is_ephemeral: q.source_is_ephemeral === "true",
            include_content: q.include_content === "true",
            allow_unrelated_histories: q.allow_unrelated_histories === "true",
          });
          const { merged, ...result } = p;
          return Response.json(result);
        }
      }
    }
    if (
      request.method === "POST" &&
      [
        "/commit-pack",
        "/diff-commit",
        "/restore-commit",
        "/reset-commits",
      ].includes(path)
    ) {
      const kind =
          path === "/commit-pack"
            ? "files"
            : path === "/diff-commit"
              ? "diff"
              : "restore",
        parsed = await parseCommitStream(request, store, kind),
        target = select(parsed.metadata.ephemeral === true || ephemeral);
      if (kind === "files")
        return Response.json(await target.commitFiles(parsed.metadata), {
          status: 201,
        });
      if (kind === "diff")
        return Response.json(
          await applyGitPatch(target, parsed.metadata, parsed.diff!),
          { status: 201 },
        );
      return Response.json(await target.restore(parsed.metadata), {
        status: 201,
      });
    }
    if (
      ["POST", "DELETE"].includes(request.method) &&
      [
        "/branches/create",
        "/branches/delete",
        "/tags/create",
        "/tags/delete",
        "/notes/write",
        "/grep",
        "/archive",
        "/merge-advanced",
        "/commit-files",
      ].includes(path)
    ) {
      let body;
      try {
        body = JSON.parse(text(await boundedBody(request, 12 * 1024 * 1024)));
      } catch (e) {
        if (e instanceof HTTPException) throw e;
        fail(400, "Invalid JSON");
      }
      const target = select(
        body.ephemeral === true ||
          body.target_is_ephemeral === true ||
          ephemeral,
      );
      switch (path) {
        case "/branches/create":
          return Response.json(await target.createBranch(body), {
            status: 201,
          });
        case "/branches/delete":
          return Response.json(
            await target.deleteBranch(
              body.branch || body.name,
              body.expected_sha,
            ),
          );
        case "/tags/create":
          return Response.json(
            await target.createTag(body.name, body.ref || body.sha),
            { status: 201 },
          );
        case "/tags/delete":
          return Response.json(await target.deleteTag(body.name));
        case "/notes/write":
          return Response.json(await target.writeNote(body), {
            status: body.operation === "delete" ? 200 : 201,
          });
        case "/grep":
          return Response.json(await target.grep(body));
        case "/archive":
          return target.archive(body);
        case "/merge-advanced":
          return Response.json(await target.mergeBranches(body));
        case "/commit-files":
          return Response.json(await target.commitFiles(body), { status: 201 });
      }
    }
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
    if (path === "/git/git-receive-pack" && request.method === "POST") {
      // Check before ingestion and before a possible upstream push. The request
      // gate serializes writers through atomic publication.
      await assertGitReceiptCapacity(this.ctx.storage);
      return receiveStream(repo, request, this.env.OBJECTS, this.ctx.storage);
    }
    if (path === "/git/git-upload-pack" && request.method === "POST") {
      const packCache = new PackCache(id, this.env.OBJECTS, this.ctx.storage);
      const response = await upload(
        repo,
        await boundedBody(request, 1024 * 1024),
        packCache,
      );
      const completion = responseCompletion(response);
      if (completion)
        this.ctx.waitUntil(
          completion.then(() => {
            console.info("Git transfer drained", {
              repoId: id,
              ...store.ioUsage,
              packCache: packCache.metrics,
            });
          }),
        );
      return response;
    }
    if (request.method === "GET") {
      const ref = url.searchParams.get("ref") || "HEAD",
        file = url.searchParams.get("path") || "";
      switch (path) {
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
