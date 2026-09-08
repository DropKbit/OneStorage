import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile),
  { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const origin = process.env.TEST_ORIGIN || "http://localhost:8787",
  remote = !["localhost", "127.0.0.1"].includes(new URL(origin).hostname);
if (remote && process.env.ALLOW_REMOTE_ACCEPTANCE !== "1")
  throw Error("Remote acceptance requires opt-in");
const prefix = ".data/v37-" + (remote ? "production" : "local") + "-notebook",
  suffix = randomBytes(4).toString("hex");
const token = process.env.ONESTORAGE_TOKEN_FILE
  ? (await fs.readFile(process.env.ONESTORAGE_TOKEN_FILE, "utf8")).trim()
  : "";
let admin = token ? { Authorization: "Bearer " + token } : {},
  owner = {},
  reader = {},
  user,
  guest,
  repo,
  rp,
  checks = 0;
const browser = await chromium.launch({ headless: true }),
  ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } }),
  page = await ctx.newPage(),
  errors = [],
  external = [],
  images = [];
page.setDefaultTimeout(30000);
page.on("pageerror", (e) => errors.push(e.message));
page.on("request", (r) => {
  const u = new URL(r.url());
  if (![new URL(origin).origin, "null"].includes(u.origin))
    external.push(u.origin);
  if (u.pathname.endsWith("/preview")) images.push(u);
});
async function req(path, method = "GET", body, auth = owner, status = 200) {
  const r = await fetch(origin + "/api" + path, {
    method,
    headers: {
      Origin: origin,
      ...auth,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const data = await r.json();
  assert.equal(
    r.status,
    status,
    method + " " + path + ": " + r.status + " " + (data.error || ""),
  );
  checks++;
  return {
    data,
    auth: { Cookie: r.headers.get("set-cookie")?.split(";")[0] || "" },
  };
}
const api = async (...a) => (await req(...a)).data;
async function cookies(context, auth) {
  const [name, ...value] = auth.Cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: origin }]);
}
// Generate a small deterministic PNG graph, with real CRCs and no external fixture dependency.
function chart() {
  const width = 360,
    height = 120,
    raw = Buffer.alloc((width * 3 + 1) * height, 255);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      if (
        y > height - 15 - Math.floor(x / 60) * 15 &&
        x % 60 < 42 &&
        x % 60 > 10
      ) {
        const p = y * (width * 3 + 1) + 1 + x * 3;
        raw[p] = 38;
        raw[p + 1] = 104;
        raw[p + 2] = 220;
      }
    }
  }
  function chunk(type, data) {
    const t = Buffer.from(type),
      b = Buffer.concat([t, data]);
    let crc = 0xffffffff;
    for (const c of b) {
      crc ^= c;
      for (let i = 0; i < 8; i++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const head = Buffer.alloc(4),
      tail = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([head, b, tail]);
  }
  const ih = Buffer.alloc(13);
  ih.writeUInt32BE(width);
  ih.writeUInt32BE(height, 4);
  ih[8] = 8;
  ih[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ih),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}
const png = chart(),
  payload = "globalThis.notebookPwned=1",
  rich = (data) => ({ output_type: "display_data", data, metadata: {} });
const cells = [
  {
    cell_type: "markdown",
    source: [
      "# 实验记录\n",
      "Cloudflare 原生 Git 中的 **Notebook 预览**。\n\n![附件](attachment:chart%20one.png)\n\n[实验记录](#实验记录)\n",
    ],
    attachments: { "chart one.png": { "image/png": png } },
  },
  {
    cell_type: "code",
    source: "values = [12, 24, 36, 48]\nprint(sum(values))",
    execution_count: 1,
    outputs: [
      { output_type: "stream", name: "stdout", text: ["总和: ", "120\n"] },
      rich({
        "text/html":
          "<table><thead><tr><th>指标</th><th>结果</th></tr></thead><tbody><tr><td>Tests</td><td>367</td></tr></tbody></table>" +
          `<script>${payload}</script><img src="https://notebook.invalid/pixel" onerror="${payload}"><iframe src="https://notebook.invalid/frame"></iframe><svg onload="${payload}"></svg><form id="location"><input name="cookie"></form><a href="javascript:${payload}">危险链接</a><p style="background:url(https://notebook.invalid/css)" onclick="${payload}" id="app">静态内容</p>`,
      }),
      rich({ "image/png": png }),
      rich({ "application/json": { passed: true, count: 367 } }),
    ],
  },
  {
    cell_type: "markdown",
    source:
      "## 安全显示\n![仓库图表](chart.png)\n![外部图片](https://notebook.invalid/pixel.png)\n<script>globalThis.notebookPwned=1</script>\n[危险](javascript:alert(1))",
  },
  {
    cell_type: "code",
    source: "raise ValueError('example')",
    execution_count: 2,
    outputs: [
      {
        output_type: "error",
        ename: "ValueError",
        evalue: "example",
        traceback: ["\u001b[31mTraceback\u001b[0m", "ValueError: example"],
      },
      rich({ "application/javascript": payload }),
      rich({ "image/svg+xml": `<svg onload="${payload}"/>` }),
      rich({
        "image/png": "invalid",
        "text/plain": "图片不可显示时的文字回退",
      }),
    ],
  },
  { cell_type: "raw", source: "原始单元内容，不执行" },
  ...Array.from({ length: 25 }, (_, i) => ({
    cell_type: "code",
    source: `# Cell ${i + 6}\nresult = ${i + 6}`,
    execution_count: null,
    outputs: [],
  })),
];
const notebook = JSON.stringify(
  {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { language_info: { name: "python" } },
    cells,
  },
  null,
  2,
);
try {
  if (!token)
    admin = (
      await req(
        "/login",
        "POST",
        { username: "owner", password: "local-test-password-123" },
        {},
      )
    ).auth;
  const username = "notebook_v37_" + suffix,
    password = randomBytes(20).toString("hex"),
    guestname = "notebook_reader_" + suffix,
    guestpass = randomBytes(20).toString("hex");
  user = await api("/users", "POST", { username, password }, admin, 201);
  owner = (await req("/login", "POST", { username, password }, {})).auth;
  guest = await api(
    "/users",
    "POST",
    { username: guestname, password: guestpass },
    admin,
    201,
  );
  reader = (
    await req(
      "/login",
      "POST",
      { username: guestname, password: guestpass },
      {},
    )
  ).auth;
  repo = await api(
    "/repos",
    "POST",
    { name: "notebook-proof", visibility: "private" },
    owner,
    201,
  );
  rp = "/repos/" + username + "/notebook-proof";
  const base = "/" + username + "/notebook-proof";
  await fs.writeFile(
    prefix + "-fixture.json",
    JSON.stringify({ user: user.id, guest: guest.id, repo: repo.id, username }),
    { mode: 0o600 },
  );
  await api(rp + "/members", "PUT", { username: guestname, role: "reader" });
  const first = await api(
    rp + "/commit-files",
    "POST",
    {
      target_branch: "main",
      commit_message: "Notebook browser acceptance",
      files: [
        { path: "analysis/experiment.ipynb", content: notebook },
        { path: "analysis/chart.png", data: png },
        { path: "broken.ipynb", content: "{ invalid json" },
        {
          path: "legacy.ipynb",
          content: JSON.stringify({ nbformat: 3, worksheets: [] }),
        },
      ],
    },
    owner,
    201,
  );
  await cookies(ctx, owner);
  const url =
    origin +
    base +
    "?" +
    new URLSearchParams({
      path: "analysis/experiment.ipynb",
      ref: first.sha,
      view: "blob",
    });
  await page.goto(url);
  await page.locator(".notebook-summary").waitFor();
  assert.match(
    await page.locator(".notebook-summary").innerText(),
    /30 个单元 · python/,
  );
  assert.equal(await page.locator(".notebook-cell").count(), 25);
  assert.ok((await page.locator(".notebook-code .hljs-keyword").count()) > 0);
  assert.equal(await page.locator(".notebook-html table").count(), 1);
  assert.equal(
    await page
      .locator(
        ".notebook-html script,.notebook-html img,.notebook-html iframe,.notebook-html svg,.notebook-html form,.notebook-html input,.notebook-html [href],.notebook-html [style],.notebook-html [id],.notebook-html [onclick]",
      )
      .count(),
    0,
  );
  assert.equal(await page.evaluate(() => globalThis.notebookPwned), undefined);
  assert.match(
    await page.locator(".notebook-error").innerText(),
    /Traceback\nValueError/,
  );
  assert.equal(
    await page
      .getByText("此输出格式无法预览，请查看 JSON 源码。", { exact: true })
      .count(),
    2,
  );
  await page.waitForFunction(() =>
    [
      ...document.querySelectorAll(".notebook-markdown img,.notebook-image"),
    ].every((i) => i.complete && i.naturalWidth > 0),
  );
  assert.equal(
    await page.locator('.notebook-markdown img[src^="data:"]').count(),
    1,
  );
  assert.ok(
    images.some(
      (u) =>
        u.searchParams.get("ref") === first.sha &&
        u.searchParams.get("path") === "analysis/chart.png",
    ),
  );
  assert.deepEqual(external, []);
  checks += 9;
  await page.screenshot({ path: prefix + "-desktop.png", fullPage: false });
  await page.getByRole("button", { name: "加载更多单元", exact: true }).click();
  assert.equal(await page.locator(".notebook-cell").count(), 30);
  assert.equal(
    await page
      .getByRole("button", { name: "加载更多单元", exact: true })
      .isVisible(),
    false,
  );
  await page.getByRole("button", { name: "JSON 源码", exact: true }).click();
  assert.equal(await page.locator(".notebook-preview").isVisible(), false);
  assert.equal(await page.locator(".notebook-raw code").innerText(), notebook);
  await page.getByRole("button", { name: "预览", exact: true }).click();
  assert.equal(await page.locator(".notebook-preview").isVisible(), true);
  await page.goto(url + "#nb-cell-30");
  await page.locator("#nb-cell-30").waitFor();
  await page.goto(url + "#L10");
  await page.locator(".notebook-raw #L10").waitFor();
  checks += 5;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(url);
  await page.locator(".notebook-summary").waitFor();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.locator("#nb-cell-2").scrollIntoViewIfNeeded();
  await page.screenshot({ path: prefix + "-mobile.png", fullPage: false });
  checks++;
  for (const [path, message] of [
    ["broken.ipynb", "笔记本不是有效的 JSON"],
    ["legacy.ipynb", "目前支持 nbformat 4"],
  ]) {
    await page.goto(
      origin +
        base +
        "?" +
        new URLSearchParams({ path, ref: first.sha, view: "blob" }),
    );
    await page.getByText(message, { exact: false }).waitFor();
    await page.getByRole("button", { name: "JSON 源码", exact: true }).click();
    assert.ok(await page.locator(".notebook-raw code").innerText());
    checks++;
  }
  // Moving HEAD must not alter a preview opened at a fixed commit or its relative images.
  await api(
    rp + "/commit-files",
    "POST",
    {
      target_branch: "main",
      commit_message: "Change HEAD",
      files: [
        {
          path: "analysis/experiment.ipynb",
          content: JSON.stringify({ nbformat: 4, cells: [], metadata: {} }),
        },
      ],
    },
    owner,
    201,
  );
  await page.goto(url);
  await page.locator(".notebook-summary").waitFor();
  assert.match(
    await page.locator(".notebook-summary").innerText(),
    /30 个单元/,
  );
  checks++;
  const readerCtx = await browser.newContext();
  await cookies(readerCtx, reader);
  const readerPage = await readerCtx.newPage();
  await readerPage.goto(url);
  await readerPage.locator(".notebook-summary").waitFor();
  await api(
    rp +
      "/blob?" +
      new URLSearchParams({
        path: "analysis/experiment.ipynb",
        ref: first.sha,
      }),
    "GET",
    undefined,
    {},
    401,
  );
  await api(rp + "/members/" + guestname, "DELETE");
  await api(
    rp +
      "/blob?" +
      new URLSearchParams({
        path: "analysis/experiment.ipynb",
        ref: first.sha,
      }),
    "GET",
    undefined,
    reader,
    404,
  );
  const imageDenied = await fetch(
    origin +
      "/api" +
      rp +
      "/preview?" +
      new URLSearchParams({ path: "analysis/chart.png", ref: first.sha }),
    { headers: reader },
  );
  assert.equal(imageDenied.status, 404);
  await readerPage.reload();
  await readerPage
    .getByText("Repository not found", { exact: false })
    .waitFor();
  assert.equal(await readerPage.locator(".notebook-summary").count(), 0);
  await readerCtx.close();
  checks += 3;
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  await fs.writeFile(
    prefix + "-result.json",
    JSON.stringify(
      {
        checks,
        sha: first.sha,
        external_requests: external.length,
        page_errors: errors.length,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ stage: "passed", checks, sha: first.sha }));
} catch (e) {
  console.error(JSON.stringify({ stage: "failed", message: e.message }));
  throw e;
} finally {
  console.log(JSON.stringify({ stage: "cleanup" }));
  await browser.close();
  try {
    if (repo)
      await api("/admin/repositories/" + repo.id, "DELETE", undefined, admin);
  } finally {
    for (const u of [user, guest].filter(Boolean))
      await api(
        "/admin/users/" + u.id,
        "PATCH",
        { disabled: true, revoke_sessions: true },
        admin,
      );
  }
  if (user) {
    const ids = [user, guest]
        .filter(Boolean)
        .map((u) => "'" + u.id + "'")
        .join(","),
      rid = repo ? "'" + repo.id + "'" : "''";
    const sql = `SELECT (SELECT count(*) FROM repositories WHERE owner_id IN(${ids})) repositories,(SELECT count(*) FROM credentials WHERE user_id IN(${ids})) credentials,(SELECT count(*) FROM users WHERE id IN(${ids}) AND disabled=0) enabled_users,(SELECT count(*) FROM code_documents WHERE repo_id=${rid}) documents,(SELECT count(*) FROM code_index_state WHERE repo_id=${rid}) index_states,(SELECT count(*) FROM code_contents WHERE repo_id=${rid}) contents`;
    let counts;
    for (let i = 0; i < 60; i++) {
      const { stdout } = await exec(
        "npx",
        [
          "wrangler",
          "d1",
          "execute",
          "DB",
          ...(remote
            ? ["--remote"]
            : ["--local", "--config", "wrangler.local.jsonc"]),
          "--command",
          sql,
          "--json",
        ],
        { maxBuffer: 1024 * 1024 },
      );
      counts = JSON.parse(stdout)[0].results[0];
      if (Object.values(counts).every((n) => n === 0)) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    for (const [k, n] of Object.entries(counts))
      assert.equal(n, 0, k + " cleanup");
    await fs.writeFile(
      prefix + "-cleanup.json",
      JSON.stringify(counts, null, 2),
    );
  }
  console.log(JSON.stringify({ stage: "cleanup complete" }));
}
