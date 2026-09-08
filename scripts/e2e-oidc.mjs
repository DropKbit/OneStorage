import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { createHmac, randomBytes } from "node:crypto";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
const origin = process.env.TEST_ORIGIN || "http://localhost:8787",
  remote = !["localhost", "127.0.0.1"].includes(new URL(origin).hostname);
if (remote && process.env.ALLOW_REMOTE_ACCEPTANCE !== "1")
  throw Error("Remote acceptance requires opt-in");
const secrets = JSON.parse(
  await readFile(
    process.env.OIDC_FIXTURE_SECRETS || ".data/v23-idp-secrets.json",
    "utf8",
  ),
);
const token = process.env.ONESTORAGE_TOKEN_FILE
  ? (await readFile(process.env.ONESTORAGE_TOKEN_FILE, "utf8")).trim()
  : "";
const issuer =
  process.env.OIDC_FIXTURE_ISSUER ||
  "https://onestorage-oidc-acceptance.xbitfun.workers.dev";
const suffix = randomBytes(4).toString("hex"),
  adminName = "oidc_admin_" + suffix,
  newName = "oidc_user_" + suffix,
  password = randomBytes(24).toString("hex");
let adminAuth = token ? { Authorization: "Bearer " + token } : {},
  adminUser,
  newUser,
  provider,
  codes = [],
  mfaSecret,
  checks = 0;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext(),
  page = await context.newPage(),
  newContext = await browser.newContext(),
  newPage = await newContext.newPage();
page.setDefaultTimeout(30000);
newPage.setDefaultTimeout(30000);
const observed = [];
page.on("response", (r) => {
  const u = new URL(r.url());
  if (u.origin === origin && u.pathname.startsWith("/api/auth/oidc"))
    observed.push({ path: u.pathname, status: r.status() });
});
const screenshots = ".data/v23-oidc-" + (remote ? "production" : "local");
await mkdir(screenshots, { recursive: true });
function hotp(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0,
    v = 0,
    bytes = [];
  for (const c of secret) {
    v = (v << 5) | alphabet.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((v >>> bits) & 255);
    }
  }
  const count = Buffer.alloc(8);
  count.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const mac = createHmac("sha1", Buffer.from(bytes)).update(count).digest(),
    offset = mac.at(-1) & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1e6).padStart(6, "0");
}
async function admin(path, method = "GET", body, status = 200) {
  const r = await fetch(origin + "/api" + path, {
    method,
    headers: {
      Origin: origin,
      ...adminAuth,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  assert.equal(r.status, status, method + " " + path + " " + r.status);
  checks++;
  if (path === "/login")
    adminAuth = { Cookie: r.headers.get("set-cookie")?.split(";")[0] || "" };
  return r.json();
}
async function api(ctx, path, method = "GET", body, status = 200) {
  const r = await ctx.request.fetch(origin + "/api" + path, {
    method,
    headers: { Origin: origin },
    ...(body === undefined ? {} : { data: body }),
  });
  assert.equal(
    r.status(),
    status,
    method + " " + path + " " + (await r.text()).slice(0, 300),
  );
  checks++;
  return r.json();
}
async function authorize(p, subject) {
  await p.waitForURL(issuer + "/authorize**");
  await p.locator("[name=subject]").fill(subject);
  await p.locator("[name=password]").fill(secrets.TEST_PASSWORD);
  await p.getByRole("button", { name: "Authorize", exact: true }).click();
  await p.waitForURL((u) => u.origin === origin);
  assert.ok(!p.url().includes("oidc_error"), "OIDC callback succeeded");
  checks++;
}
async function sso(p, subject) {
  await p.goto(origin + "/login");
  await p
    .getByRole("button", {
      name: "使用 " + provider.name + " 登录",
      exact: true,
    })
    .click();
  await authorize(p, subject);
}
async function submit(p, selector, path, status = 200) {
  const wait = p.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api" + path &&
      r.request().method() !== "GET",
  );
  await p.locator(selector).click();
  const r = await wait;
  assert.equal(r.status(), status, path + " returned " + r.status());
  checks++;
  return path === "/admin/identity-providers" ? r.json() : {};
}
try {
  if (!token)
    await admin("/login", "POST", {
      username: "owner",
      password: "local-test-password-123",
    });
  adminUser = await admin(
    "/users",
    "POST",
    { username: adminName, password },
    201,
  );
  await admin("/admin/users/" + adminUser.id, "PATCH", { admin: true });
  await api(context, "/login", "POST", { username: adminName, password });
  await page.goto(origin + "/admin/identity");
  await page.locator("#oidc-provider").waitFor();
  const form = page.locator("#oidc-provider"),
    name = "OIDC acceptance " + suffix;
  await form.locator("[name=name]").fill(name);
  await form.locator("[name=issuer]").fill(issuer);
  await form.locator("[name=client_id]").fill("onestorage-acceptance-v23");
  await form.locator("[name=client_secret]").fill(secrets.CLIENT_SECRET);
  await form.locator("[name=allowed_hosts]").fill(new URL(issuer).hostname);
  await form.locator("[name=enabled]").check();
  await form.locator("[name=registration]").check();
  provider = await submit(
    page,
    "#oidc-provider button[type=submit]",
    "/admin/identity-providers",
    201,
  );
  assert.equal(provider.secret, undefined);
  assert.equal(provider.client_secret, undefined);
  checks++;
  await page.locator('[data-provider-edit="' + provider.id + '"]').waitFor();
  await page.locator('[data-provider-edit="' + provider.id + '"]').click();
  assert.equal(await form.locator("[name=client_secret]").inputValue(), "");
  checks++;
  await page.screenshot({
    path: screenshots + "/provider.png",
    fullPage: true,
  });
  await page.goto(origin + "/settings/account");
  await page.locator('[data-oidc-link="' + provider.id + '"]').waitFor();
  const identityForm = page
    .locator('[data-oidc-link="' + provider.id + '"]')
    .locator("..")
    .locator("..");
  await identityForm.locator("[name=password]").fill(password);
  await page.locator('[data-oidc-link="' + provider.id + '"]').click();
  await authorize(page, "linked-" + suffix);
  await page.waitForURL(origin + "/settings/account");
  assert.equal(
    (await api(context, "/account/identities")).identities.length,
    1,
  );
  checks++;
  await api(context, "/logout", "POST", {});
  await sso(page, "linked-" + suffix);
  assert.equal((await api(context, "/me")).user.id, adminUser.id);
  checks++;
  const enrollment = await api(context, "/account/mfa/setup", "POST", {
    password,
  });
  mfaSecret = enrollment.secret;
  const enabled = await api(context, "/account/mfa/enable", "POST", {
    version: enrollment.version,
    otp: hotp(mfaSecret),
  });
  codes = enabled.recovery_codes;
  await api(context, "/logout", "POST", {});
  await sso(page, "linked-" + suffix);
  await page.waitForURL(origin + "/login/oidc");
  await page.locator("#oidc-complete [name=otp]").fill("invalid");
  await submit(
    page,
    "#oidc-complete button[type=submit]",
    "/auth/oidc/complete",
    401,
  );
  await page.locator("#oidc-complete [name=otp]").fill(codes.shift());
  await submit(
    page,
    "#oidc-complete button[type=submit]",
    "/auth/oidc/complete",
  );
  await page.waitForURL(origin + "/");
  const pat = await api(
    context,
    "/tokens",
    "POST",
    { name: "OIDC derived test", scope: "read", days: 1, otp: codes.shift() },
    201,
  );
  let r = await fetch(origin + "/api/me", {
    headers: { Authorization: "Bearer " + pat.token },
  });
  assert.equal(r.status, 200);
  await r.body.cancel();
  checks++;
  const update = {
    name: provider.name,
    issuer: provider.issuer,
    client_id: provider.client_id,
    auth_method: provider.auth_method,
    allowed_hosts: provider.allowed_hosts,
    email_domains: [],
    registration: true,
  };
  provider = await admin("/admin/identity-providers/" + provider.id, "PUT", {
    ...update,
    enabled: false,
    revision: provider.revision,
  });
  assert.equal((await api(context, "/me")).user, null);
  r = await fetch(origin + "/api/me", {
    headers: { Authorization: "Bearer " + pat.token },
  });
  assert.equal(r.status, 401);
  await r.body.cancel();
  checks += 2;
  provider = await admin("/admin/identity-providers/" + provider.id, "PUT", {
    ...update,
    enabled: true,
    revision: provider.revision,
  });
  await sso(newPage, "new-" + suffix);
  await newPage.waitForURL(origin + "/login/oidc");
  await newPage.locator("#oidc-complete [name=username]").fill(newName);
  await submit(
    newPage,
    "#oidc-complete button[type=submit]",
    "/auth/oidc/complete",
    201,
  );
  await newPage.waitForURL(origin + "/");
  newUser = (await api(newContext, "/me")).user;
  assert.equal(newUser.admin, 0);
  checks++;
  const identities = await api(newContext, "/account/identities");
  assert.equal(identities.has_password, false);
  checks++;
  await api(
    newContext,
    "/account/identities/" + identities.identities[0].id + "/unlink",
    "POST",
    {},
    409,
  );
  await api(newContext, "/admin/identity-providers", "GET", undefined, 403);
  await newPage.goto(origin + "/settings/account");
  await newPage.locator("#oidc-password [name=new_password]").fill(password);
  await submit(newPage, "#oidc-password button[type=submit]", "/password");
  await newPage.waitForURL(origin + "/login");
  await api(newContext, "/login", "POST", { username: newName, password });
  await newPage.goto(origin + "/settings/account");
  await newPage.setViewportSize({ width: 390, height: 844 });
  await newPage.locator("#oidc-password").waitFor();
  assert.ok(
    await newPage.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  checks++;
  await newPage.screenshot({
    path: screenshots + "/account-mobile.png",
    fullPage: true,
  });
  console.log(
    JSON.stringify({
      checks,
      origin,
      provider: provider.id,
      admin: adminUser.id,
      newUser: newUser.id,
      verified:
        "real OIDC browser redirects, PKCE and JWT, account linking, local MFA, provider session/PAT revocation, ordinary registration, password setup, mobile",
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      at: new URL(page.url()).origin + new URL(page.url()).pathname,
      observed,
    }),
  );
  await page.screenshot({ path: screenshots + "/failure.png", fullPage: true });
  console.error(
    String(error.message)
      .replaceAll(secrets.CLIENT_SECRET, "[REDACTED]")
      .replaceAll(secrets.TEST_PASSWORD, "[REDACTED]")
      .replaceAll(password, "[REDACTED]"),
  );
  throw error;
} finally {
  if (!newUser && adminUser)
    newUser = (await admin("/admin/users?q=" + newName)).users.find(
      (u) => u.username === newName,
    );
  for (const [user, ctx, name, isMfa] of [
    [adminUser, context, adminName, true],
    [newUser, newContext, newName, false],
  ])
    if (user) {
      await admin("/admin/users/" + user.id, "PATCH", { password });
      await api(ctx, "/login", "POST", {
        username: name,
        password,
        ...(isMfa && codes.length
          ? { otp: codes.shift() }
          : isMfa && mfaSecret
            ? { otp: hotp(mfaSecret) }
            : {}),
      });
      const identities = await api(ctx, "/account/identities");
      for (const id of identities.identities)
        await api(ctx, "/account/identities/" + id.id + "/unlink", "POST", {
          password,
          ...(isMfa && codes.length ? { otp: codes.shift() } : {}),
        });
      await admin("/admin/users/" + user.id, "PATCH", {
        disabled: true,
        admin: false,
        revoke_sessions: true,
      });
    }
  if (provider)
    await admin("/admin/identity-providers/" + provider.id, "DELETE");
  await browser.close();
  console.log(
    JSON.stringify({
      cleanup:
        "test identities/provider removed; test accounts disabled and credentials revoked",
      origin,
    }),
  );
}
