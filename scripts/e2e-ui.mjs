import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
const origin = process.env.TEST_ORIGIN || "http://localhost:8787";
if (!["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw Error("This browser fixture is local-only");
// Local-only fixture traffic gets its own rate-limit bucket; production limits are unchanged.
const fixtureHeaders = {
  "cf-connecting-ip": "192.0.2." + (1 + (randomBytes(1)[0] % 254)),
};
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_EXECUTABLE
    ? { executablePath: process.env.CHROME_EXECUTABLE }
    : {}),
});
const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    extraHTTPHeaders: fixtureHeaders,
  }),
  page = await context.newPage(),
  errors = [],
  screenshots = ".data/v12-ui";
page.setDefaultTimeout(15000);
page.on("pageerror", (error) => errors.push(error.message));
const suffix = randomBytes(4).toString("hex"),
  space = "ui_v12_" + suffix,
  member = "ui_reader_" + suffix,
  password = randomBytes(16).toString("hex");
let repo,
  user,
  createdSpace = false,
  checks = 0;
await mkdir(screenshots, { recursive: true });
async function api(path, method = "GET", body, status = 200) {
  const response = await context.request.fetch(origin + "/api" + path, {
    method,
    headers: { Origin: origin },
    ...(body === undefined ? {} : { data: body }),
  });
  assert.equal(
    response.status(),
    status,
    method + " " + path + " " + (await response.text()),
  );
  checks++;
  return response.json();
}
async function submit(form, endpoint, status = 200) {
  const waiting = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api" + endpoint &&
      r.request().method() !== "GET",
  );
  await page.locator(form + " button[type=submit]").click();
  const response = await waiting;
  assert.equal(
    response.status(),
    status,
    endpoint + " " + (await response.text()),
  );
  checks++;
  return response.json();
}
async function visit(path, selector) {
  await page.goto(origin + path);
  await page.locator(selector).first().waitFor({ state: "visible" });
  checks++;
}
async function shot(name) {
  await page.screenshot({
    path: screenshots + "/" + name + ".png",
    fullPage: true,
  });
}
try {
  await visit("/login", "#login-form");
  await page.locator("#login-form input[name=username]").fill("owner");
  await page
    .locator("#login-form input[name=password]")
    .fill("incorrect-test-password");
  await submit("#login-form", "/login", 401);
  await page.locator("#login-form .error").waitFor();
  await page
    .locator("#login-form input[name=password]")
    .fill("local-test-password-123");
  await submit("#login-form", "/login");
  await page.locator("#workspace-select").waitFor();
  await visit("/admin/users", "#new-user");
  await page.locator("#new-user input[name=username]").fill(member);
  await page.locator("#new-user input[name=password]").fill(password);
  user = await submit("#new-user", "/users", 201);
  await visit("/spaces", "#create-space");
  await page.locator("#create-space input[name=slug]").fill(space);
  await page.locator("#create-space input[name=name]").fill("浏览器验收");
  await submit("#create-space", "/workspaces", 201);
  createdSpace = true;
  await page.locator("#space-member").waitFor();
  await page.locator("#space-member input[name=username]").fill(member);
  await page.locator("#space-member select[name=role]").selectOption("reader");
  await submit("#space-member", "/workspaces/" + space + "/members");
  assert.equal(
    (await api("/workspaces/" + space + "/members")).members.find(
      (u) => u.username === member,
    ).role,
    "reader",
  );
  checks++;
  await page.locator("#workspace-select").selectOption("owner");
  await page.waitForURL("**/?namespace=owner");
  await page.locator("#workspace-select").selectOption(space);
  await page.waitForURL("**/?namespace=" + space);
  checks++;
  await visit("/new", "#create");
  await page.locator("#create input[name=name]").fill("browser-project");
  await page.locator("#create select[name=namespace]").selectOption(space);
  await page
    .locator("#create textarea[name=description]")
    .fill('<img src=x onerror="window.__uiXSS=1">');
  repo = await submit("#create", "/repos", 201);
  const base = "/" + space + "/browser-project",
    ap = "/repos" + base;
  await api(
    ap + "/commit-files",
    "POST",
    {
      target_branch: "main",
      commit_message: "Browser fixture",
      files: [
        {
          path: "index.js",
          content:
            'export const message = "<img src=x onerror=window.__uiXSS=1>";\n',
        },
        {
          path: "README.md",
          content:
            "# Browser fixture\n\n**Markdown** and <script>window.__uiXSS=1</script>",
        },
        {
          path: "ci.js",
          content:
            'export default async()=>({logs:["browser pipeline passed"],artifacts:{"report.txt":"ok"}});',
        },
      ],
    },
    201,
  );
  await visit(base + "?path=index.js&view=blob", ".code-viewer");
  await page.locator(".hljs-keyword").first().waitFor();
  assert.equal(await page.evaluate(() => window.__uiXSS), undefined);
  assert.equal(await page.locator("img[src=x]").count(), 0);
  checks += 2;
  await shot("code-desktop");
  await visit(base + "/issues", "#issue-filters");
  await page.getByText("＋ 新建 Issue", { exact: true }).click();
  await page.locator("#new-issue input[name=title]").fill("UI issue");
  await page
    .locator("#new-issue textarea[name=body]")
    .fill('**Issue** <img src=x onerror="window.__uiXSS=1">');
  await submit("#new-issue", ap + "/issues", 201);
  await visit(base + "/issues", "#issue-filters");
  await page.getByRole("link", { name: "看板视图", exact: true }).click();
  await page.locator("#choose-board").waitFor();
  await shot("issues-board");
  checks++;
  await visit(base + "/ci", "#pipeline-config");
  await page.locator("#pipeline-config textarea[name=config]").fill(
    JSON.stringify({
      name: "Browser pipeline",
      runner: "worker",
      steps: [{ type: "javascript", entry: "ci.js", files: ["ci.js"] }],
    }),
  );
  await submit("#pipeline-config", ap + "/ci/config");
  await page.locator("#run-pipeline").waitFor();
  const run = await submit("#run-pipeline", ap + "/ci/runs", 201);
  for (let n = 0; n < 60; n++) {
    const r = await api(ap + "/ci/runs/" + run.id);
    if (r.status === "succeeded") break;
    if (["failed", "canceled"].includes(r.status))
      throw Error("Browser pipeline " + r.status);
    if (n === 59) throw Error("Browser pipeline timeout");
    await new Promise((r) => setTimeout(r, 500));
  }
  await visit(base + "/ci/" + run.id, ".ci-succeeded");
  await shot("ci-run");
  await visit(base + "/settings", "#project-lifecycle");
  await submit("#project-lifecycle", ap + "/lifecycle");
  await page.getByRole("button", { name: "取消归档", exact: true }).waitFor();
  await submit("#project-lifecycle", ap + "/lifecycle");
  await page.getByRole("button", { name: "归档为只读", exact: true }).waitFor();
  await page.getByText("转移或重命名项目", { exact: true }).click();
  await page.locator("#project-transfer input[name=name]").fill("renamed");
  await page.locator("#project-transfer input[name=acknowledge]").check();
  await submit("#project-transfer", ap + "/transfer");
  await page.waitForURL("**/" + space + "/renamed/settings");
  await visit(base + "/settings", "#project-lifecycle");
  assert.equal(new URL(page.url()).pathname, "/" + space + "/renamed/settings");
  checks++;
  await shot("project-settings");
  await visit("/settings/account", "h1");
  await shot("account-security");
  await visit("/admin/users", "h1");
  await shot("admin");
  await page.setViewportSize({ width: 390, height: 844 });
  await visit("/" + space + "/renamed?path=index.js&view=blob", ".code-viewer");
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    "mobile page must not overflow horizontally",
  );
  checks++;
  await shot("code-mobile");
  const readerContext = await browser.newContext({
      extraHTTPHeaders: fixtureHeaders,
    }),
    readerPage = await readerContext.newPage(),
    renamed = "/" + space + "/renamed";
  const readerLogin = await readerContext.request.post(origin + "/api/login", {
    headers: { Origin: origin },
    data: { username: member, password },
  });
  assert.equal(readerLogin.status(), 200);
  await readerPage.goto(origin + renamed + "?path=index.js&view=blob");
  await readerPage.locator(".code-viewer").waitFor();
  assert.equal(
    await readerPage
      .getByRole("link", { name: "编辑文件", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await readerPage.locator('.tabs a[href$="/settings"]').count(),
    0,
  );
  const deniedWrite = await readerContext.request.post(
    origin + "/api/repos" + renamed + "/commit-files",
    {
      headers: { Origin: origin },
      data: {
        target_branch: "main",
        commit_message: "Denied reader write",
        files: [{ path: "denied.txt", content: "must not persist" }],
      },
    },
  );
  assert.equal(deniedWrite.status(), 403);
  checks += 4;
  await readerPage.screenshot({
    path: screenshots + "/reader-role.png",
    fullPage: true,
  });
  await readerContext.close();
  const guest = await browser.newContext({ extraHTTPHeaders: fixtureHeaders }),
    anonymous = await guest.newPage();
  anonymous.on("pageerror", (error) => errors.push(error.message));
  const guestResponses = [];
  anonymous.on("response", (r) => {
    if (new URL(r.url()).pathname.startsWith("/api/"))
      guestResponses.push({
        path: new URL(r.url()).pathname,
        status: r.status(),
      });
  });
  await anonymous.goto(origin + renamed + "?path=index.js&view=blob");
  try {
    await anonymous.locator(".content .error").waitFor({ timeout: 15000 });
  } catch (error) {
    await anonymous.screenshot({
      path: screenshots + "/anonymous-failure.png",
      fullPage: true,
    });
    console.error(JSON.stringify({ guestResponses, url: anonymous.url() }));
    throw error;
  }
  assert.ok(
    guestResponses.some(
      (r) =>
        r.path === "/api/repos" + renamed && [401, 403, 404].includes(r.status),
    ),
    JSON.stringify(guestResponses),
  );
  assert.equal(await anonymous.locator(".code-viewer").count(), 0);
  checks++;
  await guest.close();
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      checks,
      space,
      browser: "Chromium headless",
      workflows:
        "login, admin user creation, workspace creation/switch, inherited reader role, project creation, highlighting and escaping, issue and board, cloud CI, archive/restore, rename and canonical redirect, account/admin screens, mobile layout, anonymous denial",
      screenshots,
    }),
  );
} catch (error) {
  console.error(error.stack);
  await shot("failure").catch(() => {});
  throw error;
} finally {
  if (repo) await api("/admin/repositories/" + repo.id, "DELETE");
  if (user)
    await api("/admin/users/" + user.id, "PATCH", {
      disabled: true,
      revoke_sessions: true,
    });
  if (createdSpace) {
    let removed = false;
    for (let n = 0; n < 120; n++) {
      const response = await context.request.delete(
        origin + "/api/workspaces/" + space,
        { headers: { Origin: origin } },
      );
      if (response.status() === 200) {
        removed = true;
        break;
      }
      assert.equal(response.status(), 409);
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert.ok(removed, "UI fixture GC");
  }
  await api("/logout", "POST");
  await browser.close();
  console.log(
    JSON.stringify({
      cleanup:
        "browser test repository/workspace removed; test user disabled and credentials revoked",
      space,
    }),
  );
}
