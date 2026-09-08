import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHmac, randomBytes } from "node:crypto";
const origin = process.env.TEST_ORIGIN || "http://localhost:8787",
  remote = !["localhost", "127.0.0.1"].includes(new URL(origin).hostname);
if (remote && process.env.ALLOW_REMOTE_ACCEPTANCE !== "1")
  throw Error("Remote acceptance requires opt-in");
const token = process.env.ONESTORAGE_TOKEN_FILE
  ? (await readFile(process.env.ONESTORAGE_TOKEN_FILE, "utf8")).trim()
  : "";
let checks = 0,
  admin = token ? { Authorization: "Bearer " + token } : {};
async function req(path, method = "GET", body, auth = {}, status = 200) {
  const r = await fetch(origin + "/api" + path, {
    method,
    headers: {
      Origin: origin,
      ...auth,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  assert.equal(r.status, status, method + " " + path + " returned " + r.status);
  checks++;
  const type = r.headers.get("content-type") || "";
  return {
    data: type.includes("json")
      ? await r.json()
      : new Uint8Array(await r.arrayBuffer()),
    auth: { Cookie: r.headers.get("set-cookie")?.split(";")[0] || "" },
    headers: r.headers,
  };
}
if (!token)
  admin = (
    await req("/login", "POST", {
      username: "owner",
      password: "local-test-password-123",
    })
  ).auth;
const username = "accept_v06_" + randomBytes(4).toString("hex"),
  password = randomBytes(20).toString("hex"),
  user = (await req("/users", "POST", { username, password }, admin, 201)).data;
await writeFile(
  ".data/v06-last-fixture.json",
  JSON.stringify({ username, id: user.id }),
  { mode: 0o600 },
);
let ap, repo;
try {
  const a = (await req("/login", "POST", { username, password })).auth,
    b = (await req("/login", "POST", { username, password })).auth;
  await req("/account/security", "GET", undefined, {}, 403);
  await req(
    "/profile",
    "PUT",
    {
      display_name: "Cloud security acceptance",
      bio: "**Markdown** profile",
      website: "javascript:alert(1)",
    },
    a,
    400,
  );
  await req(
    "/profile",
    "PUT",
    {
      display_name: "Cloud security acceptance",
      bio: "**Markdown** profile",
      website: "https://example.com",
    },
    a,
  );
  assert.equal(
    (await req("/profiles/" + username)).data.profile.display_name,
    "Cloud security acceptance",
  );
  repo = (
    await req(
      "/repos",
      "POST",
      { name: "preview", visibility: "private" },
      a,
      201,
    )
  ).data;
  ap = "/repos/" + username + "/preview";
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1sAAAAASUVORK5CYII=";
  const commit = (
    await req(
      ap + "/commit-files",
      "POST",
      {
        target_branch: "main",
        commit_message: "Private Markdown preview",
        files: [
          {
            path: "README.md",
            content:
              "# Markdown\n\n![Pixel](pixel.png)\n\n- [x] Works\n\n```javascript\nconst cloud = true;\n```",
          },
          { path: "pixel.png", data: png },
          {
            path: "unsafe.svg",
            content:
              '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
          },
        ],
      },
      a,
      201,
    )
  ).data;
  assert.equal(
    (await req("/profiles/" + username)).data.repositories.length,
    0,
  );
  assert.equal((await req("/profiles/" + username)).data.activity.length, 0);
  assert.equal(
    (await req("/profiles/" + username, "GET", undefined, a)).data.repositories
      .length,
    1,
  );
  const preview = await req(
    ap + "/preview?ref=main&path=pixel.png",
    "GET",
    undefined,
    a,
  );
  assert.equal(preview.headers.get("content-type"), "image/png");
  assert.equal(preview.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(Buffer.from(preview.data), Buffer.from(png, "base64"));
  await req(ap + "/preview?ref=main&path=pixel.png", "GET", undefined, {}, 401);
  await req(ap + "/preview?ref=main&path=unsafe.svg", "GET", undefined, a, 400);
  const setup = (await req("/account/mfa/setup", "POST", { password }, a)).data;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of setup.secret)
    bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  const secret = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2))),
    counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const mac = createHmac("sha1", secret).update(counter).digest(),
    offset = mac[19] & 15,
    otp = String((mac.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(
      6,
      "0",
    );
  const enabled = (
      await req(
        "/account/mfa/enable",
        "POST",
        { version: setup.version, otp },
        a,
      )
    ).data,
    codes = enabled.recovery_codes;
  assert.equal(codes.length, 10);
  assert.equal(
    (await req("/account/security", "GET", undefined, a)).data
      .recovery_codes_remaining,
    10,
  );
  await req("/account/security", "GET", undefined, b, 403);
  assert.equal(
    (await req("/login", "POST", { username, password }, {}, 401)).data
      .mfa_required,
    true,
  );
  await req("/login", "POST", { username, password, otp }, {}, 401);
  await req("/tokens", "POST", { name: "denied-without-factor" }, a, 403);
  const c = (await req("/login", "POST", { username, password, otp: codes[0] }))
    .auth;
  await req("/login", "POST", { username, password, otp: codes[0] }, {}, 401);
  const pat = (
    await req("/tokens", "POST", { name: "MFA test", otp: codes[1] }, a, 201)
  ).data;
  await req(
    "/account/security",
    "GET",
    undefined,
    { Authorization: "Bearer " + pat.token },
    403,
  );
  assert.equal(
    (
      await req("/me", "GET", undefined, {
        Authorization: "Bearer " + pat.token,
      })
    ).data.user.username,
    username,
  );
  const sessions = (await req("/account/sessions", "GET", undefined, a)).data
    .sessions;
  assert.equal(sessions.length, 2);
  assert.ok(sessions.every((s) => !s.hash));
  await req(
    "/account/sessions/" + sessions.find((s) => !s.current).id,
    "DELETE",
    undefined,
    a,
  );
  await req("/account/security", "GET", undefined, c, 403);
  const rotated = (
    await req("/account/mfa/recovery", "POST", { password, otp: codes[2] }, a)
  ).data.recovery_codes;
  assert.equal(rotated.length, 10);
  await req("/login", "POST", { username, password, otp: codes[3] }, {}, 401);
  await req("/account/mfa/disable", "POST", { password, otp: rotated[0] }, a);
  assert.equal(
    (await req("/account/security", "GET", undefined, a)).data.enabled,
    false,
  );
  const d = (await req("/login", "POST", { username, password })).auth;
  await req(
    "/password",
    "POST",
    { current_password: password, new_password: password + "new" },
    d,
  );
  await req("/account/security", "GET", undefined, a, 403);
  await req(
    "/me",
    "GET",
    undefined,
    { Authorization: "Bearer " + pat.token },
    401,
  );
  const e = (
    await req("/login", "POST", { username, password: password + "new" })
  ).auth;
  await req("/profile", "GET", undefined, e);
  // The temporary browser account is retained only when explicitly requested for local visual QA.
  if (!remote && process.env.KEEP_ACCOUNT_FIXTURE === "1") {
    await writeFile(
      ".data/v06-browser-fixture.json",
      JSON.stringify({
        username,
        password: password + "new",
        repo: username + "/preview",
      }),
      { mode: 0o600 },
    );
    console.log(JSON.stringify({ checks, username, retained: true }));
    process.exit(0);
  }
} finally {
  if (repo)
    await req("/admin/repositories/" + repo.id, "DELETE", undefined, admin);
  await req(
    "/admin/users/" + user.id,
    "PATCH",
    { disabled: true, revoke_sessions: true },
    admin,
  );
}
await req("/profiles/" + username, "GET", undefined, {}, 404);
console.log(
  JSON.stringify({
    checks,
    username,
    disabled: true,
    repository_deleted: true,
    origin,
  }),
);
