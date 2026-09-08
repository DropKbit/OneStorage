import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
const origin = process.env.TEST_ORIGIN || "http://localhost:8787",
  remote = !["localhost", "127.0.0.1"].includes(new URL(origin).hostname);
if (remote && process.env.ALLOW_REMOTE_ACCEPTANCE !== "1")
  throw Error("Remote acceptance requires opt-in");
const token = process.env.ONESTORAGE_TOKEN_FILE
  ? (await readFile(process.env.ONESTORAGE_TOKEN_FILE, "utf8")).trim()
  : "";
let admin = token ? { Authorization: "Bearer " + token } : {},
  checks = 0;
async function request(path, method = "GET", body, auth = admin, status = 200) {
  const r = await fetch(origin + "/api" + path, {
    method,
    headers: {
      Origin: origin,
      ...auth,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const data = await r.json();
  assert.equal(
    r.status,
    status,
    method + " " + path + " " + (data.error || ""),
  );
  checks++;
  return {
    data,
    auth: { Cookie: r.headers.get("set-cookie")?.split(";")[0] || "" },
  };
}
const api = async (...args) => (await request(...args)).data;
if (!token)
  admin = (
    await request(
      "/login",
      "POST",
      { username: "owner", password: "local-test-password-123" },
      {},
    )
  ).auth;
const owner = (await api("/me")).user,
  suffix = randomBytes(4).toString("hex"),
  workspace = "issues_v09_" + suffix,
  users = [],
  repos = [];
let created = false;
try {
  for (const prefix of ["developer", "reader"]) {
    const username = prefix + "_" + suffix,
      password = randomBytes(18).toString("hex"),
      u = await api("/users", "POST", { username, password }, admin, 201);
    users.push({
      ...u,
      username,
      password,
      auth: (await request("/login", "POST", { username, password }, {})).auth,
    });
  }
  const [dev, reader] = users;
  await api(
    "/workspaces",
    "POST",
    { slug: workspace, name: "Issue workflows acceptance" },
    admin,
    201,
  );
  created = true;
  for (const name of ["project", "other"])
    repos.push(
      await api(
        "/repos",
        "POST",
        { namespace: workspace, name, visibility: "private" },
        admin,
        201,
      ),
    );
  const ap = "/repos/" + workspace + "/project",
    op = "/repos/" + workspace + "/other";
  await api(ap + "/members", "PUT", {
    username: dev.username,
    role: "developer",
  });
  await api(ap + "/members", "PUT", {
    username: reader.username,
    role: "reader",
  });
  const labels = [];
  for (const name of ["Todo", "Doing"])
    labels.push(
      await api(ap + "/labels", "POST", { name, color: "0088aa" }, admin, 201),
    );
  const alien = await api(
      op + "/labels",
      "POST",
      { name: "Other project", color: "ffaa00" },
      admin,
      201,
    ),
    milestone = await api(
      ap + "/milestones",
      "POST",
      { title: "Release" },
      admin,
      201,
    );
  const issues = [];
  for (let i = 0; i < 12; i++)
    issues.push(
      await api(
        ap + "/issues",
        "POST",
        { title: "Plan " + i, body: i === 0 ? "100%_ literal" : "Details" },
        admin,
        201,
      ),
    );
  const comment = await api(
    ap + "/issues/" + issues[0].id + "/comments",
    "POST",
    { body: "First comment" },
    admin,
    201,
  );
  await api(
    ap + "/issues/" + issues[0].id + "/comments",
    "POST",
    { body: "Next comment" },
    reader.auth,
    201,
  );
  const commentPage = await api(
    ap + "/issues/" + issues[0].id + "?comments_after=" + comment.id,
  );
  assert.equal(commentPage.comments.length, 1);
  assert.equal(commentPage.comments[0].body, "Next comment");
  const unrelated = await api(
    op + "/issues",
    "POST",
    { title: "Private other" },
    admin,
    201,
  );
  let cursor = null,
    seen = [];
  do {
    const page = await api(
      ap +
        "/issues?limit=5" +
        (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
      "GET",
      undefined,
      reader.auth,
    );
    assert.equal(page.total, 12);
    seen.push(...page.issues.map((i) => i.id));
    cursor = page.next_cursor;
  } while (cursor);
  assert.equal(new Set(seen).size, 12);
  assert.equal(
    (await api(ap + "/issues?q=" + encodeURIComponent("100%_"))).total,
    1,
  );
  const board = await api(
      ap + "/issue-boards",
      "POST",
      { name: "Delivery", labels: labels.map((l) => l.id) },
      admin,
      201,
    ),
    bp = ap + "/issue-boards/" + board.id;
  await api(
    ap + "/issue-boards",
    "POST",
    { name: "Forbidden", labels: [] },
    reader.auth,
    403,
  );
  const selected = issues
    .slice(0, 2)
    .map((i) => ({ id: i.id, revision: i.revision }));
  await api(
    ap + "/issues/bulk",
    "POST",
    {
      issues: selected,
      changes: {
        state: "closed",
        assignee: dev.username,
        milestone_id: milestone.id,
        add_labels: [labels[0].id],
      },
    },
    reader.auth,
    403,
  );
  await api(
    ap + "/issues/bulk",
    "POST",
    {
      issues: selected,
      changes: {
        state: "closed",
        assignee: dev.username,
        milestone_id: milestone.id,
        add_labels: [labels[0].id],
      },
    },
    dev.auth,
  );
  let first = await api(ap + "/issues/" + issues[0].id),
    second = await api(ap + "/issues/" + issues[1].id);
  assert.equal(first.state, "closed");
  assert.equal(first.assignee, dev.username);
  assert.equal(first.labels[0].id, labels[0].id);
  await api(
    ap + "/issues/bulk",
    "POST",
    {
      issues: [
        { id: first.id, revision: first.revision },
        { id: second.id, revision: 0 },
      ],
      changes: { state: "open" },
    },
    dev.auth,
    409,
  );
  assert.equal((await api(ap + "/issues/" + first.id)).state, "closed");
  await api(
    ap + "/issues/bulk",
    "POST",
    {
      issues: [
        { id: first.id, revision: first.revision },
        { id: unrelated.id, revision: unrelated.revision },
      ],
      changes: { state: "open" },
    },
    dev.auth,
    409,
  );
  await api(
    ap + "/issues/bulk",
    "POST",
    {
      issues: [{ id: first.id, revision: first.revision }],
      changes: { add_labels: [alien.id] },
    },
    dev.auth,
    400,
  );
  const filtered = await api(
    ap +
      "/issues?state=closed&assignee=" +
      dev.username +
      "&labels=" +
      labels[0].id +
      "&milestone=" +
      milestone.id,
  );
  assert.equal(filtered.total, 2);
  await api(
    bp + "/move",
    "POST",
    {
      issue: { id: first.id, revision: first.revision },
      from: "closed",
      to: labels[1].id,
      board_revision: 0,
    },
    dev.auth,
  );
  first = await api(ap + "/issues/" + first.id);
  assert.equal(first.state, "open");
  assert.equal(first.labels.length, 2);
  assert.equal((await api(bp + "/cards?column=" + labels[1].id)).total, 1);
  await api(
    bp + "/move",
    "POST",
    {
      issue: { id: first.id, revision: first.revision },
      from: "open",
      to: "closed",
      board_revision: 0,
    },
    dev.auth,
    409,
  );
  await api(
    bp + "/move",
    "POST",
    {
      issue: { id: first.id, revision: first.revision },
      from: labels[1].id,
      to: "open",
      board_revision: 0,
    },
    dev.auth,
  );
  first = await api(ap + "/issues/" + first.id);
  assert.equal(first.labels.length, 0);
  await api(bp, "PUT", {
    name: "Revised board",
    labels: [labels[1].id],
    revision: 0,
  });
  await api(
    bp + "/move",
    "POST",
    {
      issue: { id: first.id, revision: first.revision },
      from: "open",
      to: "closed",
      board_revision: 0,
    },
    dev.auth,
    409,
  );
  await api(ap + "/members/" + dev.username, "DELETE");
  await api(
    ap + "/issues/bulk",
    "POST",
    {
      issues: [{ id: first.id, revision: first.revision }],
      changes: { state: "closed" },
    },
    dev.auth,
    403,
  );
  await api(ap + "/members", "PUT", {
    username: dev.username,
    role: "developer",
  });
  await api(
    ap + "/issues/" + first.id + "/planning",
    "PUT",
    {
      assignee: reader.username,
      milestone_id: null,
      labels: [labels[1].id],
      revision: first.revision,
    },
    dev.auth,
  );
  await api(
    ap + "/issues/" + first.id,
    "PATCH",
    { state: "closed", revision: first.revision },
    admin,
    409,
  );
  await api(bp + "/cards", "GET", undefined, {}, 401);
  await api(bp, "DELETE");
  assert.equal((await api(ap + "/issues/" + first.id)).state, "open");
  console.log(
    JSON.stringify({
      checks,
      workspace,
      pagination: "passed",
      atomicBulk: "passed",
      boardMoves: "passed",
    }),
  );
} finally {
  for (const r of repos.reverse())
    await api("/admin/repositories/" + r.id, "DELETE");
  for (const u of users)
    await api("/admin/users/" + u.id, "PATCH", {
      disabled: true,
      revoke_sessions: true,
    });
  if (created) {
    let removed = false;
    for (let i = 0; i < 100; i++) {
      const response = await fetch(origin + "/api/workspaces/" + workspace, {
        method: "DELETE",
        headers: { Origin: origin, ...admin },
      });
      if (response.status === 200) {
        removed = true;
        break;
      }
      if (response.status !== 409)
        throw Error("Workspace cleanup failed: " + response.status);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!removed) throw Error("Workspace GC pending: " + workspace);
    console.log(
      JSON.stringify({
        cleanup:
          "repositories/workspace removed, users disabled and credentials revoked",
        workspace,
      }),
    );
  }
}
