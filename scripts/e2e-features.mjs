import assert from "node:assert/strict";
import { generateKeyPair, exportSPKI, SignJWT } from "jose";
import { randomBytes } from "node:crypto";
const origin = process.env.TEST_ORIGIN || "http://localhost:8787";
if (!["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw Error("Local tests only");
const username = process.env.TEST_ADMIN_USERNAME || "owner",
  password = process.env.TEST_ADMIN_PASSWORD || "local-test-password-123";
let cookie = "",
  checks = 0;
async function req(
  path,
  method = "GET",
  body,
  auth = "session",
  status = 200,
  extra = {},
) {
  const headers = { Origin: origin, ...extra };
  if (auth === "session") headers.Cookie = cookie;
  else if (auth) headers.Authorization = "Bearer " + auth;
  if (body !== undefined && !headers["Content-Type"])
    headers["Content-Type"] = "application/json";
  const r = await fetch(origin + path, {
    method,
    headers,
    body:
      body === undefined
        ? undefined
        : typeof body === "string"
          ? body
          : JSON.stringify(body),
  });
  if (r.headers.get("set-cookie"))
    cookie = r.headers.get("set-cookie").split(";")[0];
  const raw = await r.text();
  assert.equal(r.status, status, `${method} ${path}: ${raw.slice(0, 500)}`);
  checks++;
  return { r, data: raw ? JSON.parse(raw) : null };
}
await req("/api/login", "POST", { username, password }, null);
const name = "e2e_features_" + randomBytes(4).toString("hex"),
  path = "/api/repos/" + username + "/" + name;
const { data: created } = await req(
  "/api/repos",
  "POST",
  { name },
  "session",
  201,
);
const emptyBrowse = (await req(path + "/browse")).data;
assert.deepEqual(emptyBrowse, {
  branches: [],
  default_branch: "main",
  data: null,
  readme: null,
});
const pair = await generateKeyPair("ES256", { extractable: true });
const { data: key } = await req(
  "/api/api-keys",
  "POST",
  { name, public_key: await exportSPKI(pair.publicKey) },
  "session",
  201,
);
const jwt = async (scopes, refs = [], seconds = 3600) =>
  new SignJWT({ repo: username + "/" + name, scopes, refs })
    .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: key.id })
    .setIssuer(username)
    .setSubject("feature-tests")
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + seconds)
    .sign(pair.privateKey);
const reader = await jwt(["git:read"]),
  writer = await jwt(["git:write"]),
  manager = await jwt(["repo:write"]);
const initial = {
  target_branch: "main",
  commit_message: "First",
  files: [
    { path: "hello.txt", content: "hello\nworld\n" },
    { path: "README.md", content: "# Browse fixture\n" },
    { path: "sub/code.ts", content: "const answer = 42;\n" },
  ],
};
const { data: first } = await req(
  path + "/commit-files",
  "POST",
  initial,
  writer,
  201,
);
const browse = (await req(path + "/browse", "GET", undefined, reader)).data;
assert.equal(browse.data.ref, first.sha);
assert.equal(browse.readme.ref, first.sha);
assert.equal(browse.readme.content, "# Browse fixture\n");
assert.deepEqual(
  browse.data,
  (await req(path + "/tree?ref=main", "GET", undefined, reader)).data,
);
assert.equal(
  (
    await req(
      path + "/browse?view=blob&path=hello.txt",
      "GET",
      undefined,
      reader,
    )
  ).data.data.content,
  "hello\nworld\n",
);
await req(path + "/browse", "GET", undefined, writer, 403);
await req(path + "/browse", "GET", undefined, null, 401);
await req(path + "/branches", "GET", undefined, writer, 403);
await req(path + "/commit-files", "POST", initial, reader, 403);
await req(path + "/grep", "POST", { query: { pattern: "answer" } }, reader);
await req(path + "/branches", "GET", undefined, manager, 403);
await req(
  path + "/branches",
  "GET",
  undefined,
  await jwt(["git:read"], [], -1),
  401,
);
const { data: refs } = await req(path + "/branches", "GET", undefined, reader);
assert.equal(refs.branches.length, 1);
const blocked = await jwt(["git:write"], [["main", ["no-push"]]]);
await req(
  path + "/commit-files",
  "POST",
  { ...initial, commit_message: "Blocked" },
  blocked,
  403,
);
const unsigned = await jwt(["git:write"], [["main", ["verify-sig"]]]);
await req(
  path + "/commit-files",
  "POST",
  { ...initial, commit_message: "Unsigned" },
  unsigned,
  403,
);
const ephemeral = await jwt(
  ["git:write"],
  [
    ["refs/namespaces/ephemeral/refs/heads/*", []],
    ["*", ["no-push"]],
  ],
);
await req(
  path + "/commit-files",
  "POST",
  {
    ...initial,
    target_branch: "agent",
    base_branch: "main",
    ephemeral: true,
    commit_message: "Agent",
  },
  ephemeral,
  201,
);
assert.equal(
  (await req(path + "/branches", "GET", undefined, reader)).data.branches
    .length,
  1,
);
assert.equal(
  (await req(path + "/branches?ephemeral=true", "GET", undefined, reader)).data
    .branches[0].name,
  "agent",
);
await req(
  path + "/branches/create",
  "POST",
  { target_branch: "promoted", base_branch: "agent", base_is_ephemeral: true },
  writer,
  201,
);
await req(
  path + "/notes",
  "POST",
  { sha: first.sha, note: "agent metadata" },
  writer,
  201,
);
assert.equal(
  (await req(path + "/notes?sha=" + first.sha, "GET", undefined, reader)).data
    .note,
  "agent metadata\n",
);
await req(path + "/tags", "POST", { name: "v1", sha: first.sha }, writer, 201);
const bytes = Buffer.from([0, 1, 2, 255]);
const stream = [
  {
    metadata: {
      target_branch: "main",
      commit_message: "Binary",
      author: { name: "Tests", email: "test@example.com" },
      files: [{ path: "binary", operation: "upsert", content_id: "binary" }],
    },
  },
  {
    blob_chunk: {
      content_id: "binary",
      data: bytes.toString("base64"),
      eof: true,
    },
  },
]
  .map((x) => JSON.stringify(x) + "\n")
  .join("");
await req(path + "/commit-pack", "POST", stream, writer, 201, {
  "Content-Type": "application/x-ndjson",
});
let raw = await fetch(origin + path + "/file?path=binary", {
  headers: { Authorization: "Bearer " + reader, Range: "bytes=1-2" },
});
assert.equal(raw.status, 206);
assert.deepEqual(Buffer.from(await raw.arrayBuffer()), bytes.subarray(1, 3));
checks++;
raw = await fetch(origin + path + "/file?path=binary", {
  method: "HEAD",
  headers: { Authorization: "Bearer " + reader },
});
assert.equal(raw.status, 200);
assert.equal(raw.headers.get("content-length"), "4");
assert.equal(await raw.text(), "");
checks++;
const etag = raw.headers.get("etag");
raw = await fetch(origin + path + "/file?path=binary", {
  headers: { Authorization: "Bearer " + reader, "If-None-Match": etag },
});
assert.equal(raw.status, 304);
checks++;
await req(path, "PATCH", { default_branch: "promoted" }, manager);
await req(path, "PATCH", { default_branch: "missing" }, manager, 409);
const forkName = name + "_fork";
const { data: fork } = await req(
  "/api/repos",
  "POST",
  { name: forkName, base_repo: { id: created.id, sha: first.sha } },
  "session",
  201,
);
const forkPath = "/api/repos/" + username + "/" + forkName;
assert.equal(
  (await req(forkPath + "/branch?branch=promoted")).data.sha,
  first.sha,
);
await req(forkPath + "/branches", "GET", undefined, reader, 403);
await req("/api/repo-url/" + fork.id);
await req(forkPath, "DELETE");
await req(forkPath, "GET", undefined, "session", 404);
const detail = (
  await req(path + "/commit?sha=" + first.sha, "GET", undefined, reader)
).data.commit;
assert.equal(detail.sha, first.sha);
await req(path + "/files/metadata?ref=main", "GET", undefined, reader);
await req(path + "/commits?ref=main&path=hello.txt", "GET", undefined, reader);
await req(path + "/diff?ref=main", "GET", undefined, reader);
await req(
  path + "/branches/diff?source=main&target=promoted",
  "GET",
  undefined,
  reader,
);
await req(path + "/tags?limit=1", "GET", undefined, reader);
await req(path + "/tag?name=v1", "GET", undefined, reader);
await req(path + "/tags/v1", "DELETE", undefined, writer);
await req(path + "/tag?name=v1", "GET", undefined, reader, 404);
await req(path + "/notes/refs", "GET", undefined, reader);
await req(path + "/notes", "DELETE", { sha: first.sha }, writer);
await req(path + "/notes?sha=" + first.sha, "GET", undefined, reader, 404);
const restore = {
  target_branch: "main",
  base_ref: first.sha,
  commit_message: "Restore snapshot",
  author: { name: "Tests", email: "test@example.com" },
};
await req(
  path + "/restore-commit",
  "POST",
  JSON.stringify({ metadata: restore }) + "\n",
  writer,
  201,
  { "Content-Type": "application/x-ndjson" },
);
await req(
  path + "/reset-commits",
  "POST",
  JSON.stringify({ metadata: restore }) + "\n",
  writer,
  201,
  { "Content-Type": "application/x-ndjson" },
);
await req(path + "/blame?path=hello.txt&ranges=1,", "GET", undefined, reader);
await req(
  path + "/upstream",
  "PUT",
  { provider: "gitlab", owner: "example", name: "fixture" },
  "session",
);
const { data: cred } = await req(
  path + "/git-credentials",
  "POST",
  { username: "oauth2", password: "local-secret-do-not-transmit" },
  "session",
  201,
);
assert.ok(
  !JSON.stringify((await req(path + "/git-credentials")).data).includes(
    "local-secret",
  ),
);
await req(
  path + "/git-credentials",
  "PUT",
  { username: "oauth2", password: "changed-local-secret" },
  "session",
);
await req(path + "/git-credentials/" + cred.id, "DELETE");
await req(path + "/base", "DELETE");
assert.equal((await req(path + "/sync-status")).data.upstream, null);
await req(path + "/pull-upstream", "POST", {}, "session", 400);
async function mcp(method, params, token = reader) {
  const r = await fetch(origin + "/mcp", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-11-25",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  assert.equal(r.status, 200);
  checks++;
  return r.json();
}
assert.equal(
  (
    await mcp("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    })
  ).result.serverInfo.name,
  "OneStorage",
);
assert.ok(
  (await mcp("tools/list", {})).result.tools.some(
    (t) => t.name === "create_commit",
  ),
);
assert.equal(
  (
    await mcp("tools/call", {
      name: "list_branches",
      arguments: { namespace: username, repo: name },
    })
  ).result.isError,
  false,
);
assert.equal(
  (
    await mcp("tools/call", {
      name: "create_commit",
      arguments: { namespace: username, repo: name, options: initial },
    })
  ).result.isError,
  true,
);
assert.equal(
  (
    await mcp("tools/call", {
      name: "list_branches",
      arguments: { namespace: username, repo: name + "_other" },
    })
  ).result.isError,
  true,
);
const updated = (
  await req(
    path + "/commit-files",
    "POST",
    {
      target_branch: "main",
      commit_message: "Refresh browse cache",
      files: [{ path: "README.md", content: "# Updated fixture\n" }],
    },
    writer,
    201,
  )
).data;
const refreshed = (
  await req(path + "/browse?ref=main", "GET", undefined, reader)
).data;
assert.equal(
  (await req(path + "/browse", "GET", undefined, reader)).data.data.ref,
  (await req(path + "/branch?branch=promoted", "GET", undefined, reader)).data
    .sha,
);
assert.equal(refreshed.data.ref, updated.sha);
assert.equal(refreshed.readme.content, "# Updated fixture\n");
await req("/api/api-keys/" + key.id, "DELETE");
await req(path + "/browse", "GET", undefined, reader, 401);
await req(path + "/branches", "GET", undefined, reader, 401);
await req(path, "DELETE");
await req(path, "GET", undefined, "session", 404);
await req("/api/repos", "POST", { name }, "session", 201);
await req(path, "DELETE");
console.log(
  `PASS: ${checks} advanced HTTP checks (JWT, revocation, policies, namespaces, streams, notes, ranges, forks and lifecycle)`,
);
