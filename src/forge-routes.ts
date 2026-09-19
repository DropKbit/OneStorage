import { Hono, Context } from "hono";
import type { App, Repo } from "./types";
import { branch, sha, fail, boundedBody } from "./security";
import { z } from "zod";
interface Helpers {
  access: (
    c: Context<App>,
    level?: "read" | "write" | "maintain",
  ) => Promise<Repo>;
  engine: (
    c: Context<App>,
    repo: Repo,
    path: string,
    options?: any,
  ) => Promise<Response>;
  audit: (
    c: Context<App>,
    action: string,
    id: string,
    detail?: string,
  ) => Promise<void>;
}
const author = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().min(1).max(254),
});
export function registerForgeRoutes(app: Hono<App>, h: Helpers) {
  for (const [route, path] of Object.entries({
    browse: "/browse",
    "tree-updates": "/tree-updates",
    file: "/file",
    files: "/files",
    "files/metadata": "/files/metadata",
    branch: "/branch",
    "branches/diff": "/branches/diff",
    commit: "/commit-detail",
    diff: "/diff",
    tags: "/tags",
    tag: "/tag",
    notes: "/notes",
    "notes/refs": "/notes/refs",
    blame: "/blame",
    "merge/preview": "/merge/preview",
  })) {
    const read = async (c: Context<App>) => {
      const repo = await h.access(c),
        headers = new Headers();
      for (const name of [
        "range",
        "if-match",
        "if-none-match",
        "if-modified-since",
        "if-unmodified-since",
        "if-range",
      ]) {
        const value = c.req.header(name);
        if (value) headers.set(name, value);
      }
      return h.engine(c, repo, path + new URL(c.req.url).search, {
        headers,
        method: c.req.method,
      });
    };
    app.get("/api/repos/:namespace/:repo/" + route, read);
    if (route === "file")
      app.on("HEAD", "/api/repos/:namespace/:repo/file", read);
  }
  const post = async (
    c: Context<App>,
    path: string,
    level: "read" | "write",
    schema?: z.ZodType<any>,
    operation?: string,
  ) => {
    const repo = await h.access(c, level);
    let data;
    try {
      data = JSON.parse(
        new TextDecoder().decode(
          await boundedBody(c.req.raw, 12 * 1024 * 1024),
        ),
      );
    } catch {
      fail(400, "Invalid JSON");
    }
    if (schema) data = schema.parse(data);
    const user = c.get("user");
    if (user && !data.author)
      data.author = {
        name: user.username,
        email: user.username + "@users.1s.hk",
      };
    const response = await h.engine(c, repo, path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(operation ? { ...data, operation } : data),
      mutation: level === "write",
    });
    if (level === "write" && response.ok)
      await h.audit(c, "git." + path.slice(1).replaceAll("/", "."), repo.id);
    return response;
  };
  app.post("/api/repos/:namespace/:repo/branches/create", (c) =>
    post(
      c,
      "/branches/create",
      "write",
      z.object({
        target_branch: branch,
        base_ref: z.string().optional(),
        base_branch: z.string().optional(),
        base_is_ephemeral: z.boolean().optional(),
        ephemeral: z.boolean().optional(),
        expected_target_sha: sha.nullable().optional(),
      }),
    ),
  );
  app.delete("/api/repos/:namespace/:repo/branches", (c) =>
    post(
      c,
      "/branches/delete",
      "write",
      z.object({
        branch: branch,
        ephemeral: z.boolean().optional(),
        expected_sha: sha.optional(),
      }),
    ),
  );
  app.post("/api/repos/:namespace/:repo/tags", (c) =>
    post(
      c,
      "/tags/create",
      "write",
      z.object({
        name: z.string().min(1).max(200),
        ref: z.string().optional(),
        sha: sha.optional(),
        ephemeral: z.boolean().optional(),
      }),
    ),
  );
  app.delete("/api/repos/:namespace/:repo/tags/:tag", async (c) => {
    const repo = await h.access(c, "write");
    const response = await h.engine(c, repo, "/tags/delete", {
      method: "POST",
      body: JSON.stringify({
        name: c.req.param("tag"),
        ephemeral: c.req.query("ephemeral") === "true",
      }),
    });
    if (response.ok) await h.audit(c, "git.tag.delete", repo.id);
    return response;
  });
  const note = z.object({
    sha,
    notes_ref: z.string().max(200).optional(),
    note: z
      .string()
      .max(1024 * 1024)
      .optional(),
    operation: z.enum(["create", "append"]).optional(),
    expected_ref_sha: sha.nullable().optional(),
    ephemeral: z.boolean().optional(),
    author: author.optional(),
  });
  app.post("/api/repos/:namespace/:repo/notes", (c) =>
    post(c, "/notes/write", "write", note),
  );
  app.delete("/api/repos/:namespace/:repo/notes", (c) =>
    post(c, "/notes/write", "write", note, "delete"),
  );
  app.post("/api/repos/:namespace/:repo/merge", (c) =>
    post(
      c,
      "/merge-advanced",
      "write",
      z.object({
        source_ref: z.string().optional(),
        source_branch: z.string().optional(),
        target_branch: branch,
        source_is_ephemeral: z.boolean().optional(),
        target_is_ephemeral: z.boolean().optional(),
        expected_target_sha: sha.optional(),
        strategy: z
          .enum(["merge", "ff_only", "ff_prefer"])
          .default("ff_prefer"),
        squash: z.boolean().optional(),
        allow_unrelated_histories: z.boolean().optional(),
        commit_message: z.string().max(10000).default("Merge branches"),
        author: author.optional(),
        committer: author.optional(),
      }),
    ),
  );
  app.post("/api/repos/:namespace/:repo/grep", (c) => post(c, "/grep", "read"));
  app.post("/api/repos/:namespace/:repo/archive", (c) =>
    post(c, "/archive", "read"),
  );
  app.post("/api/repos/:namespace/:repo/commit-files", (c) =>
    post(c, "/commit-files", "write"),
  );
  for (const route of [
    "commit-pack",
    "diff-commit",
    "restore-commit",
    "reset-commits",
  ])
    app.post("/api/repos/:namespace/:repo/" + route, async (c) => {
      const repo = await h.access(c, "write");
      if (!c.req.header("content-type")?.startsWith("application/x-ndjson"))
        fail(400, "Content-Type must be application/x-ndjson");
      const response = await h.engine(c, repo, "/" + route, {
        method: "POST",
        headers: { "content-type": "application/x-ndjson" },
        body: c.req.raw.body,
        mutation: true,
      });
      if (response.ok) await h.audit(c, "git." + route, repo.id);
      return response;
    });
}
