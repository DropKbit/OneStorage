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
    timezoneId: "America/New_York",
  }),
  page = await context.newPage();
page.setDefaultTimeout(15000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const suffix = crypto.randomUUID().slice(0, 8),
  space = "cache_ui_" + suffix,
  ap = "/repos/" + space + "/project",
  base = "/" + space + "/project",
  folder = ".data/v21-cache-ui";
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
  await api(
    ap + "/commit-files",
    "POST",
    {
      target_branch: "main",
      commit_message: "Cache browser fixture",
      files: [
        {
          path: "ci.js",
          content:
            "export default async()=>({caches:{deps:{'.cache/file':{content:'browser-payload'}}}})",
        },
      ],
    },
    201,
  );
  await api(ap + "/ci/config", "PUT", {
    enabled: false,
    config: {
      name: "Cache browser",
      runner: "worker",
      caches: [{ id: "deps", key: "browser-cache", paths: [".cache"] }],
      steps: [{ type: "javascript", entry: "ci.js", files: ["ci.js"] }],
    },
  });
  const run = await api(ap + "/ci/runs", "POST", { ref: "main" }, 201);
  await done(run.id);
  await page.goto(origin + base + "/ci");
  const panel = page.locator('[aria-label="构建缓存"]');
  await panel.waitFor();
  assert.ok((await panel.innerText()).includes("browser-cache"));
  checks++;
  assert.ok(!(await page.content()).includes("browser-payload"));
  checks++;
  await panel.getByRole("link", { name: "来源任务" }).click();
  await page.locator(".ci-log").waitFor();
  assert.match(await page.locator(".ci-log").innerText(), /Cache SAVED deps/);
  checks++;
  await page.goto(origin + base + "/ci");
  await panel.waitFor();
  await page.screenshot({ path: folder + "/desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  checks++;
  await page.screenshot({ path: folder + "/mobile.png", fullPage: true });
  const password = crypto.randomUUID() + crypto.randomUUID();
  user = await api(
    "/users",
    "POST",
    { username: "cache_reader_" + suffix, password },
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
  await readPage.locator('[aria-label="构建缓存"]').waitFor();
  assert.equal(
    await readPage.locator('[data-action="cache-clear"]').count(),
    0,
  );
  checks++;
  const metadata = await api(ap + "/ci/caches", "GET", undefined, 200, reader);
  assert.equal(metadata.entries.length, 1);
  checks++;
  assert.ok(!JSON.stringify(metadata).includes("browser-payload"));
  checks++;
  await api(
    ap + "/ci/caches/clear",
    "POST",
    { generation: metadata.generation },
    403,
    reader,
  );
  checks++;
  await action(ap + "/ci/caches/clear", '[data-action="cache-clear"]');
  await page.locator('[aria-label="构建缓存"]').waitFor();
  assert.equal((await api(ap + "/ci/caches")).entries.length, 0);
  checks++;
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      checks,
      workspace: space,
      cache:
        "cache metadata, source task, generation clear, reader permissions, desktop/mobile",
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
