import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
const playwright = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const { chromium } = playwright.default || playwright;
const origin = process.env.TEST_ORIGIN || "http://localhost:8787";
if (!["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw Error("This fixture is local-only");
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_EXECUTABLE
    ? { executablePath: process.env.CHROME_EXECUTABLE }
    : {}),
});
const context = await browser.newContext({
  locale: "en-US",
  viewport: { width: 1440, height: 1000 },
  extraHTTPHeaders: { "cf-connecting-ip": "192.0.2.38" },
});
const page = await context.newPage(),
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.setDefaultTimeout(15000);
const suffix = randomBytes(4).toString("hex"),
  name = "language-" + suffix,
  userText = "用户原文 项目 保持中文 " + suffix;
let created = false;
const api = async (p, method = "GET", body, status = 200) => {
  const r = await context.request.fetch(origin + "/api" + p, {
    method,
    headers: { Origin: origin },
    ...(body ? { data: body } : {}),
  });
  assert.equal(r.status(), status, p + ": " + (await r.text()));
  return r.json();
};
const visit = async (path, selector) => {
  await page.goto(origin + path);
  await page.locator(selector).first().waitFor();
  await page.locator(".page-loading").waitFor({ state: "detached" });
};
try {
  if ((await api("/setup")).required)
    await api(
      "/setup",
      "POST",
      {
        username: "owner",
        password: "local-test-password-123",
        secret: "local-development-only-change-me",
      },
      201,
    );
  await visit("/login", "#login-form");
  assert.equal(await page.locator("html").getAttribute("lang"), "en");
  assert.equal(
    await page.locator("#login-form h2").textContent(),
    "Welcome back",
  );
  await page.locator("input[name=username]").fill("owner");
  await page.locator("input[name=password]").fill("local-test-password-123");
  await page.locator("#login-form button[type=submit]").click();
  await page.locator("#workspace-select").waitFor();
  await api(
    "/repos",
    "POST",
    { namespace: "owner", name, description: userText, visibility: "private" },
    201,
  );
  created = true;
  await api(
    `/repos/owner/${name}/commit-files`,
    "POST",
    {
      target_branch: "main",
      commit_message: userText,
      files: [
        { path: "README.md", content: "# " + userText + "\n" },
        { path: "code.js", content: 'const value = "中文代码";\n' },
      ],
    },
    201,
  );
  const paths = [
    ["/", ".repo-row"],
    ["/spaces", "#create-space"],
    ["/admin/users", "#new-user"],
    ["/settings/account", ".content"],
    ["/settings/tokens", "#new-token"],
    ["/settings/keys", ".content"],
    ["/search", ".content"],
    [`/owner/${name}`, ".tabs"],
    [`/owner/${name}/issues`, ".content"],
    [`/owner/${name}/ci`, ".content"],
    [`/owner/${name}/packages`, ".content"],
    [`/owner/${name}/members`, ".content"],
    [`/owner/${name}/settings`, ".content"],
  ];
  const leftovers = [];
  for (const [path, selector] of paths) {
    await visit(path, selector);
    assert.equal(await page.locator("html").getAttribute("lang"), "en");
    const text = await page.locator("body").innerText();
    const visible = text
      .replaceAll(userText, "")
      .replaceAll("简体中文", "")
      .replaceAll("Language / 语言", "");
    if (/\p{Script=Han}/u.test(visible))
      leftovers.push({
        path,
        text: visible.split("\n").filter((s) => /\p{Script=Han}/u.test(s)),
      });
  }
  assert.deepEqual(leftovers, []);
  await visit(`/owner/${name}`, ".tabs");
  assert.ok((await page.locator("body").innerText()).includes(userText));
  await mkdir(".data/v38-i18n", { recursive: true });
  await page.screenshot({ path: ".data/v38-i18n/english.png", fullPage: true });
  await page.locator("select[data-language]").selectOption("zh-CN");
  await page.waitForURL("**lang=zh-CN");
  await page.getByRole("link", { name: "账户安全", exact: true }).waitFor();
  assert.equal(await page.locator("html").getAttribute("lang"), "zh-CN");
  await page.goto(origin + "/spaces");
  await page.getByRole("heading", { name: "工作空间", exact: true }).waitFor();
  assert.equal(await page.locator("html").getAttribute("lang"), "zh-CN");
  await page.locator("select[data-language]").selectOption("en");
  await page.waitForURL("**lang=en");
  await page.getByRole("heading", { name: "Workspace", exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await visit("/admin/users", "#new-user");
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  await page.screenshot({ path: ".data/v38-i18n/mobile.png", fullPage: true });
  await page.goto(origin + "/docs");
  await page.waitForURL("**/docs/en/index.html");
  await page
    .getByRole("heading", { name: "Documentation", exact: true })
    .waitFor();
  await page.goto(origin + "/docs/en/README.html");
  await page.locator("main h1").waitFor();
  assert.ok((await page.locator("main").innerText()).includes("Cloudflare"));
  await page
    .getByRole("link", { name: "简体中文", exact: true })
    .first()
    .click();
  await page.waitForURL("**/docs/zh-CN/README.html");
  assert.equal(await page.locator("html").getAttribute("lang"), "zh-CN");
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  await page.screenshot({
    path: ".data/v38-i18n/docs-mobile.png",
    fullPage: true,
  });
  await page.goto(origin + "/spaces");
  await page.getByRole("heading", { name: "工作空间", exact: true }).waitFor();
  const shell = await context.request.get(origin + "/?lang=en", {
    headers: { "If-None-Match": '"stale-language"' },
  });
  assert.equal(shell.status(), 200);
  assert.equal(shell.headers()["content-language"], "en");
  assert.match(await shell.text(), /<html[^>]+lang="en"/);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      routes: paths.length,
      languages: 2,
      persistence: true,
      userContent: "unchanged",
      mobile: "passed",
    }),
  );
} finally {
  if (created) await api(`/repos/owner/${name}`, "DELETE");
  await api("/logout", "POST", {});
  await browser.close();
}
