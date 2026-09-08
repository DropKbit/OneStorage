import type { Env, Repo } from "./types";
import type { CIRun } from "./ci";
import { variableSelectionSchema } from "./ci-variable-schema";
import { seal, unseal } from "./sync-config";
import { fail } from "./security";
import { secretPatterns, redactChunks, redact } from "./ci-redaction";
interface Variable {
  id: string;
  repo_id: string;
  owner_id: string;
  key: string;
  environment: string;
  encrypted: string;
  secret: number;
  protected: number;
  refs: string;
  revision: number;
  available?: number;
}
interface Bound {
  run_id: string;
  variable_id: string;
  key: string;
  revision: number;
  encrypted: string;
  secret: number;
  protected: number;
}
export const variableContext = (repo: string, id: string) =>
  "ci-variable:" + repo + ":" + id;
const bindingContext = (run: string, key: string) =>
  "ci-run-variable:" + run + ":" + key;
export const variableLive = `EXISTS(SELECT 1 FROM ci_runs c JOIN repositories r ON r.id=c.repo_id WHERE c.id=? AND c.status='running' AND c.lease_hash=? AND c.lease_until>? AND r.deleted_at IS NULL AND r.archived_at IS NULL)`;
export async function assertVariablesActive(env: Env, run: CIRun) {
  const current = await env.DB.prepare(
    `SELECT id FROM ci_runs WHERE id=? AND ${variableLive} AND NOT EXISTS(SELECT 1 FROM ci_run_variables b WHERE b.run_id=ci_runs.id AND NOT EXISTS(SELECT 1 FROM ci_authorized_variables v WHERE v.id=b.variable_id AND v.revision=b.revision AND (v.protected=0 OR EXISTS(SELECT 1 FROM branch_protections p WHERE p.repo_id=ci_runs.repo_id AND p.branch=ci_runs.ref AND p.require_mr=1))))`,
  )
    .bind(run.id, run.id, run.lease_hash, Date.now())
    .first();
  if (!current) fail(409, "CI variable authorization or run lease changed");
}
export async function loadRunVariables(env: Env, run: CIRun) {
  const config = variableSelectionSchema.parse(JSON.parse(run.config)),
    keys = config.variables || [];
  if (!keys.length)
    return {
      variables: {} as Record<string, string>,
      patterns: [] as string[],
    };
  await assertVariablesActive(env, run);
  let bound = (
    await env.DB.prepare("SELECT * FROM ci_run_variables WHERE run_id=?")
      .bind(run.id)
      .all<Bound>()
  ).results;
  if (!bound.length) {
    const environment =
      config.environment || config.deploy?.environment || "default";
    const rows = (
      await env.DB.prepare(
        `SELECT v.*,EXISTS(SELECT 1 FROM ci_authorized_variables a WHERE a.id=v.id) AS available FROM ci_variables v WHERE repo_id=? AND key IN(SELECT value FROM json_each(?)) AND environment IN('*',?) ORDER BY CASE WHEN environment=? THEN 0 ELSE 1 END`,
      )
        .bind(run.repo_id, JSON.stringify(keys), environment, environment)
        .all<Variable>()
    ).results;
    const selected = keys.map((key) => {
      const v = rows.find((v) => v.key === key);
      if (!v || !v.available) fail(409, "CI variable unavailable: " + key);
      return v;
    });
    const trigger =
      (run as CIRun & { source_trigger?: string }).source_trigger || "unknown";
    const trusted = ["manual", "push", "schedule"].includes(trigger);
    if (selected.some((v) => v.secret || v.protected) && !trusted)
      fail(
        403,
        "Secrets and protected variables are unavailable to merge-request or unclassified runs",
      );
    for (const v of selected) {
      const refs = JSON.parse(v.refs) as string[];
      if (!refs.includes("*") && !refs.includes(run.ref))
        fail(403, "CI variable branch scope denied: " + v.key);
    }
    if (selected.some((v) => v.secret || v.protected)) {
      const repo = await env.DB.prepare("SELECT * FROM repositories WHERE id=?")
        .bind(run.repo_id)
        .first<Repo>();
      if (!repo) fail(409, "Repository unavailable");
      const response = await env.REPOSITORIES.get(
        env.REPOSITORIES.idFromName(repo.id),
      ).fetch(
        new Request(
          "http://repository/branch?branch=" + encodeURIComponent(run.ref),
          {
            headers: {
              "x-repo-id": repo.id,
              "x-default-branch": repo.default_branch,
              "x-lifecycle-revision": String(repo.lifecycle_revision || 0),
            },
          },
        ),
      );
      if (!response.ok) {
        await response.body?.cancel();
        fail(403, "Secret variables require a current branch commit");
      }
      const data = (await response.json()) as { sha: string };
      if (data.sha !== run.sha)
        fail(
          403,
          "Secret variables require the current branch commit; start a new run",
        );
    }
    const statements: D1PreparedStatement[] = [];
    let bytes = 0;
    for (const v of selected) {
      const value = await unseal<string>(
        env,
        variableContext(run.repo_id, v.id),
        v.encrypted,
      );
      bytes += new TextEncoder().encode(value).length;
      if (bytes > 65536) fail(413, "CI variables exceed 64 KiB");
      const encrypted = await seal(env, bindingContext(run.id, v.key), value);
      statements.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO ci_run_variables(run_id,variable_id,key,revision,encrypted,secret,protected) SELECT ?,?,?,?,?,?,? WHERE ${variableLive} AND EXISTS(SELECT 1 FROM ci_authorized_variables v WHERE v.id=? AND v.revision=? AND (v.protected=0 OR EXISTS(SELECT 1 FROM branch_protections p WHERE p.repo_id=v.repo_id AND p.branch=? AND p.require_mr=1)))`,
        ).bind(
          run.id,
          v.id,
          v.key,
          v.revision,
          encrypted,
          v.secret,
          v.protected,
          run.id,
          run.lease_hash,
          Date.now(),
          v.id,
          v.revision,
          run.ref,
        ),
      );
    }
    // All values must freeze together; a concurrent edit/revocation rolls back every binding.
    const guard = crypto.randomUUID();
    statements.push(
      env.DB.prepare(
        `INSERT INTO mutation_guards(id,accepted) SELECT ?,CASE WHEN (SELECT COUNT(*) FROM ci_run_variables WHERE run_id=?)=? THEN 1 ELSE 0 END`,
      ).bind(guard, run.id, keys.length),
      env.DB.prepare("DELETE FROM mutation_guards WHERE id=?").bind(guard),
    );
    try {
      await env.DB.batch(statements);
    } catch (e) {
      if (e instanceof Error && /CHECK constraint/.test(e.message))
        fail(409, "CI variable permissions or protection changed");
      throw e;
    }
    bound = (
      await env.DB.prepare("SELECT * FROM ci_run_variables WHERE run_id=?")
        .bind(run.id)
        .all<Bound>()
    ).results;
  }
  if (bound.length !== keys.length || bound.some((v) => !keys.includes(v.key)))
    fail(409, "CI variable binding mismatch");
  const variables: Record<string, string> = Object.create(null),
    secretValues: string[] = [];
  for (const b of bound) {
    const value = await unseal<string>(
      env,
      bindingContext(run.id, b.key),
      b.encrypted,
    );
    variables[b.key] = value;
    if (b.secret) secretValues.push(value);
  }
  await assertVariablesActive(env, run);
  return { variables, patterns: secretPatterns(secretValues) };
}
/** Historical snapshots remain encrypted for masking after rotation/deletion; never returned in APIs. */
export async function runSecretPatterns(env: Env, runId: string) {
  const rows = (
    await env.DB.prepare(
      "SELECT * FROM ci_run_variables WHERE run_id=? AND secret=1",
    )
      .bind(runId)
      .all<Bound>()
  ).results;
  const values = [];
  for (const b of rows)
    values.push(
      await unseal<string>(env, bindingContext(runId, b.key), b.encrypted),
    );
  return secretPatterns(values);
}
export async function maskRunLog(env: Env, runId: string, content: string) {
  return redact(content, await runSecretPatterns(env, runId));
}
export async function maskLogRows(
  env: Env,
  runId: string,
  rows: Array<{ seq: number; content: string }>,
) {
  const parts = redactChunks(
    rows.map((r) => r.content),
    await runSecretPatterns(env, runId),
  );
  return rows.map((r, i) => ({ ...r, content: parts[i] }));
}
