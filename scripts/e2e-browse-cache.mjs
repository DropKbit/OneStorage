// Local-only acceptance: cache prewarm, authenticated hits, fresh writes and denial.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
const origin = process.env.TEST_ORIGIN || "http://localhost:8787";
if (!["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw Error("Local fixture only");
const username = process.env.TEST_USERNAME || "owner",
  password = process.env.TEST_PASSWORD || "local-test-password-123";
let cookie = "",
  created = false;
const name = "browse-" + randomBytes(4).toString("hex"),
  rp = "/repos/" + username + "/" + name;
async function request(
  path,
  method = "GET",
  body,
  authenticated = true,
  status = 200,
) {
  const r = await fetch(origin + "/api" + path, {
    method,
    headers: {
      Origin: origin,
      ...(authenticated && cookie ? { Cookie: cookie } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  if (path === "/login" && r.ok)
    cookie = r.headers.get("set-cookie").split(";")[0];
  assert.equal(r.status, status, path + ": " + r.status);
  return r;
}
async function commit(content) {
  const r = await request(
    rp + "/commit-files",
    "POST",
    {
      target_branch: "main",
      commit_message: "Cache acceptance",
      files: [{ path: "README.md", content }],
    },
    true,
    201,
  );
  return r.json();
}
async function ready() {
  for (let i = 0; i < 120; i++) {
    const s = await (await request(rp + "/code-index")).json();
    if (!s.stale && ["ready", "partial"].includes(s.status)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw Error("Background index/prewarm timed out");
}
try {
  await request("/login", "POST", { username, password });
  await request(
    "/repos",
    "POST",
    { namespace: username, name, visibility: "private" },
    true,
    201,
  );
  created = true;
  await commit("# First\n");
  await ready();
  // No earlier browse request: this hit must have been created by the alarm.
  const first = await request(rp + "/browse");
  assert.match(first.headers.get("server-timing"), /persistent-hit/);
  assert.equal((await first.json()).readme.content, "# First\n");
  await request(rp + "/browse", "GET", undefined, false, 401);
  await commit("# Updated\n");
  const next = await request(rp + "/browse");
  assert.equal((await next.json()).readme.content, "# Updated\n");
  await ready();
  const hit = await request(rp + "/browse");
  assert.match(hit.headers.get("server-timing"), /persistent-hit/);
  const headers = new Headers({ Authorization: "Bearer invalid-cache-test" });
  const denied = await fetch(origin + "/api" + rp + "/browse", { headers });
  assert.equal(denied.status, 401);
  await denied.arrayBuffer();
  console.log(
    "PASS: background prewarm before first browse, private authorization on hits, fresh commit after write, persistent reuse",
  );
} finally {
  if (created) await request(rp, "DELETE");
  if (cookie) await request("/logout", "POST", {});
}
