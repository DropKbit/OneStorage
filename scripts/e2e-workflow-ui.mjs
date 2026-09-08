import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
const origin = process.env.TEST_ORIGIN || "http://localhost:8787";
if (!["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw Error("Workflow browser acceptance is local-only");
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_EXECUTABLE
    ? { executablePath: process.env.CHROME_EXECUTABLE }
    : {}),
});
const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  }),
  page = await context.newPage();
page.setDefaultTimeout(15000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const suffix = crypto.randomUUID().slice(0, 8),
  space = "ci_ui_" + suffix,
  ap = "/repos/" + space + "/project",
  base = "/" + space + "/project",
  folder = ".data/v14-workflow-ui";
let checks = 0,
  repo,
  user,
  createdSpace = false,
  reader;
async function api(path, method = "GET", data, expected = 200, ctx = context) {
  const response = await ctx.request.fetch(origin + "/api" + path, {
    method,
    headers: { Origin: origin },
    ...(data === undefined ? {} : { data }),
  });
  assert.equal(response.status(), expected, await response.text());
  return response.json();
}
async function action(path, selector, expected = 200) {
  const result = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api" + path &&
      r.request().method() !== "GET",
  );
  await page.locator(selector).click();
  const response = await result;
  assert.equal(response.status(), expected, await response.text());
  checks++;
  return response.json();
}
async function done(id) {
  for (let n = 0; n < 90; n++) {
    const run = await api(ap + "/ci/runs/" + id);
    if (run.status === "succeeded") return run;
    if (["failed", "canceled"].includes(run.status)) throw Error(run.error);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw Error("Workflow timeout");
}
await mkdir(folder, { recursive: true });
try {
  await api("/login", "POST", {
    username: "owner",
    password: process.env.TEST_ADMIN_PASSWORD || "local-test-password-123",
  });
  await api(
    "/workspaces",
    "POST",
    { slug: space, name: "CI browser acceptance" },
    201,
  );
  createdSpace = true;
  repo = await api(
    "/repos",
    "POST",
    { namespace: space, name: "project", visibility: "private" },
    201,
  );
  const config = {
    name: "Browser workflow",
    runner: "workflow",
    jobs: [
      {
        id: "inspect",
        pipeline: {
          runner: "worker",
          steps: [{ type: "file", path: "package.json", format: "json" }],
        },
      },
      {
        id: "verify",
        needs: ["inspect"],
        pipeline: {
          runner: "worker",
          steps: [{ type: "file", path: "README.md" }],
        },
      },
    ],
  };
  const commit = await api(
    ap + "/commit-files",
    "POST",
    {
      target_branch: "main",
      commit_message: "Browser workflow fixture",
      files: [
        { path: ".onestorage-ci.json", content: JSON.stringify(config) },
        { path: "package.json", content: '{"name":"ci-browser"}' },
        { path: "README.md", content: "# CI browser\n" },
      ],
    },
    201,
  );
  await page.goto(origin + base + "/ci");
  await page.locator("#pipeline-config").waitFor();
  assert.equal(
    await page.locator('[data-ci-source="repository"]').isVisible(),
    false,
  );
  checks++;
  await page.getByRole("button", { name: "工作流模板", exact: true }).click();
  assert.equal(
    JSON.parse(
      await page.locator("#pipeline-config textarea[name=config]").inputValue(),
    ).runner,
    "workflow",
  );
  checks++;
  await page
    .locator("#pipeline-config select[name=source_mode]")
    .selectOption("repository");
  assert.equal(
    await page.locator('[data-ci-source="inline"]').isVisible(),
    false,
  );
  assert.equal(
    await page.locator('[data-ci-source="repository"]').isVisible(),
    true,
  );
  checks += 2;
  await page
    .locator("#pipeline-config input[name=source_path]")
    .fill(".onestorage-ci.json");
  await page.locator("#pipeline-config input[name=enabled]").uncheck();
  await action(ap + "/ci/config", "#pipeline-config button[type=submit]");
  await page.locator("#pipeline-config select[name=source_mode]").waitFor();
  assert.equal(
    (await api(ap + "/ci/config")).source_path,
    ".onestorage-ci.json",
  );
  checks++;
  const created = await action(
    ap + "/ci/runs",
    "#run-pipeline button[type=submit]",
    201,
  );
  await page.waitForURL("**/ci/" + created.id);
  await page.locator('[aria-label="工作流任务"]').waitFor();
  const result = await done(created.id);
  await page.goto(origin + base + "/ci/" + created.id);
  await page.locator('[aria-label="工作流任务"]').waitFor();
  assert.equal(
    await page.locator('[aria-label="工作流任务"] .token-row').count(),
    2,
  );
  assert.match(
    await page.locator('[aria-label="工作流任务"]').innerText(),
    /依赖：inspect/,
  );
  assert.match(
    await page.locator(".content").innerText(),
    /\.onestorage-ci\.json/,
  );
  checks += 3;
  await page.screenshot({ path: folder + "/workflow.png", fullPage: true });
  const child = result.jobs.find((j) => j.job_key === "verify");
  await page.locator(`a[href="${base}/ci/${child.id}"]`).click();
  await page.waitForURL("**/ci/" + child.id);
  await page.locator(".ci-log").waitFor();
  assert.match(await page.locator(".ci-log").innerText(), /PASS.*README.md/);
  assert.equal(
    await page.getByRole("button", { name: "重新运行", exact: true }).count(),
    0,
  );
  checks += 2;
  await page.getByRole("link", { name: "← 返回工作流", exact: true }).click();
  await page.waitForURL("**/ci/" + created.id);
  await page.locator('[aria-label="工作流任务"]').waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  checks++;
  await page.screenshot({ path: folder + "/mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const retried = await action(
    ap + "/ci/runs/" + created.id + "/retry",
    '[data-action="retry"]',
    201,
  );
  const retry = await done(retried.id);
  assert.equal(retry.config_sha, commit.sha);
  assert.equal(retry.sha, commit.sha);
  checks += 2;
  const password = crypto.randomUUID() + crypto.randomUUID();
  user = await api(
    "/users",
    "POST",
    { username: "ci_reader_" + suffix, password },
    201,
  );
  await api("/workspaces/" + space + "/members", "PUT", {
    username: user.username,
    role: "reader",
  });
  reader = await browser.newContext();
  await api(
    "/login",
    "POST",
    { username: user.username, password },
    200,
    reader,
  );
  const readPage = await reader.newPage();
  readPage.on("pageerror", (e) => errors.push(e.message));
  await readPage.goto(origin + base + "/ci");
  await readPage.getByRole("heading", { name: "CI/CD", exact: true }).waitFor();
  assert.equal(
    await readPage
      .locator("#pipeline-config,#run-pipeline,#create-runner")
      .count(),
    0,
  );
  checks++;
  await readPage.goto(origin + base + "/ci/" + created.id);
  await readPage.locator('[aria-label="工作流任务"]').waitFor();
  assert.equal(
    await readPage.locator("[data-action=cancel],[data-action=retry]").count(),
    0,
  );
  checks++;
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      checks,
      workspace: space,
      workflow: created.id,
      workflows:
        "configuration modes/template, versioned save, workflow tasks/dependencies, child logs/backlink, retry snapshot, mobile, reader permissions",
      screenshots: folder,
    }),
  );
} catch (error) {
  console.error(error.stack);
  await page
    .screenshot({ path: folder + "/failure.png", fullPage: true })
    .catch(() => {});
  throw error;
} finally {
  if (user)
    await api("/admin/users/" + user.id, "PATCH", {
      disabled: true,
      revoke_sessions: true,
    });
  if (repo) await api("/admin/repositories/" + repo.id, "DELETE");
  if (createdSpace) {
    let removed = false;
    for (let n = 0; n < 180; n++) {
      const r = await context.request.delete(
        origin + "/api/workspaces/" + space,
        { headers: { Origin: origin } },
      );
      if (r.status() === 200) {
        removed = true;
        break;
      }
      assert.equal(r.status(), 409);
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert.ok(removed, "Browser fixture cleanup");
  }
  await api("/logout", "POST", {}).catch(() => {});
  await browser.close();
  console.log(
    JSON.stringify({
      cleanup:
        "workspace/repository removed; reader disabled and sessions revoked",
      workspace: space,
    }),
  );
}
