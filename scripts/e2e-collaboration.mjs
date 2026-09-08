import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
const origin = process.env.TEST_ORIGIN || "http://localhost:8787",
  remote = !["localhost", "127.0.0.1"].includes(new URL(origin).hostname);
if (remote && process.env.ALLOW_REMOTE_ACCEPTANCE !== "1")
  throw Error("Remote acceptance requires opt-in");
let cookie = "",
  token = process.env.ONESTORAGE_TOKEN_FILE
    ? (await readFile(process.env.ONESTORAGE_TOKEN_FILE, "utf8")).trim()
    : "",
  checks = 0;
async function req(path, method = "GET", body, status = 200, auth = null) {
  const r = await fetch(origin + path, {
    method,
    headers: {
      Origin: origin,
      ...(auth
        ? { Cookie: auth }
        : token
          ? { Authorization: "Bearer " + token }
          : cookie
            ? { Cookie: cookie }
            : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const raw = await r.text();
  assert.equal(r.status, status, method + " " + path + " " + raw.slice(0, 600));
  checks++;
  return {
    data:
      r.headers.get("content-type")?.includes("json") && raw
        ? JSON.parse(raw)
        : raw,
    cookie: r.headers.get("set-cookie")?.split(";")[0],
  };
}
const api = async (...args) => (await req(...args)).data;
if (!token)
  cookie = (
    await req("/api/login", "POST", {
      username: "owner",
      password: "local-test-password-123",
    })
  ).cookie;
const user = await api("/api/me"),
  suffix = crypto.randomUUID().slice(0, 8),
  namespace = "accept_v05_" + suffix;
await api(
  "/api/workspaces",
  "POST",
  { slug: namespace, name: "Cloud native acceptance" },
  201,
);
const repo = await api(
    "/api/repos",
    "POST",
    { namespace, name: "cloud-app", visibility: "private" },
    201,
  ),
  ap = "/api/repos/" + namespace + "/cloud-app";
await writeFile(
  ".data/v05-last-fixture.json",
  JSON.stringify({ namespace, repo, ap }, null, 2),
);
async function commit(ref, files) {
  return api(
    ap + "/commit-files",
    "POST",
    {
      target_branch: ref,
      commit_message: "Cloud collaboration acceptance",
      files: Object.entries(files).map(([path, content]) => ({
        path,
        content,
      })),
    },
    201,
  );
}
async function waitRun(id, expected = "succeeded") {
  for (let i = 0; i < 80; i++) {
    const run = await api(ap + "/ci/runs/" + id);
    if (!["queued", "running"].includes(run.status)) {
      assert.equal(run.status, expected, JSON.stringify(run));
      return run;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw Error("Pipeline did not complete");
}
const ci =
    'import wasm from "./answer.wasm";export default async ({sha,files}) => { if((await WebAssembly.instantiate(wasm)).exports.answer()!==42)throw Error("WASM failed"); if(!files["index.js"].content.includes("Response"))throw Error("Source invalid"); let denied=false;try{await fetch("https://example.com")}catch{denied=true}if(!denied)throw Error("Network isolation failed");return {logs:["Real isolated JS passed; network blocked"],artifacts:{"result.txt":sha}}; }',
  app = 'export default {fetch(){return new Response("cloud-v1")}}';
const first = await api(
  ap + "/commit-files",
  "POST",
  {
    target_branch: "main",
    commit_message: "Cloud JS and WASM",
    files: [
      { path: "ci.js", content: ci },
      { path: "index.js", content: app },
      { path: "README.md", content: "# Cloud acceptance" },
      {
        path: "answer.wasm",
        data: Buffer.from(
          "0061736d010000000105016000017f03020100070a0106616e7377657200000a06010400412a0b",
          "hex",
        ).toString("base64"),
      },
    ],
  },
  201,
);
await api(ap + "/wiki/design", "PUT", {
  title: "Design",
  body: "first",
  expected_version: 0,
});
await api(ap + "/wiki/design", "PUT", {
  title: "Design",
  body: "second",
  expected_version: 1,
});
await api(
  ap + "/wiki/design",
  "PUT",
  { title: "Conflict", body: "bad", expected_version: 1 },
  409,
);
assert.equal((await api(ap + "/wiki/design?version=1")).body, "first");
const issue = await api(
    ap + "/issues",
    "POST",
    { title: "Plan release", body: "Track work" },
    201,
  ),
  label = await api(
    ap + "/labels",
    "POST",
    { name: "cloud", color: "00aaff" },
    201,
  ),
  milestone = await api(
    ap + "/milestones",
    "POST",
    { title: "v1", due_date: "2026-12-01" },
    201,
  );
await api(ap + "/issues/" + issue.id + "/planning", "PUT", {
  assignee: user.user?.username || user.username,
  milestone_id: milestone.id,
  labels: [label.id],
});
assert.equal((await api(ap + "/issues/" + issue.id)).labels[0].name, "cloud");
await api(ap + "/issues/" + issue.id, "PATCH", {
  title: "Updated issue",
  body: "Edited",
});
await api(ap + "/milestones/" + milestone.id, "PATCH", { state: "closed" });
await api(ap + "/star", "PUT");
await api(ap + "/watch", "PUT");
assert.equal((await api(ap + "/social")).stars, 1);
await api(ap + "/tags", "POST", { name: "v1.0.0", ref: "main" }, 201);
await api(
  ap + "/releases",
  "POST",
  { tag: "v1.0.0", title: "Release 1", body: "Cloud release" },
  201,
);
assert.equal((await api(ap + "/releases")).releases[0].sha, first.commit_sha);
await api(
  ap + "/branches/create",
  "POST",
  { target_branch: "feature", base_ref: "main" },
  201,
);
await commit("feature", { "feature.txt": "reviewed" });
const mr = await api(
  ap + "/merges",
  "POST",
  { title: "Add feature", source: "feature", target: "main" },
  201,
);
await api(ap + "/protections", "PUT", {
  branch: "main",
  approvals: remote ? 0 : 1,
  require_mr: true,
  require_ci: true,
});
await api(
  ap + "/commit-files",
  "POST",
  {
    target_branch: "main",
    commit_message: "Blocked",
    files: [{ path: "bad.txt", content: "bad" }],
  },
  403,
);
await api(ap + "/merges/" + mr.id + "/merge", "POST", {}, 409);
await api(
  ap + "/merges/" + mr.id + "/reviews",
  "POST",
  { verdict: "approve", source_sha: mr.source_sha, target_sha: mr.target_sha },
  403,
);
if (!remote) {
  const name = "review_" + suffix;
  await api(
    "/api/users",
    "POST",
    { username: name, password: "test-review-password-123" },
    201,
  );
  await api("/api/workspaces/" + namespace + "/members", "PUT", {
    username: name,
    role: "developer",
  });
  const rc = (
    await req("/api/login", "POST", {
      username: name,
      password: "test-review-password-123",
    })
  ).cookie;
  await api(
    ap + "/merges/" + mr.id + "/reviews",
    "POST",
    {
      verdict: "approve",
      body: "Reviewed",
      source_sha: mr.source_sha,
      target_sha: mr.target_sha,
    },
    201,
    rc,
  );
  assert.equal((await api(ap + "/merges/" + mr.id)).gate.approvals, 1);
  await api("/api/workspaces/" + namespace + "/members/" + name, "DELETE");
  assert.equal((await api(ap + "/merges/" + mr.id)).gate.approvals, 0);
  await api("/api/workspaces/" + namespace + "/members", "PUT", {
    username: name,
    role: "developer",
  });
}
assert.equal(
  (await api(ap + "/planning")).milestones[0].due_date,
  "2026-12-01",
);
// Verify enforcement through a real Git HTTPS/HTTP client, not only JSON endpoints.
const gitDir = await mkdtemp(join(tmpdir(), "onestorage-protection-"));
let temporaryToken;
try {
  temporaryToken = token
    ? null
    : await api(
        "/api/tokens",
        "POST",
        { name: "protection-acceptance", scope: "write", days: 1 },
        201,
      );
  const askpass = join(gitDir, "askpass.cjs");
  await writeFile(
    askpass,
    '#!/usr/bin/env node\nprocess.stdout.write(process.argv[2].toLowerCase().includes("username")?"onestorage":process.env.ONESTORAGE_TEST_GIT_TOKEN);\n',
    { mode: 0o700 },
  );
  const env = {
    ...process.env,
    GIT_ASKPASS: askpass,
    GIT_TERMINAL_PROMPT: "0",
    ONESTORAGE_TEST_GIT_TOKEN: token || temporaryToken.token,
  };
  async function git(args, expected = 0) {
    const result = await new Promise((resolve, reject) => {
      const child = spawn("git", ["-c", "credential.helper=", ...args], {
        cwd: gitDir,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (out += c));
      child.on("error", reject);
      child.on("exit", (code) => resolve({ code, out }));
    });
    if (expected === 0) assert.equal(result.code, 0, result.out);
    else {
      assert.notEqual(
        result.code,
        0,
        "Protected Git write unexpectedly succeeded",
      );
      assert.match(result.out, /protected|Protected|reviewed|denied|delet/i);
    }
    checks++;
    return result;
  }
  await git(["clone", repo.clone_url, "checkout"]);
  await git(["-C", "checkout", "config", "user.name", "Acceptance"]);
  await git([
    "-C",
    "checkout",
    "config",
    "user.email",
    "acceptance@example.invalid",
  ]);
  await writeFile(
    join(gitDir, "checkout", "native.txt"),
    "native Git verification",
  );
  await git(["-C", "checkout", "add", "."]);
  await git(["-C", "checkout", "commit", "-m", "Must reject protected main"]);
  await git(["-C", "checkout", "push", "origin", "HEAD:main"], 1);
  await git(["-C", "checkout", "push", "origin", ":main"], 1);
  await git(["-C", "checkout", "push", "origin", "HEAD:native-check"]);
  await git(["-C", "checkout", "fsck", "--full", "--strict"]);
} finally {
  if (temporaryToken) await api("/api/tokens/" + temporaryToken.id, "DELETE");
  await rm(gitDir, { recursive: true, force: true });
}
const config = {
  name: "Real cloud JS",
  runner: "worker",
  branches: ["main", "feature"],
  timeout_seconds: 90,
  steps: [
    {
      type: "javascript",
      entry: "ci.js",
      files: ["ci.js", "index.js", "answer.wasm"],
      cpu_ms: 1000,
    },
  ],
  deploy: {
    kind: "worker",
    entry: "index.js",
    files: ["index.js"],
    environment: "production",
  },
};
await api(ap + "/ci/config", "PUT", { config, enabled: true });
const run = await api(ap + "/ci/runs", "POST", { ref: "feature" }, 201);
const done = await waitRun(run.id);
assert.match(done.logs.map((x) => x.content).join(""), /network blocked/);
assert.equal(done.artifacts[0].name, "result.txt");
const deployments = await api(ap + "/deployments"),
  dep = deployments.deployments.find((d) => d.run_id === run.id);
assert.ok(dep);
await api(ap + "/environments/production", "PUT", {
  deployment_id: dep.id,
  expected_deployment_id: null,
  public: true,
});
await api(
  ap + "/environments/production",
  "PUT",
  { deployment_id: dep.id, expected_deployment_id: null, public: true },
  409,
);
if (remote) {
  const url = deployments.environments[0].url;
  const resp = await fetch(url);
  assert.equal(resp.status, 200);
  assert.equal(await resp.text(), "cloud-v1");
  assert.ok(resp.headers.get("content-security-policy").includes("sandbox"));
  checks++;
}
await api(ap + "/merges/" + mr.id + "/merge", "POST", { strategy: "merge" });
assert.equal((await api(ap + "/merges/" + mr.id)).state, "merged");
// Auto-trigger on the resulting merge commit runs entirely in Cloudflare.
let auto;
for (let i = 0; i < 40; i++) {
  auto = (await api(ap + "/ci/runs")).runs.find(
    (x) => x.ref === "main" && x.trigger === "push",
  );
  if (auto) break;
  await new Promise((r) => setTimeout(r, 1000));
}
assert.ok(auto);
await waitRun(auto.id);
await commit("feature", {
  "index.js": 'export default {fetch(){return new Response("cloud-v2")}}',
});
const second = await api(ap + "/ci/runs", "POST", { ref: "feature" }, 201);
await waitRun(second.id);
const d2 = (await api(ap + "/deployments")).deployments.find(
  (d) => d.run_id === second.id,
);
await api(ap + "/environments/production", "PUT", {
  deployment_id: d2.id,
  expected_deployment_id: dep.id,
  public: true,
});
if (remote)
  assert.equal(
    await (await fetch(deployments.environments[0].url)).text(),
    "cloud-v2",
  );
await api(ap + "/environments/production", "PUT", {
  deployment_id: dep.id,
  expected_deployment_id: d2.id,
  public: true,
});
if (remote)
  assert.equal(
    await (await fetch(deployments.environments[0].url)).text(),
    "cloud-v1",
  );
// Failed source is a real failed sandbox job, not a synthetic status.
await commit("feature", {
  "ci.js": 'export default ()=>{throw Error("intentional-test-failure") }',
});
const bad = await api(ap + "/ci/runs", "POST", { ref: "feature" }, 201);
await waitRun(bad.id, "failed");
await api(ap + "/environments/production", "PUT", {
  deployment_id: dep.id,
  expected_deployment_id: dep.id,
  public: false,
});
if (remote)
  assert.equal((await fetch(deployments.environments[0].url)).status, 404);
// Publish an actual generated artifact through the static application gateway.
await api(ap + "/ci/config", "PUT", {
  config: {
    ...config,
    deploy: {
      environment: "preview",
      kind: "static",
      entry: "result.txt",
      files: ["result.txt"],
    },
  },
  enabled: false,
});
const staticRun = await api(ap + "/ci/runs", "POST", { ref: "main" }, 201),
  staticDone = await waitRun(staticRun.id);
const staticData = await api(ap + "/deployments"),
  staticDep = staticData.deployments.find((x) => x.run_id === staticRun.id);
await api(ap + "/environments/preview", "PUT", {
  deployment_id: staticDep.id,
  expected_deployment_id: null,
  public: true,
});
if (remote) {
  const staticUrl = staticData.environments.find(
    (x) => x.name === "preview",
  ).url;
  const response = await fetch(staticUrl);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), staticDone.sha);
  assert.equal((await fetch(staticUrl + "__proto__")).status, 404);
  checks += 2;
}
await api(ap + "/environments/preview", "PUT", {
  deployment_id: staticDep.id,
  expected_deployment_id: staticDep.id,
  public: false,
});
console.log(
  "PASS collaboration and isolated Cloudflare CI:",
  checks,
  "HTTP assertions",
);
if (remote && process.env.KEEP_ACCEPTANCE !== "1") {
  await api(ap, "DELETE");
  for (let i = 0; i < 100; i++) {
    const r = await fetch(origin + "/api/workspaces/" + namespace, {
      method: "DELETE",
      headers: { Authorization: "Bearer " + token },
    });
    if (r.ok) {
      console.log("PASS generated cloud fixture removed");
      break;
    }
    assert.equal(r.status, 409);
    if (i === 99) throw Error("Fixture cleanup timed out");
    await new Promise((r) => setTimeout(r, 1000));
  }
}
