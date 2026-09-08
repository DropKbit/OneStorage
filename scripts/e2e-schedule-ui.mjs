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
  space = "schedule_ui_" + suffix,
  ap = "/repos/" + space + "/project",
  base = "/" + space + "/project",
  folder = ".data/v19-schedule-ui";
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
  await page.goto(origin + base + "/ci");
  await page.locator("#schedule-config").waitFor();
  const form = page.locator("#schedule-config");
  await form.locator("input[name=name]").fill("Weekday build");
  await form.locator("input[name=cron]").fill("0 9 * * 1-5");
  await form.locator("input[name=timezone]").fill("Asia/Singapore");
  const created = await action(
    ap + "/ci/schedules",
    "#schedule-config button[type=submit]",
    201,
  );
  await page
    .locator(`[data-action=schedule-edit][data-id="${created.id}"]`)
    .waitFor();
  const panel = page.locator('[aria-label="定时流水线"]');
  assert.match(await panel.innerText(), /Asia\/Singapore/);
  checks++;
  assert.ok(
    (await panel.innerText()).includes(
      new Date(created.next_run_at).toLocaleString("en-US", {
        timeZone: "Asia/Singapore",
      }),
    ),
  );
  checks++;
  await page
    .locator(`[data-action=schedule-edit][data-id="${created.id}"]`)
    .click();
  assert.equal(
    await form.locator("input[name=name]").inputValue(),
    "Weekday build",
  );
  checks++;
  await form.locator("input[name=name]").fill("Changed schedule");
  await action(
    ap + "/ci/schedules/" + created.id,
    "#schedule-config button[type=submit]",
  );
  await page
    .locator(`[data-action=schedule-toggle][data-id="${created.id}"]`)
    .waitFor();
  await action(
    ap + "/ci/schedules/" + created.id,
    `[data-action=schedule-toggle][data-id="${created.id}"]`,
  );
  await page
    .locator(`[data-action=schedule-own][data-id="${created.id}"]`)
    .waitFor();
  assert.match(await panel.innerText(), /已暂停/);
  checks++;
  await action(
    ap + "/ci/schedules/" + created.id + "/take-ownership",
    `[data-action=schedule-own][data-id="${created.id}"]`,
  );
  await page
    .locator(`[data-action=schedule-toggle][data-id="${created.id}"]`)
    .waitFor();
  await action(
    ap + "/ci/schedules/" + created.id,
    `[data-action=schedule-toggle][data-id="${created.id}"]`,
  );
  await page
    .locator(`[data-action=schedule-edit][data-id="${created.id}"]`)
    .waitFor();
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
    { username: "schedule_reader_" + suffix, password },
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
  await readPage.locator('[aria-label="定时流水线"]').waitFor();
  assert.equal(
    await readPage
      .locator('#schedule-config,[data-action^="schedule-"]')
      .count(),
    0,
  );
  checks++;
  await api(
    ap + "/ci/schedules",
    "POST",
    { name: "Denied", ref: "main", cron: "0 * * * *", timezone: "UTC" },
    403,
    reader,
  );
  checks++;
  await action(
    ap + "/ci/schedules/" + created.id,
    `[data-action=schedule-delete][data-id="${created.id}"]`,
  );
  await page.locator("#schedule-config").waitFor();
  assert.equal((await api(ap + "/ci/schedules")).schedules.length, 0);
  checks++;
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      checks,
      workspace: space,
      schedules:
        "create/edit/pause/takeover/resume/delete, reader API denial, desktop/mobile",
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
