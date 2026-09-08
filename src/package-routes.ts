import type { Context, Hono } from "hono";
import { z } from "zod";
import type { App, Repo } from "./types";
import { fail, boundedBody } from "./security";
import { unguardDatabase } from "./project-db";
import { packageMutation, publishPackage, type PackageActor } from "./packages";
import {
  genericSpec,
  genericPart,
  npmFile,
  packageName,
  npmTag,
  npmVersion,
  PACKAGE_LIMIT,
} from "./package-schema";
import { parseNpmPublish } from "./npm-package";
const record = z.record(z.string(), z.unknown());
const actor = (c: Context<App>, r: Repo): PackageActor => ({
  id: c.get("user")?.id || fail(401, "Sign in required"),
  credential:
    c.get("credential") ||
    fail(401, "Session or personal access token required"),
  revision: r.lifecycle_revision || 0,
});
async function readAuthority(c: Context<App>, r: Repo) {
  const user = c.get("user"),
    credential = c.get("credential");
  const allowed = await unguardDatabase(c.env.DB)
    .prepare(
      `SELECT r.id FROM repositories r WHERE r.id=? AND r.lifecycle_revision=? AND r.deleted_at IS NULL AND (? IS NULL OR EXISTS(SELECT 1 FROM credentials c JOIN users u ON u.id=c.user_id WHERE u.id=? AND u.disabled=0 AND c.hash=? AND c.expires_at>? AND c.kind IN('session','pat'))) AND (r.visibility='public' OR (r.workspace_id IS NULL AND r.owner_id=?) OR EXISTS(SELECT 1 FROM members WHERE repo_id=r.id AND user_id=?) OR EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=r.workspace_id AND user_id=?))`,
    )
    .bind(
      r.id,
      r.lifecycle_revision || 0,
      credential,
      user?.id || null,
      credential,
      Date.now(),
      user?.id || null,
      user?.id || null,
      user?.id || null,
    )
    .first();
  if (!allowed) fail(404, "Package not found or access changed");
}
async function json(
  c: Context<App>,
  limit = PACKAGE_LIMIT.manifestTotal + 131072,
) {
  const bytes = await boundedBody(c.req.raw, limit);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    fail(400, "Invalid package JSON");
  }
}
function registry(c: Context<App>, r: Repo) {
  return `${c.env.APP_ORIGIN}/api/repos/${r.namespace}/${encodeURIComponent(r.name)}/packages/npm/`;
}
async function gc(c: Context<App>, r: Repo) {
  try {
    await c.env.EVENTS?.send({ id: "package-gc:" + r.id });
  } catch {
    /* The durable journal is also collected by Cron. */
  }
}
async function packument(c: Context<App>, r: Repo, name: string) {
  const db = c.env.DB;
  const rows = await db.batch([
    db
      .prepare(
        "SELECT v.version,v.metadata,v.created_at,f.filename,f.sha1,f.sha512,f.size FROM package_versions v JOIN package_files f ON f.version_id=v.id WHERE v.repo_id=? AND v.kind='npm' AND v.name=? AND v.deleted_at IS NULL AND f.deleted_at IS NULL ORDER BY v.created_at,v.id",
      )
      .bind(r.id, name),
    db
      .prepare(
        "SELECT t.tag,v.version FROM package_tags t JOIN package_versions v ON v.id=t.version_id WHERE t.repo_id=? AND t.name=? AND v.deleted_at IS NULL",
      )
      .bind(r.id, name),
    db
      .prepare(
        "SELECT revision FROM package_catalog WHERE repo_id=? AND name=?",
      )
      .bind(r.id, name),
  ]);
  if (!rows[0].results.length) fail(404, "npm package not found");
  const versions: Record<string, unknown> = Object.create(null),
    times: Record<string, string> = Object.create(null),
    tags = Object.fromEntries(
      rows[1].results.map((x: any) => [x.tag, x.version]),
    );
  for (const v of rows[0].results as any[]) {
    versions[v.version] = {
      ...JSON.parse(v.metadata),
      name,
      version: v.version,
      _id: `${name}@${v.version}`,
      dist: {
        tarball:
          registry(c, r) +
          encodeURIComponent(name) +
          "/-/" +
          encodeURIComponent(v.filename),
        shasum: v.sha1,
        integrity: "sha512-" + v.sha512,
        unpackedSize: undefined,
      },
    };
    times[v.version] = new Date(v.created_at).toISOString();
  }
  await readAuthority(c, r);
  return {
    _id: name,
    name,
    _rev: String((rows[2].results[0] as any).revision),
    "dist-tags": tags,
    versions,
    time: times,
  };
}
async function download(
  c: Context<App>,
  r: Repo,
  kind: string,
  name: string,
  version: string | null,
  filename: string,
) {
  const f = await c.env.DB.prepare(
    "SELECT f.* FROM package_files f JOIN package_versions v ON v.id=f.version_id WHERE v.repo_id=? AND v.kind=? AND v.name=? AND (? IS NULL OR v.version=?) AND f.filename=? AND f.deleted_at IS NULL AND v.deleted_at IS NULL",
  )
    .bind(r.id, kind, name, version, version, filename)
    .first<any>();
  if (!f) fail(404, "Package file not found");
  const etag = '"' + f.sha256 + '"',
    headers = new Headers({
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${f.filename}"`,
      "cache-control": "private, no-store",
      "accept-ranges": "bytes",
      etag: etag,
      "x-package-sha256": f.sha256,
    });
  let range: { offset: number; length: number } | undefined;
  const requested = c.req.header("range"),
    ifRange = c.req.header("if-range");
  if (requested && (!ifRange || ifRange === etag)) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(requested);
    let start = 0,
      end = f.size - 1;
    if (!match || (!match[1] && !match[2])) {
      await readAuthority(c, r);
      headers.set("content-range", `bytes */${f.size}`);
      return new Response(null, { status: 416, headers });
    }
    if (!match[1]) start = Math.max(0, f.size - Number(match[2]));
    else {
      start = Number(match[1]);
      if (match[2]) end = Math.min(end, Number(match[2]));
    }
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      start >= f.size ||
      end < start
    ) {
      await readAuthority(c, r);
      headers.set("content-range", `bytes */${f.size}`);
      return new Response(null, { status: 416, headers });
    }
    range = { offset: start, length: end - start + 1 };
  }
  const object =
    c.req.method === "HEAD"
      ? await c.env.OBJECTS.head(f.object_key)
      : await c.env.OBJECTS.get(f.object_key, range ? { range } : undefined);
  if (!object) fail(503, "Package object temporarily unavailable");
  try {
    await readAuthority(c, r);
    const live = await c.env.DB.prepare(
      "SELECT id FROM package_files WHERE id=? AND deleted_at IS NULL",
    )
      .bind(f.id)
      .first();
    if (!live) fail(404, "Package file retired");
  } catch (e) {
    if ("body" in object) await (object as R2ObjectBody).body.cancel();
    throw e;
  }
  if (
    c.req
      .header("if-none-match")
      ?.split(/\s*,\s*/)
      .includes(etag)
  ) {
    if ("body" in object) await (object as R2ObjectBody).body.cancel();
    return new Response(null, { status: 304, headers });
  }
  headers.set("content-length", String(range?.length ?? f.size));
  if (range)
    headers.set(
      "content-range",
      `bytes ${range.offset}-${range.offset + range.length - 1}/${f.size}`,
    );
  return new Response("body" in object ? (object as R2ObjectBody).body : null, {
    status: range ? 206 : 200,
    headers,
  });
}
export function registerPackageRoutes(
  app: Hono<App>,
  h: {
    access: (
      c: Context<App>,
      level?: "read" | "write" | "maintain",
    ) => Promise<Repo>;
  },
) {
  const base = "/api/repos/:namespace/:repo/packages";
  const access = async (
    c: Context<App>,
    level: "read" | "write" | "maintain" = "read",
  ) => {
    if (c.get("delegation"))
      fail(403, "Delegated Git tokens cannot access package registries");
    return h.access(c, level);
  };
  app.get(base, async (c) => {
    const r = await access(c),
      offset = z.coerce
        .number()
        .int()
        .min(0)
        .max(100000)
        .parse(c.req.query("offset") || 0);
    const rows = await c.env.DB.prepare(
      "SELECT v.id,v.kind,v.name,v.version,v.created_at,u.username publisher,COUNT(f.id) files,COALESCE(SUM(f.size),0) size FROM package_versions v LEFT JOIN package_files f ON f.version_id=v.id AND f.deleted_at IS NULL JOIN users u ON u.id=v.publisher_id WHERE v.repo_id=? AND v.deleted_at IS NULL GROUP BY v.id ORDER BY v.created_at DESC,v.id DESC LIMIT 51 OFFSET ?",
    )
      .bind(r.id, offset)
      .all();
    const used = await c.env.DB.prepare(
      "SELECT COALESCE(SUM(f.size),0) bytes,COUNT(f.id) files FROM package_files f JOIN package_versions v ON v.id=f.version_id WHERE v.repo_id=? AND f.deleted_at IS NULL AND v.deleted_at IS NULL",
    )
      .bind(r.id)
      .first();
    await readAuthority(c, r);
    return c.json({
      versions: rows.results.slice(0, 50),
      next_offset: rows.results.length > 50 ? offset + 50 : null,
      used,
      limits: {
        generic_bytes: PACKAGE_LIMIT.generic,
        npm_bytes: PACKAGE_LIMIT.npm,
        quota_bytes: PACKAGE_LIMIT.quota,
        files: PACKAGE_LIMIT.files,
      },
      npm_registry: registry(c, r),
    });
  });
  app.get(base + "/versions/:id", async (c) => {
    const r = await access(c),
      v = await c.env.DB.prepare(
        "SELECT id,kind,name,version,metadata,created_at FROM package_versions WHERE id=? AND repo_id=? AND deleted_at IS NULL",
      )
        .bind(c.req.param("id"), r.id)
        .first<any>();
    if (!v) fail(404, "Package version not found");
    const files = (
      await c.env.DB.prepare(
        "SELECT id,filename,size,sha256,sha512,sha1,created_at FROM package_files WHERE version_id=? AND deleted_at IS NULL ORDER BY filename",
      )
        .bind(v.id)
        .all()
    ).results;
    const tags = (
      await c.env.DB.prepare(
        "SELECT tag,revision FROM package_tags WHERE version_id=? ORDER BY tag",
      )
        .bind(v.id)
        .all()
    ).results;
    await readAuthority(c, r);
    return c.json({
      ...v,
      metadata: JSON.parse(v.metadata),
      files,
      tags,
      npm_registry: registry(c, r),
    });
  });
  app.delete(base + "/versions/:id", async (c) => {
    const r = await access(c, "maintain"),
      db = unguardDatabase(c.env.DB),
      id = c.req.param("id");
    const exists = await c.env.DB.prepare(
      "SELECT id FROM package_versions WHERE id=? AND repo_id=?",
    )
      .bind(id, r.id)
      .first();
    if (!exists) fail(404, "Package version not found");
    await packageMutation(
      c.env,
      r,
      actor(c, r),
      [
        db
          .prepare(
            "UPDATE package_versions SET deleted_at=COALESCE(deleted_at,?) WHERE id=? AND repo_id=?",
          )
          .bind(Date.now(), id, r.id),
      ],
      "package.delete",
      { id },
      true,
    );
    c.executionCtx.waitUntil(gc(c, r));
    return c.json({ ok: true, cleanup: "scheduled" });
  });
  const generic = base + "/generic/:name/:version/:file";
  app.put(generic, async (c) => {
    const r = await access(c, "write"),
      spec = genericSpec.parse({
        kind: "generic",
        name: c.req.param("name"),
        version: c.req.param("version"),
        filename: c.req.param("file"),
        size: Number(c.req.header("content-length")),
        sha256: c.req.header("x-package-sha256"),
      });
    if (!c.req.raw.body) fail(400, "Package body required");
    const result = await publishPackage(
      c.env,
      r,
      actor(c, r),
      spec,
      async (key) => {
        const stream = new FixedLengthStream(spec.size),
          abort = new AbortController(),
          timer = setTimeout(
            () => abort.abort(Error("Package upload timed out")),
            PACKAGE_LIMIT.uploadMs,
          );
        try {
          const results = await Promise.allSettled([
            c.req.raw.body!.pipeTo(stream.writable, { signal: abort.signal }),
            c.env.OBJECTS.put(key, stream.readable, {
              sha256: spec.sha256,
            }).catch((e) => {
              abort.abort(e);
              throw e;
            }),
          ]);
          if (results.some((x) => x.status === "rejected"))
            fail(400, "Package body size, checksum or upload failed");
        } finally {
          clearTimeout(timer);
        }
      },
    );
    return c.json(result, 201);
  });
  app.on(["GET", "HEAD"], generic, async (c) => {
    const r = await access(c);
    return download(
      c,
      r,
      "generic",
      genericPart.parse(c.req.param("name")),
      genericPart.parse(c.req.param("version")),
      genericPart.parse(c.req.param("file")),
    );
  });
  const npm = base + "/npm";
  app.get(npm + "/-/ping", async (c) => {
    await access(c);
    return c.json({});
  });
  app.get(npm + "/-/whoami", async (c) => {
    const r = await access(c);
    await readAuthority(c, r);
    return c.json({
      username: c.get("user")?.username || fail(401, "Sign in required"),
    });
  });
  const tagBase = npm + "/-/package/:name/dist-tags";
  app.get(tagBase, async (c) => {
    const r = await access(c);
    return c.json(
      (await packument(c, r, packageName.parse(c.req.param("name"))))[
        "dist-tags"
      ],
    );
  });
  app.on(["PUT", "DELETE"], tagBase + "/:tag", async (c) => {
    const r = await access(c, "write"),
      name = packageName.parse(c.req.param("name")),
      tag = npmTag.parse(c.req.param("tag")),
      db = unguardDatabase(c.env.DB),
      guard = crypto.randomUUID();
    const statements: D1PreparedStatement[] = [];
    if (c.req.method === "PUT") {
      const version = npmVersion.parse(await json(c, 1024));
      statements.push(
        db
          .prepare(
            "INSERT INTO mutation_guards(id,accepted) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM package_versions WHERE repo_id=? AND kind='npm' AND name=? AND version=? AND deleted_at IS NULL) AND ((SELECT COUNT(*) FROM package_tags WHERE repo_id=? AND name=?)<32 OR EXISTS(SELECT 1 FROM package_tags WHERE repo_id=? AND name=? AND tag=?)) THEN 1 ELSE 0 END",
          )
          .bind(guard, r.id, name, version, r.id, name, r.id, name, tag),
        db
          .prepare(
            "INSERT INTO package_tags(repo_id,name,tag,version_id) SELECT ?,?,?,id FROM package_versions WHERE repo_id=? AND kind='npm' AND name=? AND version=? AND deleted_at IS NULL ON CONFLICT(repo_id,name,tag) DO UPDATE SET version_id=excluded.version_id,revision=package_tags.revision+1",
          )
          .bind(r.id, name, tag, r.id, name, version),
        db.prepare("DELETE FROM mutation_guards WHERE id=?").bind(guard),
      );
    } else
      statements.push(
        db
          .prepare(
            "DELETE FROM package_tags WHERE repo_id=? AND name=? AND tag=?",
          )
          .bind(r.id, name, tag),
      );
    await packageMutation(c.env, r, actor(c, r), statements, "package.tag", {
      name,
      tag,
      operation: c.req.method,
    });
    return c.json({ ok: true });
  });
  app.on(["GET", "HEAD"], npm + "/:name/-/:file", async (c) => {
    const r = await access(c);
    return download(
      c,
      r,
      "npm",
      packageName.parse(c.req.param("name")),
      null,
      npmFile.parse(c.req.param("file")),
    );
  });
  app.put(npm + "/:name", async (c) => {
    const r = await access(c, "write"),
      {
        bytes,
        spec,
        access: requestedAccess,
      } = await parseNpmPublish(
        packageName.parse(c.req.param("name")),
        await json(c, PACKAGE_LIMIT.npmBody),
      );
    if (
      requestedAccess !== undefined &&
      requestedAccess !== "public" &&
      requestedAccess !== "restricted"
    )
      fail(400, "Invalid npm access");
    // npm requires access=public for unscoped names. Repository visibility is
    // authoritative, so this flag never makes a private project's bytes public.
    if (requestedAccess === "restricted" && r.visibility === "public")
      fail(
        400,
        "Cannot publish a restricted npm package in a public repository",
      );
    await publishPackage(c.env, r, actor(c, r), spec, (key) =>
      c.env.OBJECTS.put(key, bytes, { sha256: spec.sha256 }),
    );
    return c.json({ ok: true, id: spec.name }, 201);
  });
  app.get(npm + "/:name", async (c) => {
    const r = await access(c);
    return c.json(
      await packument(c, r, packageName.parse(c.req.param("name"))),
    );
  });
  app.on(["PUT", "DELETE"], npm + "/:name/-rev/:revision", async (c) => {
    const r = await access(c, "maintain"),
      name = packageName.parse(c.req.param("name")),
      revision = z
        .string()
        .regex(/^[1-9][0-9]{0,15}$/)
        .parse(c.req.param("revision")),
      db = unguardDatabase(c.env.DB),
      guard = crypto.randomUUID();
    const current = await packument(c, r, name);
    if (current._rev !== revision)
      fail(409, "npm package revision changed; retry unpublish");
    let retained: string[] = [],
      tags: Record<string, unknown> = {};
    if (c.req.method === "PUT") {
      const b = record.parse(await json(c));
      if (b.name !== name || b._rev !== revision)
        fail(400, "Invalid npm unpublish document");
      retained = Object.keys(record.parse(b.versions));
      tags = record.parse(b["dist-tags"]);
      if (
        !retained.length ||
        retained.length >= Object.keys(current.versions).length ||
        retained.some((v) => !Object.hasOwn(current.versions, v))
      )
        fail(400, "Unpublish may only remove existing versions");
      if (Object.keys(tags).length > 32) fail(400, "Too many dist-tags");
      for (const [tag, version] of Object.entries(tags)) {
        npmTag.parse(tag);
        if (typeof version !== "string" || !retained.includes(version))
          fail(400, "Tag references a removed version");
      }
    }
    const removed = Object.keys(current.versions).filter(
      (v) => !retained.includes(v),
    );
    const statements = [
      db
        .prepare(
          "INSERT INTO mutation_guards(id,accepted) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM package_catalog WHERE repo_id=? AND name=? AND revision=?) THEN 1 ELSE 0 END",
        )
        .bind(guard, r.id, name, Number(revision)),
      ...removed.map((v) =>
        db
          .prepare(
            "UPDATE package_versions SET deleted_at=? WHERE repo_id=? AND kind='npm' AND name=? AND version=? AND deleted_at IS NULL",
          )
          .bind(Date.now(), r.id, name, v),
      ),
      db
        .prepare("DELETE FROM package_tags WHERE repo_id=? AND name=?")
        .bind(r.id, name),
      ...Object.entries(tags).map(([tag, version]) =>
        db
          .prepare(
            "INSERT INTO package_tags(repo_id,name,tag,version_id) SELECT ?,?,?,id FROM package_versions WHERE repo_id=? AND kind='npm' AND name=? AND version=? AND deleted_at IS NULL",
          )
          .bind(r.id, name, tag, r.id, name, version),
      ),
      db.prepare("DELETE FROM mutation_guards WHERE id=?").bind(guard),
    ];
    await packageMutation(
      c.env,
      r,
      actor(c, r),
      statements,
      "package.unpublish",
      { name, versions: removed },
      true,
    );
    c.executionCtx.waitUntil(gc(c, r));
    return c.json({ ok: true });
  });
  // libnpmpublish deletes the tarball after the revision-checked metadata update.
  app.delete(npm + "/:name/-/:file/-rev/:revision", async (c) => {
    const r = await access(c, "maintain"),
      name = packageName.parse(c.req.param("name")),
      filename = npmFile.parse(c.req.param("file"));
    const file = await c.env.DB.prepare(
      "SELECT f.deleted_at FROM package_files f JOIN package_versions v ON v.id=f.version_id WHERE v.repo_id=? AND v.kind='npm' AND v.name=? AND f.filename=?",
    )
      .bind(r.id, name, filename)
      .first<any>();
    if (!file) fail(404, "Package file not found");
    if (!file.deleted_at)
      fail(409, "Unpublish metadata before deleting its tarball");
    c.executionCtx.waitUntil(gc(c, r));
    return c.json({ ok: true });
  });
}
