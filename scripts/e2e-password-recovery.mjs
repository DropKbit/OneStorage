import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, createHmac } from "node:crypto";
import { generateKeyPair, exportSPKI, SignJWT } from "jose";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
const origin = process.env.TEST_ORIGIN || "http://localhost:8787";
const remote = !["localhost", "127.0.0.1"].includes(new URL(origin).hostname);
if (remote && process.env.ALLOW_REMOTE_ACCEPTANCE !== "1")
  throw Error("Remote acceptance requires opt-in");
const label = remote ? "production" : "local",
  prefix = `.data/v30-${label}-recovery`;
await fs.mkdir(".data", { recursive: true });
const token = process.env.ONESTORAGE_TOKEN_FILE
  ? (await fs.readFile(process.env.ONESTORAGE_TOKEN_FILE, "utf8")).trim()
  : "";
let admin = token ? { Authorization: `Bearer ${token}` } : {},
  checks = 0;
const username = "recovery_v30_" + randomBytes(4).toString("hex");
let password = randomBytes(20).toString("hex"),
  owner = {},
  user,
  repo,
  codes = [],
  codeIndex = 0;
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  }),
  page = await ctx.newPage();
const anonymous = await browser.newContext({
    viewport: { width: 390, height: 844 },
  }),
  recoveryPage = await anonymous.newPage();
page.setDefaultTimeout(30000);
recoveryPage.setDefaultTimeout(30000);
const pageErrors = [];
for (const p of [page, recoveryPage])
  p.on("pageerror", () => pageErrors.push("pageerror"));
async function req(path, method = "GET", body, auth = {}, status = 200) {
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
  assert.equal(r.status, status, `${method} ${path}: HTTP ${r.status}`);
  checks++;
  return {
    data: r.headers.get("content-type")?.includes("json")
      ? await r.json()
      : await r.text(),
    auth: { Cookie: r.headers.get("set-cookie")?.split(";")[0] || "" },
  };
}
async function login() {
  owner = (
    await req("/login", "POST", {
      username,
      password,
      ...(codes.length ? { otp: codes[codeIndex++] } : {}),
    })
  ).auth;
  return owner;
}
async function browserSession() {
  const cookie = owner.Cookie.split("=");
  await ctx.addCookies([
    { name: cookie[0], value: cookie.slice(1).join("="), url: origin },
  ]);
}
async function submit(p, selector, path, method, status = 200) {
  const response = p.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api" + path &&
      r.request().method() === method,
  );
  await p.locator(selector).getByRole("button", { name: /./ }).click();
  const r = await response;
  assert.equal(r.status(), status, `${method} ${path}`);
  checks++;
  return r.json();
}
async function accountPage() {
  await page.goto(origin + "/settings/account");
  await page
    .getByRole("heading", { name: "忘记密码时恢复账户", exact: true })
    .waitFor();
}
async function issueUI() {
  await page.locator("#issue-password-recovery [name=password]").fill(password);
  if (codes.length)
    await page
      .locator("#issue-password-recovery [name=otp]")
      .fill(codes[codeIndex++]);
  const issued = await submit(
    page,
    "#issue-password-recovery",
    "/account/password-recovery",
    "PUT",
  );
  await page.getByRole("heading", { name: "现在保存密码恢复密钥" }).waitFor();
  assert.ok(
    (await page.locator(".recovery-key").textContent()) === issued.key,
    "displayed recovery key matches issuance",
  );
  assert.match(
    await page.locator("#password-key-status").textContent(),
    /已启用/,
  );
  return issued;
}
function otp(secret) {
  let bits = 0,
    value = 0,
    bytes = [];
  for (const ch of secret) {
    value = (value << 5) | "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 255);
    }
  }
  const t = Buffer.alloc(8);
  t.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const mac = createHmac("sha1", Buffer.from(bytes)).update(t).digest(),
    i = mac.at(-1) & 15;
  return String((mac.readUInt32BE(i) & 0x7fffffff) % 1000000).padStart(6, "0");
}
async function recoverUI(key, next, code) {
  await recoveryPage.goto(origin + "/login");
  await recoveryPage
    .getByRole("link", { name: "忘记密码？", exact: true })
    .click();
  await recoveryPage.waitForURL(origin + "/login/recover");
  await recoveryPage
    .getByRole("heading", { name: "找回密码", exact: true })
    .waitFor();
  assert.equal(
    await recoveryPage.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await recoveryPage.screenshot({
    path: prefix + "-form-mobile.png",
    fullPage: true,
  });
  for (const [name, value] of Object.entries({
    username,
    key,
    new_password: next,
    confirm_password: next,
    otp: code || "",
  }))
    await recoveryPage.locator(`#recover-password [name=${name}]`).fill(value);
  await submit(recoveryPage, "#recover-password", "/recover-password", "POST");
  password = next;
  await recoveryPage.getByRole("heading", { name: "密码已重设" }).waitFor();
  assert.equal(await recoveryPage.locator("#recover-password").count(), 0);
}
try {
  if (!token)
    admin = (
      await req("/login", "POST", {
        username: "owner",
        password: "local-test-password-123",
      })
    ).auth;
  user = (await req("/users", "POST", { username, password }, admin, 201)).data;
  await fs.writeFile(
    prefix + "-fixture.json",
    JSON.stringify({ username, user_id: user.id }),
    { mode: 0o600 },
  );
  await login();
  await browserSession();
  repo = (
    await req(
      "/repos",
      "POST",
      { name: "recovery-proof", visibility: "private" },
      owner,
      201,
    )
  ).data;
  await fs.writeFile(
    prefix + "-fixture.json",
    JSON.stringify({ username, user_id: user.id, repo: repo.id }),
    { mode: 0o600 },
  );
  const rp = "/repos/" + username + "/recovery-proof";
  await req(
    rp + "/commit-files",
    "POST",
    {
      target_branch: "main",
      commit_message: "Recovery preserves Git history",
      files: [{ path: "README.md", content: "private recovery acceptance" }],
    },
    owner,
    201,
  );
  const before = (
    await req(rp + "/file?ref=main&path=README.md", "GET", undefined, owner)
  ).data;
  const pat = (
    await req(
      "/tokens",
      "POST",
      { name: "revoke on password recovery" },
      owner,
      201,
    )
  ).data.token;
  const oldPat = { Authorization: `Bearer ${pat}` },
    oldSession = owner;
  const kp = await generateKeyPair("ES256");
  const publicKey = (
    await req(
      "/api-keys",
      "POST",
      {
        name: "recovery delegate",
        algorithm: "ES256",
        public_key: await exportSPKI(kp.publicKey),
      },
      owner,
      201,
    )
  ).data;
  const jwt = await new SignJWT({
    scopes: ["git:read"],
    repo: username + "/recovery-proof",
  })
    .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: publicKey.id })
    .setIssuer(username)
    .setSubject("acceptance")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(kp.privateKey);
  const delegated = { Authorization: `Bearer ${jwt}` };
  await req(rp + "/file?ref=main&path=README.md", "GET", undefined, delegated);
  await req("/account/password-recovery", "GET", undefined, oldPat, 403);
  await req(
    "/recover-password",
    "POST",
    {
      username,
      key: "a".repeat(64),
      new_password: randomBytes(20).toString("hex"),
    },
    delegated,
    403,
  );
  console.log(JSON.stringify({ stage: "browser recovery controls" }));
  await accountPage();
  const first = await issueUI();
  // Download remains on this computer; inspect in memory and remove the temporary download.
  const downloadEvent = page.waitForEvent("download");
  await page.locator("#download-password-key").click();
  const download = await downloadEvent;
  const downloaded = await fs.readFile(await download.path(), "utf8");
  assert.ok(downloaded.includes(first.key) && downloaded.includes(username));
  await download.delete();
  await page.locator("#saved-password-key").click();
  await page.locator("#issue-password-recovery").waitFor();
  const second = await issueUI();
  await req(
    "/recover-password",
    "POST",
    { username, key: first.key, new_password: randomBytes(20).toString("hex") },
    {},
    401,
  );
  await page.locator("#saved-password-key").click();
  await page
    .locator("#revoke-password-recovery")
    .waitFor({ state: "attached" });
  await page
    .locator("#revoke-password-recovery")
    .evaluate((f) => (f.closest("details").open = true));
  await page
    .locator("#revoke-password-recovery [name=password]")
    .fill(password);
  await submit(
    page,
    "#revoke-password-recovery",
    "/account/password-recovery",
    "DELETE",
  );
  await page.locator("#issue-password-recovery").waitFor();
  assert.equal(
    (await req("/account/password-recovery", "GET", undefined, owner)).data
      .enabled,
    false,
  );
  const key = await issueUI();
  // Never put any saved recovery key or MFA seed in screenshots or log output.
  await page.screenshot({
    path: prefix + "-desktop.png",
    fullPage: true,
    mask: [page.locator(".recovery-key")],
  });
  await recoverUI(key.key, randomBytes(20).toString("hex"));
  await recoveryPage.screenshot({
    path: prefix + "-mobile.png",
    fullPage: true,
  });
  assert.equal(
    await recoveryPage.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  assert.equal(
    (await req("/me", "GET", undefined, oldSession)).data.user,
    null,
  );
  await req(rp, "GET", undefined, oldPat, 401);
  await req(rp, "GET", undefined, delegated, 401);
  await req(
    "/recover-password",
    "POST",
    { username, key: key.key, new_password: randomBytes(20).toString("hex") },
    {},
    401,
  );
  await login();
  await browserSession();
  assert.deepEqual(
    (await req(rp + "/file?ref=main&path=README.md", "GET", undefined, owner))
      .data,
    before,
  );
  assert.equal(
    (await req("/api-keys", "GET", undefined, owner)).data.keys.length,
    0,
  );
  console.log(JSON.stringify({ stage: "MFA recovery" }));
  const preMfa = (
    await req(
      "/account/password-recovery",
      "PUT",
      { password, version: null },
      owner,
    )
  ).data;
  const setup = (await req("/account/mfa/setup", "POST", { password }, owner))
    .data;
  codes = (
    await req(
      "/account/mfa/enable",
      "POST",
      { version: setup.version, otp: otp(setup.secret) },
      owner,
    )
  ).data.recovery_codes;
  assert.equal(
    (await req("/account/password-recovery", "GET", undefined, owner)).data
      .enabled,
    false,
  );
  await req(
    "/recover-password",
    "POST",
    {
      username,
      key: preMfa.key,
      new_password: randomBytes(20).toString("hex"),
    },
    {},
    401,
  );
  await accountPage();
  const mfaKey = await issueUI();
  await req(
    "/recover-password",
    "POST",
    {
      username,
      key: mfaKey.key,
      new_password: randomBytes(20).toString("hex"),
    },
    {},
    401,
  );
  await recoverUI(
    mfaKey.key,
    randomBytes(20).toString("hex"),
    codes[codeIndex++],
  );
  const noFactor = await req("/login", "POST", { username, password }, {}, 401);
  assert.equal(noFactor.data.mfa_required, true);
  await login();
  await browserSession();
  assert.equal(
    (await req("/account/security", "GET", undefined, owner)).data.enabled,
    true,
  );
  const status = (
    await req("/account/password-recovery", "GET", undefined, owner)
  ).data;
  assert.equal(
    status.history.filter((x) => x.action === "account.password_recovery.use")
      .length,
    2,
  );
  assert.equal(status.enabled, false);
  assert.deepEqual(
    (await req(rp + "/file?ref=main&path=README.md", "GET", undefined, owner))
      .data,
    before,
  );
  await accountPage();
  await issueUI();
  await req(
    "/admin/users/" + user.id,
    "PATCH",
    { revoke_sessions: true },
    admin,
  );
  await login();
  assert.equal(
    (await req("/account/password-recovery", "GET", undefined, owner)).data
      .enabled,
    false,
  );
  assert.deepEqual(pageErrors, []);
  const result = {
    origin,
    username,
    user_id: user.id,
    repo: repo.id,
    checks,
    browser:
      "desktop/mobile generation, download, rotation, revoke, password recovery and MFA recovery passed",
    git: "private committed file unchanged after both recoveries",
    credentials: "old session, PAT and actual signed JWT rejected",
    mfa: "preserved; valid second factor required",
    adminRevocation: "saved key removed",
  };
  await fs.writeFile(prefix + ".json", JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
} finally {
  console.log(JSON.stringify({ stage: "cleanup" }));
  await browser.close();
  try {
    if (repo)
      await req("/admin/repositories/" + repo.id, "DELETE", undefined, admin);
  } finally {
    if (user)
      await req(
        "/admin/users/" + user.id,
        "PATCH",
        { disabled: true, revoke_sessions: true },
        admin,
      );
  }
  if (user) {
    const q = (s) => "'" + s.replaceAll("'", "''") + "'";
    const sql = `SELECT (SELECT count(*) FROM repositories WHERE owner_id=${q(user.id)}) repositories,(SELECT count(*) FROM credentials WHERE user_id=${q(user.id)}) credentials,(SELECT count(*) FROM password_recovery WHERE user_id=${q(user.id)}) recovery_keys,(SELECT count(*) FROM users WHERE id=${q(user.id)} AND disabled=0) enabled_users`;
    let counts;
    for (let i = 0; i < 40; i++) {
      const args = [
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
      ];
      const { stdout } = await promisify(execFile)("npx", args, {
        timeout: 60000,
        maxBuffer: 1048576,
      });
      counts = JSON.parse(stdout.slice(stdout.indexOf("[")))[0].results[0];
      if (Object.values(counts).every((n) => n === 0)) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    for (const [name, count] of Object.entries(counts))
      assert.equal(count, 0, name + " cleanup");
    await fs.writeFile(
      prefix + "-cleanup.json",
      JSON.stringify(counts, null, 2) + "\n",
    );
  }
  console.log(
    JSON.stringify({
      cleanup:
        "D1 confirms repository removed, fixture account disabled, credentials and recovery key revoked",
      username,
    }),
  );
}
