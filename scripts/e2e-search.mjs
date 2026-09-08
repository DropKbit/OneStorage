import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
const origin = process.env.TEST_ORIGIN || "http://localhost:8787";
const remote = !["localhost", "127.0.0.1"].includes(new URL(origin).hostname);
if (remote && process.env.ALLOW_REMOTE_ACCEPTANCE !== "1")
  throw Error("Remote acceptance requires opt-in");
const token = process.env.ONESTORAGE_TOKEN_FILE
  ? (await readFile(process.env.ONESTORAGE_TOKEN_FILE, "utf8")).trim()
  : "";
let admin = token ? { Authorization: "Bearer " + token } : {},
  checks = 0;
const timings = [];
async function request(path, method = "GET", body, auth = admin, status = 200) {
  const start = performance.now();
  const response = await fetch(origin + "/api" + path, {
    method,
    headers: {
      Origin: origin,
      ...auth,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const data = await response.json();
  assert.equal(
    response.status,
    status,
    method + " " + path.split("?")[0] + " " + (data.error || ""),
  );
  if (path.startsWith("/search?") && status === 200) {
    assert.match(response.headers.get("cache-control"), /no-store/);
    timings.push(Math.round(performance.now() - start));
  }
  checks++;
  return {
    data,
    auth: { Cookie: response.headers.get("set-cookie")?.split(";")[0] || "" },
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
const suffix = randomBytes(4).toString("hex"),
  space = "search_v28_" + suffix,
  marker = "search-" + suffix,
  repos = [],
  users = [],
  browserErrors = [];
let created = false,
  browser,
  pat;
const search = (extra = {}, auth = admin, status = 200) =>
  api(
    "/search?" + new URLSearchParams({ q: marker, namespace: space, ...extra }),
    "GET",
    undefined,
    auth,
    status,
  );
try {
  await api(
    "/workspaces",
    "POST",
    { slug: space, name: "Search acceptance" },
    admin,
    201,
  );
  created = true;
  for (const role of ["direct", "inherited"]) {
    const username = role + "_" + suffix,
      password = randomBytes(18).toString("hex");
    const user = await api(
      "/users",
      "POST",
      { username, password },
      admin,
      201,
    );
    users.push({
      ...user,
      username,
      password,
      auth: (await request("/login", "POST", { username, password }, {})).auth,
    });
  }
  for (const name of ["direct", "private", "public"]) {
    repos.push(
      await api(
        "/repos",
        "POST",
        {
          namespace: space,
          name,
          description: marker + " project",
          visibility: name === "public" ? "public" : "private",
        },
        admin,
        201,
      ),
    );
    await api(
      "/repos/" + space + "/" + name + "/issues",
      "POST",
      { title: marker + " " + name, body: "Shared search fixture" },
      admin,
      201,
    );
  }
  const ap = "/repos/" + space + "/direct";
  await api(ap + "/members", "PUT", {
    username: users[0].username,
    role: "reader",
  });
  await api("/workspaces/" + space + "/members", "PUT", {
    username: users[1].username,
    role: "reader",
  });
  await api(ap + "/wiki/guide", "PUT", {
    title: marker + " Wiki",
    body:
      "x".repeat(2000) +
      "中文检索 100%_\\ <img src=x onerror=alert(1)> " +
      marker,
    expected_version: 0,
  });
  for (const [target_branch, files] of [
    ["main", [{ path: "README.md", content: marker }]],
    ["feature", [{ path: "feature.txt", content: "search" }]],
  ]) {
    if (target_branch === "feature")
      await api(
        ap + "/branches/create",
        "POST",
        { target_branch, base_ref: "main" },
        admin,
        201,
      );
    await api(
      ap + "/commit-files",
      "POST",
      { target_branch, commit_message: "Search fixture", files },
      admin,
      201,
    );
  }
  const mr = await api(
    ap + "/merges",
    "POST",
    {
      title: marker + " Merge",
      body: "Cross-project review",
      source: "feature",
      target: "main",
    },
    admin,
    201,
  );
  const all = await search();
  assert.equal(all.results.length, 8);
  assert.deepEqual(
    [...new Set(all.results.map((r) => r.type))],
    ["issue", "merge", "project", "wiki"],
  );
  assert.equal((await search({}, {})).results.length, 2);
  assert.equal((await search({}, users[0].auth)).results.length, 6);
  assert.equal((await search({}, users[1].auth)).results.length, 8);
  const pages = [];
  let cursor;
  do {
    const page = await search({ limit: "2", ...(cursor ? { cursor } : {}) });
    pages.push(...page.results);
    cursor = page.next_cursor;
  } while (cursor);
  assert.deepEqual(pages, all.results);
  const first = await search({ limit: "1" });
  await search({ cursor: first.next_cursor, q: "changed" }, admin, 400);
  await search({ cursor: first.next_cursor }, users[0].auth, 400);
  assert.equal((await search({ state: "open" })).results.length, 4);
  assert.equal(
    (await search({ type: "wiki", q: "中文检索" })).results.length,
    1,
  );
  assert.equal((await search({ q: "100%_\\" })).results.length, 1);
  assert.equal((await search({ q: "' OR 1=1 --" })).results.length, 0);
  const wiki = (await search({ q: "中文检索" })).results[0];
  assert.match(wiki.excerpt, /中文检索/);
  assert.ok(wiki.excerpt.length <= 320);
  pat = await api(
    "/tokens",
    "POST",
    { name: "Search read-only acceptance", days: 1, scope: "read" },
    users[0].auth,
    201,
  );
  const readAuth = { Authorization: "Bearer " + pat.token };
  assert.equal((await search({}, readAuth)).results.length, 6);
  await api("/tokens/" + pat.id, "DELETE", undefined, users[0].auth);
  pat = null;
  await search({}, readAuth, 401);

  if (process.env.PLAYWRIGHT_MODULE) {
    const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const cookie = users[0].auth.Cookie;
    await context.addCookies([
      {
        name: cookie.slice(0, cookie.indexOf("=")),
        value: cookie.slice(cookie.indexOf("=") + 1),
        url: origin,
      },
    ]);
    const page = await context.newPage();
    page.on("pageerror", (e) => browserErrors.push(e.message));
    const url =
      origin +
      "/search?" +
      new URLSearchParams({ q: marker, namespace: space });
    await page.goto(url);
    await page
      .locator('#search-results[aria-busy="false"] .search-result')
      .first()
      .waitFor();
    assert.equal(await page.locator(".search-result").count(), 6);
    assert.equal(await page.locator(".search-result img").count(), 0);
    assert.ok(await page.locator(".search-result mark").count());
    await page.screenshot({
      path: ".data/v28-search-desktop.png",
      fullPage: true,
    });
    await page
      .locator('a[href="/' + space + "/direct/merges/" + mr.id + '"]')
      .click();
    await page
      .getByRole("heading", {
        name: "!" + mr.id + " " + marker + " Merge",
        exact: true,
      })
      .waitFor();
    await page.goBack();
    await page
      .locator('#search-results[aria-busy="false"] .search-result')
      .first()
      .waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page
      .locator('#search-results[aria-busy="false"] .search-result')
      .first()
      .waitFor();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.locator("#global-query").fill("中文检索");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await page
      .locator('#search-results[aria-busy="false"] .search-result')
      .first()
      .waitFor();
    assert.equal(await page.locator(".search-result").count(), 1);
    assert.equal(await page.locator(".search-result img").count(), 0);
    await page.screenshot({
      path: ".data/v28-search-mobile.png",
      fullPage: true,
    });
    assert.deepEqual(browserErrors, []);
    await browser.close();
    browser = null;
  }
  // Existing cursors cannot preserve revoked project access.
  const old = await search({ limit: "1" }, users[0].auth);
  await api(ap + "/members/" + users[0].username, "DELETE");
  assert.ok(
    (await search({ cursor: old.next_cursor }, users[0].auth)).results.every(
      (r) => r.name === "public",
    ),
  );
  await api("/workspaces/" + space + "/members/" + users[1].username, "DELETE");
  assert.equal((await search({}, users[1].auth)).results.length, 2);
  await api(ap + "/lifecycle", "PUT", { archived: true, revision: 0 });
  assert.equal((await search({ archived: "only" })).results.length, 4);
  assert.equal((await search({ archived: "exclude" })).results.length, 4);
  await api(ap + "/lifecycle", "PUT", { archived: false, revision: 1 });
  await api(ap + "/wiki/guide", "PUT", {
    title: "Revised page",
    body: "New contents",
    expected_version: 1,
  });
  assert.equal((await search({ type: "wiki" })).results.length, 0);
  assert.equal(
    (await search({ q: "New contents", type: "wiki" })).results.length,
    1,
  );
  const evidence = {
    origin,
    space,
    checks,
    browser: process.env.PLAYWRIGHT_MODULE
      ? "desktop/mobile/filter/history/link/no-overflow/no-script-injection passed"
      : "not requested",
    searchRequests: timings.length,
    medianMS: [...timings].sort((a, b) => a - b)[
      Math.floor(timings.length / 2)
    ],
    maxMS: Math.max(...timings),
    resultKinds: "project, issue, merge, wiki",
    fixture: "3 projects, 3 issues, 1 merge, 1 wiki; not a scale benchmark",
  };
  await writeFile(
    ".data/v28-" + (remote ? "production" : "local") + "-search.json",
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(JSON.stringify(evidence));
} finally {
  if (browser) await browser.close();
  for (const repo of repos.reverse())
    await api("/admin/repositories/" + repo.id, "DELETE");
  for (const user of users)
    await api("/admin/users/" + user.id, "PATCH", {
      disabled: true,
      revoke_sessions: true,
    });
  if (created) {
    let removed = false;
    for (let i = 0; i < 120; i++) {
      const response = await fetch(origin + "/api/workspaces/" + space, {
        method: "DELETE",
        headers: { Origin: origin, ...admin },
        signal: AbortSignal.timeout(120000),
      });
      if (response.status === 200) {
        removed = true;
        break;
      }
      if (response.status !== 409)
        throw Error("Workspace cleanup failed: " + response.status);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert.ok(removed, "Workspace cleanup timed out: " + space);
  }
  if (!token) await api("/logout", "POST");
  console.log(
    JSON.stringify({
      cleanup:
        "projects/workspace deleted; fixture users disabled and credentials revoked",
      space,
    }),
  );
}
