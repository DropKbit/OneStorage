import {
  deployAccessSQL,
  deployAccessArgs,
  type DeployToken,
} from "./deploy-tokens";
import type { Env, Repo } from "./types";
import { fail } from "./security";
import { unguardDatabase } from "./project-db";
import { z } from "zod";
import {
  genericSpec,
  packageName,
  npmVersion,
  npmTag,
  npmFile,
  PACKAGE_LIMIT,
  type PackageSpec,
} from "./package-schema";
export interface PackageActor {
  id: string;
  credential: string;
  revision: number;
  deploy?: DeployToken;
}
const roles = (maintain = false) =>
  maintain ? "'maintainer','owner'" : "'developer','maintainer','owner'";
export const packageAuthority = (maintain = false, actor?: PackageActor) =>
  actor?.deploy
    ? deployAccessSQL(true)
    : `EXISTS(SELECT 1 FROM repositories r JOIN users u ON u.id=? JOIN credentials c ON c.user_id=u.id WHERE r.id=? AND r.lifecycle_revision=? AND r.deleted_at IS NULL AND r.archived_at IS NULL AND u.disabled=0 AND c.hash=? AND c.scope='write' AND c.kind IN('session','pat') AND c.expires_at>? AND ((r.workspace_id IS NULL AND r.owner_id=u.id) OR EXISTS(SELECT 1 FROM members m WHERE m.repo_id=r.id AND m.user_id=u.id AND m.role IN(${roles(maintain)})) OR EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=r.workspace_id AND m.user_id=u.id AND m.role IN(${roles(maintain)}))))`;
export const packageAuthorityArgs = (
  repo: Repo,
  actor: PackageActor,
  maintain = false,
) =>
  actor.deploy
    ? deployAccessArgs(
        { ...repo, lifecycle_revision: actor.revision },
        actor.deploy,
        maintain ? "delete_package_registry" : "write_package_registry",
      )
    : [actor.id, repo.id, actor.revision, actor.credential, Date.now()];
export async function packageMutation(
  env: Env,
  repo: Repo,
  actor: PackageActor,
  statements: D1PreparedStatement[],
  action: string,
  detail: unknown,
  maintain = false,
) {
  const db = unguardDatabase(env.DB),
    guard = crypto.randomUUID();
  try {
    return await db.batch([
      db
        .prepare(
          `INSERT INTO mutation_guards(id,accepted) SELECT ?,CASE WHEN ${packageAuthority(maintain, actor)} THEN 1 ELSE 0 END`,
        )
        .bind(guard, ...packageAuthorityArgs(repo, actor, maintain)),
      ...statements,
      db
        .prepare(
          "INSERT INTO audit(repo_id,actor_id,action,detail) VALUES(?,?,?,?)",
        )
        .bind(
          repo.id,
          actor.deploy ? null : actor.id,
          action,
          JSON.stringify(
            actor.deploy
              ? {
                  deploy_token_id: actor.deploy.id,
                  deploy_token_username: actor.deploy.username,
                  detail,
                }
              : detail,
          ),
        ),
      db.prepare("DELETE FROM mutation_guards WHERE id=?").bind(guard),
    ]);
  } catch (e) {
    if (
      e instanceof Error &&
      /CHECK constraint|UNIQUE constraint/.test(e.message)
    )
      fail(409, "Package version, quota or current authorization changed");
    throw e;
  }
}
/** Immutable upload ownership is journaled before R2 I/O, then metadata becomes visible atomically. */
export async function publishPackage(
  env: Env,
  repo: Repo,
  actor: PackageActor,
  spec: PackageSpec,
  put: (key: string) => Promise<unknown>,
) {
  if (spec.kind === "generic") genericSpec.parse(spec);
  else {
    packageName.parse(spec.name);
    npmVersion.parse(spec.version);
    npmFile.parse(spec.filename);
    if (spec.filename !== `${spec.name.split("/").at(-1)}-${spec.version}.tgz`)
      fail(400, "Noncanonical npm filename");
    z.number().int().min(1).max(PACKAGE_LIMIT.npm).parse(spec.size);
    z.string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(spec.sha256);
    z.array(npmTag).min(1).max(32).parse(spec.tags);
  }
  const db = unguardDatabase(env.DB),
    id = crypto.randomUUID(),
    versionId = crypto.randomUUID(),
    objectKey = `packages/${repo.id}/${id}`,
    now = Date.now(),
    metadata = JSON.stringify(spec.metadata || {});
  const metadataBytes = new TextEncoder().encode(metadata).length;
  if (metadataBytes > PACKAGE_LIMIT.metadata)
    fail(413, "Package metadata exceeds 64 KiB");
  const reserved = await db
    .prepare(
      `INSERT INTO package_uploads(id,repo_id,kind,name,version,filename,object_key,size,state,created_at,expires_at) SELECT ?,?,?,?,?,?,?,?,'uploading',?,? WHERE ${packageAuthority(false, actor)} AND NOT EXISTS(SELECT 1 FROM package_versions v LEFT JOIN package_files f ON f.version_id=v.id WHERE v.repo_id=? AND v.kind=? AND v.name=? AND v.version=? AND (v.deleted_at IS NOT NULL OR ?='npm' OR f.filename=?)) AND (SELECT count(*) FROM package_files f JOIN package_versions v ON v.id=f.version_id WHERE v.repo_id=? AND f.deleted_at IS NULL)+(SELECT count(*) FROM package_uploads WHERE repo_id=? AND state='uploading')<? AND COALESCE((SELECT SUM(f.size) FROM package_files f JOIN package_versions v ON v.id=f.version_id WHERE v.repo_id=? AND f.deleted_at IS NULL),0)+COALESCE((SELECT SUM(size) FROM package_uploads WHERE repo_id=? AND state='uploading'),0)+?<=?`,
    )
    .bind(
      id,
      repo.id,
      spec.kind,
      spec.name,
      spec.version,
      spec.filename,
      objectKey,
      spec.size,
      now,
      now + PACKAGE_LIMIT.reservationMs,
      ...packageAuthorityArgs(repo, actor),
      repo.id,
      spec.kind,
      spec.name,
      spec.version,
      spec.kind,
      spec.filename,
      repo.id,
      repo.id,
      PACKAGE_LIMIT.files,
      repo.id,
      repo.id,
      spec.size,
      PACKAGE_LIMIT.quota,
    )
    .run()
    .catch((e) => {
      if (/UNIQUE constraint/.test(String(e)))
        fail(409, "Package upload already reserved");
      throw e;
    });
  if (!reserved.meta.changes)
    fail(409, "Package exists, quota reached or authorization changed");
  try {
    await put(objectKey);
    const guard = crypto.randomUUID(),
      statements = [
        db
          .prepare(
            `INSERT INTO mutation_guards(id,accepted) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM package_uploads WHERE id=? AND state='uploading' AND expires_at>?) AND NOT EXISTS(SELECT 1 FROM package_versions v WHERE v.repo_id=? AND v.kind=? AND v.name=? AND v.version=? AND (v.deleted_at IS NOT NULL OR ?='npm')) AND (EXISTS(SELECT 1 FROM package_versions WHERE repo_id=? AND kind=? AND name=? AND version=?) OR ((SELECT count(*) FROM package_versions WHERE repo_id=? AND deleted_at IS NULL)<? AND (SELECT count(*) FROM package_versions WHERE repo_id=? AND kind=? AND name=? AND deleted_at IS NULL)<?)) AND COALESCE((SELECT SUM(length(CAST(metadata AS BLOB))) FROM package_versions WHERE repo_id=? AND kind=? AND name=? AND deleted_at IS NULL),0)+?<=? THEN 1 ELSE 0 END`,
          )
          .bind(
            guard,
            id,
            Date.now(),
            repo.id,
            spec.kind,
            spec.name,
            spec.version,
            spec.kind,
            repo.id,
            spec.kind,
            spec.name,
            spec.version,
            repo.id,
            PACKAGE_LIMIT.versions,
            repo.id,
            spec.kind,
            spec.name,
            PACKAGE_LIMIT.npmVersions,
            repo.id,
            spec.kind,
            spec.name,
            metadataBytes,
            PACKAGE_LIMIT.manifestTotal,
          ),
        db
          .prepare(
            "INSERT OR IGNORE INTO package_versions(id,repo_id,kind,name,version,metadata,publisher_id,created_at,deploy_token_id,publisher_label) VALUES(?,?,?,?,?,?,?,?,?,?)",
          )
          .bind(
            versionId,
            repo.id,
            spec.kind,
            spec.name,
            spec.version,
            metadata,
            actor.id,
            now,
            actor.deploy?.id || null,
            actor.deploy ? "Deploy token: " + actor.deploy.username : null,
          ),
        db
          .prepare(
            "INSERT INTO package_files(id,version_id,filename,object_key,size,sha256,sha512,sha1,created_at) SELECT ?,id,?,?,?,?,?,?,? FROM package_versions WHERE repo_id=? AND kind=? AND name=? AND version=? AND deleted_at IS NULL",
          )
          .bind(
            id,
            spec.filename,
            objectKey,
            spec.size,
            spec.sha256,
            spec.sha512 || null,
            spec.sha1 || null,
            now,
            repo.id,
            spec.kind,
            spec.name,
            spec.version,
          ),
        db
          .prepare(
            "UPDATE package_uploads SET state='published' WHERE id=? AND state='uploading'",
          )
          .bind(id),
        ...(spec.tags || []).map((tag) =>
          db
            .prepare(
              "INSERT INTO package_tags(repo_id,name,tag,version_id) SELECT ?,?,?,id FROM package_versions WHERE repo_id=? AND kind='npm' AND name=? AND version=? AND deleted_at IS NULL ON CONFLICT(repo_id,name,tag) DO UPDATE SET version_id=excluded.version_id,revision=package_tags.revision+1",
            )
            .bind(repo.id, spec.name, tag, repo.id, spec.name, spec.version),
        ),
        db
          .prepare(
            "UPDATE mutation_guards SET accepted=CASE WHEN (SELECT count(*) FROM package_tags WHERE repo_id=? AND name=?)<=32 THEN 1 ELSE 0 END WHERE id=?",
          )
          .bind(repo.id, spec.name, guard),
        db.prepare("DELETE FROM mutation_guards WHERE id=?").bind(guard),
      ];
    await packageMutation(env, repo, actor, statements, "package.publish", {
      kind: spec.kind,
      name: spec.name,
      version: spec.version,
      filename: spec.filename,
      sha256: spec.sha256,
    });
  } catch (e) {
    // A lost D1 response may follow a committed transaction. Never delete visible data.
    const file = await db
      .prepare("SELECT id FROM package_files WHERE id=?")
      .bind(id)
      .first();
    if (!file) {
      await db
        .prepare(
          "UPDATE package_uploads SET state='retired',retire_after=? WHERE id=? AND state='uploading'",
        )
        .bind(Date.now(), id)
        .run();
      await env.OBJECTS.delete(objectKey);
      await db
        .prepare("DELETE FROM package_uploads WHERE id=? AND state='retired'")
        .bind(id)
        .run();
      throw e;
    }
  }
  const result = await db
    .prepare(
      "SELECT f.id,f.version_id,f.filename,f.size,f.sha256,f.sha512,f.sha1,v.kind,v.name,v.version FROM package_files f JOIN package_versions v ON v.id=f.version_id WHERE f.id=? AND f.deleted_at IS NULL AND v.deleted_at IS NULL",
    )
    .bind(id)
    .first();
  if (!result) fail(409, "Package was retired during publication");
  return result;
}
export async function collectPackages(env: Env, repoId?: string) {
  const db = unguardDatabase(env.DB),
    now = Date.now();
  const rows = (
    await db
      .prepare(
        `SELECT * FROM package_uploads u WHERE (? IS NULL OR repo_id=?) AND (state='retired' OR (state='uploading' AND expires_at<?) OR (state='published' AND NOT EXISTS(SELECT 1 FROM package_files f JOIN package_versions v ON v.id=f.version_id JOIN repositories r ON r.id=v.repo_id WHERE f.id=u.id AND f.deleted_at IS NULL AND v.deleted_at IS NULL AND r.deleted_at IS NULL))) ORDER BY last_gc,created_at LIMIT 100`,
      )
      .bind(repoId || null, repoId || null, now)
      .all<{
        id: string;
        object_key: string;
        state: string;
        expires_at: number;
        retire_after: number | null;
      }>()
  ).results;
  for (const row of rows) {
    const changed = await db
      .prepare(
        `UPDATE package_uploads SET state='retired',retire_after=COALESCE(retire_after,?),last_gc=? WHERE id=? AND NOT EXISTS(SELECT 1 FROM package_files f JOIN package_versions v ON v.id=f.version_id JOIN repositories r ON r.id=v.repo_id WHERE f.id=package_uploads.id AND f.deleted_at IS NULL AND v.deleted_at IS NULL AND r.deleted_at IS NULL)`,
      )
      .bind(
        row.state === "uploading"
          ? Math.max(now, row.expires_at) + PACKAGE_LIMIT.gcRetentionMs
          : now,
        now,
        row.id,
      )
      .run();
    if (!changed.meta.changes) continue;
    await env.OBJECTS.delete(row.object_key);
    await db
      .prepare(
        "DELETE FROM package_uploads WHERE id=? AND state='retired' AND retire_after<=?",
      )
      .bind(row.id, now)
      .run();
  }
}
