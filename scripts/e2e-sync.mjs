import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
const origin = "http://localhost:8787";
let cookie = "";
async function api(path, method = "GET", body, status = 200) {
  const response = await fetch(origin + "/api" + path, {
    method,
    headers: {
      Origin: origin,
      Cookie: cookie,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.headers.get("set-cookie"))
    cookie = response.headers.get("set-cookie").split(";")[0];
  const data = await response.json();
  assert.equal(response.status, status, JSON.stringify(data));
  return data;
}
await api("/login", "POST", {
  username: process.env.TEST_ADMIN_USERNAME || "owner",
  password: process.env.TEST_ADMIN_PASSWORD || "local-test-password-123",
});
const name = "e2e_sync_" + randomBytes(4).toString("hex");
const repo = await api(
  "/repos",
  "POST",
  {
    name,
    base_repo: {
      provider: "github",
      owner: "octocat",
      name: "Hello-World",
      mode: "public",
    },
  },
  201,
);
const path = "/repos/" + repo.namespace + "/" + repo.name;
try {
  await fetch(origin + "/cdn-cgi/local/scheduled");
  let status;
  for (let i = 0; i < 240; i++) {
    status = await api(path + "/sync-status");
    if (status.synced_at) break;
    if (status.status === "failed") throw Error(JSON.stringify(status));
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.ok(status.synced_at, "Queue did not finish upstream sync");
  const branches = await api(path + "/branches");
  assert.ok(branches.branches.length > 0);
  const files = await api(
    path + "/files?ref=" + encodeURIComponent(branches.branches[0].name),
  );
  assert.ok(files.files.length > 0);
  await api(
    path + "/branches/create",
    "POST",
    {
      target_branch: "agent",
      base_branch: branches.branches[0].name,
      ephemeral: true,
    },
    201,
  );
  await api(path + "/pull-upstream", "POST", {}, 202);
  console.log(
    "PASS: Real public GitHub import → Queue → Worker JS pack parser → R2 → refs and file API",
  );
} finally {
  await api(path, "DELETE");
}
