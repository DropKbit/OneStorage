// Run after KEEP_REVIEW_FIXTURE=1 npm run test:reviews. Only operates on its local test fixture.
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
const origin = process.env.TEST_ORIGIN || "http://localhost:8787";
if (!["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw Error("Review browser acceptance is local-only");
const fixture = JSON.parse(
  await readFile(
    process.env.REVIEW_FIXTURE || ".data/v07-browser-fixture.json",
    "utf8",
  ),
);
assert.match(fixture.workspace, /^review_v07_[a-f0-9]+$/);
assert.equal(fixture.ap, "/repos/" + fixture.workspace + "/upstream");
assert.match(fixture.mp, new RegExp("^" + fixture.ap + "/merges/[0-9]+$"));
const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_EXECUTABLE
      ? { executablePath: process.env.CHROME_EXECUTABLE }
      : {}),
  }),
  contexts = [],
  errors = [],
  folder = ".data/v13-review-ui";
let checks = 0;
let seededRequests = 0;
await mkdir(folder, { recursive: true });
async function login(username, password) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  contexts.push(context);
  const response = await context.request.post(origin + "/api/login", {
    headers: { Origin: origin },
    data: { username, password },
  });
  assert.equal(response.status(), 200);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  return { context, page };
}
async function request(context, path, method = "GET", data, status = 200) {
  const response = await context.request.fetch(origin + "/api" + path, {
    method,
    headers: { Origin: origin },
    ...(data ? { data } : {}),
  });
  assert.equal(response.status(), status, await response.text());
  checks++;
  return response.json();
}
async function open(page) {
  await page.goto(origin + fixture.mp.replace(/^\/repos/, ""));
  await page.locator("#discussions").waitFor();
  checks++;
}
async function action(page, path, selector, status = 200) {
  const next = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api" + path &&
      r.request().method() !== "GET",
  );
  await page.locator(selector).click();
  const response = await next;
  assert.equal(response.status(), status, await response.text());
  checks++;
  return response.json();
}
async function mergeState(page, disabled) {
  await page.waitForFunction(
    (disabled) =>
      document.querySelector("#merge-reviewed button")?.disabled === disabled,
    disabled,
  );
  checks++;
}
async function creationAndPagination(owner, author) {
  const target = await request(owner.context, fixture.ap);
  const fork = await request(
    author.context,
    "/repos",
    "POST",
    {
      name: "browser_" + randomBytes(4).toString("hex"),
      visibility: "private",
      base_repo: { id: target.id },
    },
    201,
  );
  const sp = `/repos/${fixture.author.username}/${fork.name}`;
  let mp;
  try {
    await request(
      author.context,
      sp + "/branches/create",
      "POST",
      {
        target_branch: "browser-review",
        base_branch: "main",
      },
      201,
    );
    await request(
      author.context,
      sp + "/commit-files",
      "POST",
      {
        target_branch: "browser-review",
        commit_message: "Browser creation fixture",
        files: [{ path: "code.js", content: "export const version = 99;\n" }],
      },
      201,
    );
    const page = author.page;
    await page.goto(origin + fixture.ap.replace(/^\/repos/, "") + "/merges");
    await page.getByText("＋ 新建合并请求", { exact: true }).click();
    await page.locator("#merge-source-repo").selectOption(fixture.source.id);
    await page.waitForFunction(() =>
      [...document.querySelectorAll("#merge-source-branch option")].some(
        (o) => o.value === "private-work",
      ),
    );
    checks++;
    // Hold the next branch response to verify the form cannot submit stale options.
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const branchURL = origin + "/api" + sp + "/branches";
    await page.route(branchURL, async (route) => {
      await held;
      await route.continue();
    });
    try {
      await page.locator("#merge-source-repo").selectOption(fork.id);
      assert.equal(
        await page.locator("#new-merge button[type=submit]").isDisabled(),
        true,
      );
      checks++;
    } finally {
      release();
    }
    await page.waitForFunction(() =>
      [...document.querySelectorAll("#merge-source-branch option")].some(
        (o) => o.value === "browser-review",
      ),
    );
    await page.unroute(branchURL);
    assert.equal(
      await page
        .locator('#merge-source-branch option[value="private-work"]')
        .count(),
      0,
    );
    checks++;
    await page.locator("#merge-source-branch").selectOption("browser-review");
    await page
      .locator("#new-merge input[name=title]")
      .fill("Browser cross-fork creation");
    await page
      .locator("#new-merge textarea[name=body]")
      .fill("Created through the actual form");
    const created = await action(
      page,
      fixture.ap + "/merges",
      "#new-merge button[type=submit]",
      201,
    );
    mp = fixture.ap + "/merges/" + created.id;
    await page.waitForURL("**/merges/" + created.id);
    const detail = await request(owner.context, mp);
    assert.equal(detail.source_repo_id, fork.id);
    assert.equal(detail.source, "browser-review");
    checks += 2;
    await owner.page.goto(origin + mp.replace(/^\/repos/, ""));
    await owner.page
      .locator('[data-review-path="code.js"][data-review-side="old"]')
      .first()
      .click();
    assert.equal(
      await owner.page.locator("#new-discussion input[name=side]").inputValue(),
      "old",
    );
    checks++;
    await owner.page
      .locator("#new-discussion textarea[name=body]")
      .fill("Old-side browser discussion");
    const thread = await action(
      owner.page,
      mp + "/discussions",
      "#new-discussion button[type=submit]",
      201,
    );
    // Seed through public APIs; assertions on actual second-page UI follow separately.
    for (let i = 0; i < 101; i++) {
      await request(
        author.context,
        mp + `/discussions/${thread.id}/comments`,
        "POST",
        {
          body: `**Paged reply ${i}**`,
        },
        201,
      );
      seededRequests++;
    }
    await owner.page.goto(origin + mp.replace(/^\/repos/, ""));
    await owner.page.locator(`[data-open-discussion="${thread.id}"]`).click();
    assert.equal(
      await owner.page.getByText("Paged reply 100", { exact: true }).count(),
      0,
    );
    await owner.page.locator("#more-comments-" + thread.id).click();
    await owner.page.getByText("Paged reply 100", { exact: true }).waitFor();
    assert.equal(
      await owner.page
        .locator("#thread-comments-" + thread.id + " strong")
        .getByText("Paged reply 100", { exact: true })
        .count(),
      1,
    );
    assert.equal(
      await owner.page.locator("#more-comments-" + thread.id).count(),
      0,
    );
    checks += 3;
    await action(
      owner.page,
      mp + `/discussions/${thread.id}`,
      "#resolve-" + thread.id,
    );
    await owner.page.locator(`[data-open-discussion="${thread.id}"]`).click();
    await owner.page
      .getByRole("button", { name: "重新打开讨论", exact: true })
      .waitFor();
    await action(
      owner.page,
      mp + `/discussions/${thread.id}`,
      "#resolve-" + thread.id,
    );
    assert.equal(
      (await request(owner.context, mp + `/discussions/${thread.id}`)).thread
        .resolved,
      0,
    );
    checks++;
    let lastThread;
    for (let i = 0; i < 100; i++) {
      lastThread = await request(
        author.context,
        mp + "/discussions",
        "POST",
        {
          body: `Pagination discussion ${i}`,
          source_sha: detail.source_sha,
          target_sha: detail.target_sha,
        },
        201,
      );
      seededRequests++;
    }
    await owner.page.goto(origin + mp.replace(/^\/repos/, ""));
    await owner.page
      .getByRole("link", { name: "更多讨论 →", exact: true })
      .waitFor();
    assert.equal(
      await owner.page
        .getByText("Pagination discussion 99", { exact: true })
        .count(),
      0,
    );
    await owner.page
      .getByRole("link", { name: "更多讨论 →", exact: true })
      .click();
    await owner.page
      .locator(`[data-open-discussion="${lastThread.id}"]`)
      .click();
    await owner.page
      .getByText("Pagination discussion 99", { exact: true })
      .waitFor();
    assert.match(new URL(owner.page.url()).search, /discussions_after=/);
    assert.equal(
      await owner.page
        .getByRole("link", { name: "更多讨论 →", exact: true })
        .count(),
      0,
    );
    checks += 3;
    await owner.page.screenshot({
      path: folder + "/discussion-page-2.png",
      fullPage: true,
    });
  } finally {
    if (mp) await request(owner.context, mp, "PATCH", { state: "closed" });
    await request(owner.context, "/admin/repositories/" + fork.id, "DELETE");
  }
}
try {
  const owner = await login(
      "owner",
      process.env.TEST_ADMIN_PASSWORD || "local-test-password-123",
    ),
    author = await login(fixture.author.username, fixture.author.password),
    observer = await login(
      fixture.observer.username,
      fixture.observer.password,
    );
  const before = await request(owner.context, fixture.mp);
  assert.equal(
    before.state,
    "open",
    "Generate a fresh retained fixture before re-running a completed merge",
  );
  assert.equal(before.gate.allowed, true);
  await creationAndPagination(owner, author);
  await open(observer.page);
  assert.equal(
    await observer.page.locator('#review option[value="approve"]').count(),
    0,
  );
  assert.equal(await observer.page.locator("#merge-reviewed").count(), 0);
  checks += 2;
  await open(author.page);
  assert.equal(
    await author.page.locator('#review option[value="approve"]').count(),
    0,
  );
  assert.equal(await author.page.locator("#merge-reviewed").count(), 0);
  checks += 2;
  await open(owner.page);
  await mergeState(owner.page, false);
  await owner.page
    .locator('[data-review-path="code.js"][data-review-side="new"]')
    .first()
    .click();
  assert.equal(
    await owner.page.locator('#new-discussion input[name="path"]').inputValue(),
    "code.js",
  );
  checks++;
  await owner.page
    .locator('#new-discussion textarea[name="body"]')
    .fill('**Browser review** <img src=x onerror="window.__reviewXSS=1">');
  const thread = await action(
    owner.page,
    fixture.mp + "/discussions",
    "#new-discussion button[type=submit]",
    201,
  );
  await mergeState(owner.page, true);
  await open(author.page);
  await author.page.locator(`[data-open-discussion="${thread.id}"]`).click();
  await author.page
    .locator(`#reply-${thread.id} textarea[name=body]`)
    .fill("Browser author explanation");
  await action(
    author.page,
    fixture.mp + `/discussions/${thread.id}/comments`,
    `#reply-${thread.id} button[type=submit]`,
    201,
  );
  await open(owner.page);
  await owner.page.locator(`[data-open-discussion="${thread.id}"]`).click();
  await owner.page
    .getByText("Browser author explanation", { exact: true })
    .waitFor();
  assert.equal(await owner.page.evaluate(() => window.__reviewXSS), undefined);
  assert.equal(await owner.page.locator('img[src="x"]').count(), 0);
  checks += 2;
  await owner.page.screenshot({
    path: folder + "/discussion.png",
    fullPage: true,
  });
  await action(
    owner.page,
    fixture.mp + `/discussions/${thread.id}`,
    `#resolve-${thread.id}`,
  );
  await mergeState(owner.page, false);
  await owner.page
    .locator('#review select[name="verdict"]')
    .selectOption("changes");
  await owner.page
    .locator('#review textarea[name="body"]')
    .fill("Browser changes requested");
  await action(
    owner.page,
    fixture.mp + "/reviews",
    "#review button[type=submit]",
    201,
  );
  await mergeState(owner.page, true);
  await owner.page
    .locator('#review select[name="verdict"]')
    .selectOption("approve");
  await owner.page
    .locator('#review textarea[name="body"]')
    .fill("Browser independent approval");
  await action(
    owner.page,
    fixture.mp + "/reviews",
    "#review button[type=submit]",
    201,
  );
  await mergeState(owner.page, false);
  const run = await action(
    owner.page,
    fixture.mp + "/pipeline",
    '[data-collab="pipeline"]',
    201,
  );
  await owner.page.waitForURL("**/ci/" + run.id);
  for (let n = 0; n < 60; n++) {
    const state = await request(
      owner.context,
      fixture.ap + "/ci/runs/" + run.id,
    );
    if (state.status === "succeeded") break;
    if (["failed", "canceled"].includes(state.status) || n === 59)
      throw Error("Review snapshot CI " + state.status);
    await new Promise((r) => setTimeout(r, 500));
  }
  await open(owner.page);
  await mergeState(owner.page, false);
  await owner.page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await owner.page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    "mobile review must not overflow the page",
  );
  checks++;
  await owner.page.screenshot({
    path: folder + "/review-mobile.png",
    fullPage: true,
  });
  await owner.page.setViewportSize({ width: 1440, height: 1000 });
  await owner.page
    .locator('#merge-reviewed select[name="strategy"]')
    .selectOption("merge");
  await action(
    owner.page,
    fixture.mp + "/merge",
    "#merge-reviewed button[type=submit]",
  );
  await owner.page.waitForFunction(
    () =>
      !document.querySelector("#merge-reviewed") &&
      !!document.querySelector("#discussions"),
  );
  const merged = await request(owner.context, fixture.mp);
  assert.equal(merged.state, "merged");
  assert.equal(
    (await request(owner.context, fixture.ap + "/branches")).branches.find(
      (b) => b.name === "main",
    ).sha,
    merged.merged_sha,
  );
  checks += 2;
  await owner.page.screenshot({ path: folder + "/merged.png", fullPage: true });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      checks,
      seededRequests,
      assertionsExcludingSeedRequests: checks - seededRequests,
      workspace: fixture.workspace,
      mergeRequest: merged.id,
      mergedSHA: merged.merged_sha,
      workflows:
        "cross-fork creation and branch switching, old/new diff selection, discussion and reply pagination, reopen discussion, observer and author permissions, escaping, resolution gate, request changes and independent approval, snapshot CI, mobile, merge outcome",
      screenshots: folder,
    }),
  );
} catch (error) {
  console.error(error.stack);
  for (let i = 0; i < contexts.length; i++)
    for (const page of contexts[i].pages())
      await page
        .screenshot({ path: folder + `/failure-${i}.png`, fullPage: true })
        .catch(() => {});
  throw error;
} finally {
  for (const context of contexts)
    await context.request
      .post(origin + "/api/logout", { headers: { Origin: origin } })
      .catch(() => {});
  await browser.close();
}
