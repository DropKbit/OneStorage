/** Seven reusable agent workflows. All writes are real Git objects and guarded ref updates. */
import type { RepositoryClient } from "../sdk/index";
const author = { name: "OneStorage Agent", email: "agent@onestorage.invalid" };
const task = () => crypto.randomUUID().slice(0, 12);
async function head(repo: RepositoryClient) {
  const project = await repo.get(),
    branch = await repo.getBranch(project.default_branch);
  return { branch: project.default_branch, sha: branch.sha as string };
}
/** 1. Store observations as versioned Git Notes without editing source files. */
export async function memory(repo: RepositoryClient) {
  const current = await head(repo);
  await repo.appendNote(
    current.sha,
    JSON.stringify({
      kind: "memory",
      at: new Date().toISOString(),
      observation: "Baseline inspected",
    }),
    { notes_ref: "refs/notes/agent-memory" },
  );
  return repo.getNote(current.sha, "refs/notes/agent-memory");
}
/** 2. Isolate a resumable session in an ephemeral branch with structured state. */
export async function sessions(repo: RepositoryClient) {
  const current = await head(repo),
    branch = "sessions/" + task();
  const commit = await repo
    .createCommit({
      target_branch: branch,
      base_ref: current.sha,
      ephemeral: true,
      expected_target_sha: null,
      commit_message: "Start agent session",
      author,
    })
    .addFileFromString(
      ".agent/session.json",
      JSON.stringify({ stage: "planning", baseline: current.sha }, null, 2) +
        "\n",
    )
    .send();
  return {
    branch,
    commit,
    state: await (
      await repo.getFile(".agent/session.json", {
        ref: branch,
        ephemeral: true,
      })
    ).json(),
  };
}
/** 3. Restore a checkpoint with a new commit; the previous history remains reachable. */
export async function checkpoints(repo: RepositoryClient) {
  const current = await head(repo),
    branch = "checkpoints/" + task();
  await repo.createBranch({
    target_branch: branch,
    base_ref: current.sha,
    ephemeral: true,
  });
  const changed = await repo
    .createCommit({
      target_branch: branch,
      ephemeral: true,
      expected_target_sha: current.sha,
      commit_message: "Trial change",
      author,
    })
    .addFileFromString(".agent/trial.txt", "temporary experiment\n")
    .send();
  const restored = await repo.restoreCommit({
    target_branch: branch,
    ephemeral: true,
    expected_target_sha: changed.sha,
    base_ref: current.sha,
    commit_message: "Restore checkpoint",
    author,
  });
  return {
    branch,
    checkpoint: current.sha,
    trial: changed.sha,
    restored: restored.sha,
  };
}
/** 4. Observe each immutable version and diff it against the previous version. */
export async function* liveDiff(
  repo: RepositoryClient,
  {
    branch = "main",
    pollMs = 2000,
    signal,
    iterations = 10,
  }: {
    branch?: string;
    pollMs?: number;
    signal?: AbortSignal;
    iterations?: number;
  } = {},
) {
  let previous = (await repo.getBranch(branch)).sha;
  for (let i = 0; i < iterations && !signal?.aborted; i++) {
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, pollMs);
      signal?.addEventListener("abort", done, { once: true });
    });
    if (signal?.aborted) break;
    const next = (await repo.getBranch(branch)).sha;
    if (next === previous) continue;
    yield await repo.getDiff({ ref: next, base: previous });
    previous = next;
  }
}
/** 5. Version product documents and binary assets together in one commit. */
export async function productFiles(repo: RepositoryClient) {
  const current = await head(repo),
    branch = "products/" + task();
  const commit = await repo
    .createCommit({
      target_branch: branch,
      ephemeral: true,
      base_ref: current.sha,
      expected_target_sha: null,
      commit_message: "Version product files",
      author,
    })
    .addFileFromString(
      "product/spec.md",
      "# Product revision\n\nA document and an asset committed together.\n",
    )
    .addFile("product/sample.bin", Uint8Array.of(0, 1, 2, 255))
    .send();
  return {
    branch,
    commit,
    files: await repo.listFiles({
      ref: branch,
      ephemeral: true,
      path: "product",
      metadata: true,
    }),
  };
}
/** 6. Run isolated attempts, preview the selected candidate, publish with CAS. */
export async function parallelAttempts(repo: RepositoryClient) {
  const current = await head(repo),
    prefix = "attempts/" + task();
  const results = await Promise.all(
    ["a", "b", "c"].map(async (variant) => {
      const branch = prefix + "/" + variant;
      const commit = await repo
        .createCommit({
          target_branch: branch,
          ephemeral: true,
          base_ref: current.sha,
          expected_target_sha: null,
          commit_message: "Agent attempt " + variant,
          author,
        })
        .addFileFromString(
          ".agent/result.json",
          JSON.stringify({ variant }) + "\n",
        )
        .send();
      return { branch, sha: commit.sha };
    }),
  );
  const chosen = results[0];
  const preview = await repo.previewMerge({
    source_ref: chosen.sha,
    source_is_ephemeral: true,
    target_branch: current.branch,
  });
  if (preview.status !== "clean") return { results, preview };
  const merged = await repo.mergeBranches({
    source_ref: chosen.sha,
    source_is_ephemeral: true,
    target_branch: current.branch,
    expected_target_sha: current.sha,
    strategy: "ff_prefer",
    commit_message: "Publish selected attempt",
    author,
  });
  return { results, preview, merged };
}
/** 7. Read paths, diffs and attribution, then persist a machine-readable review note. */
export async function review(repo: RepositoryClient) {
  const current = await head(repo),
    diff = await repo.getDiff({ ref: current.sha }),
    files = await repo.listFiles({ ref: current.sha });
  const report = {
    commit: current.sha,
    changed_files: diff.stats.files,
    tracked_files: files.files.length,
    generated_at: new Date().toISOString(),
  };
  await repo.appendNote(current.sha, JSON.stringify(report), {
    notes_ref: "refs/notes/agent-review",
  });
  return report;
}
