import assert from "node:assert/strict";
import { generateKeyPair, exportSPKI, SignJWT } from "jose";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
const origin = process.env.TEST_ORIGIN || "http://localhost:8787";
if (!["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw Error("Local Git integration only");
const username = process.env.TEST_ADMIN_USERNAME || "owner";
let cookie = "";
async function api(path, method = "GET", body, status = 200) {
  const r = await fetch(origin + "/api" + path, {
    method,
    headers: {
      Cookie: cookie,
      Origin: origin,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.headers.get("set-cookie"))
    cookie = r.headers.get("set-cookie").split(";")[0];
  const data = await r.json();
  assert.equal(r.status, status, JSON.stringify(data));
  return data;
}
await api("/login", "POST", {
  username,
  password: process.env.TEST_ADMIN_PASSWORD || "local-test-password-123",
});
const name = "e2e_git_features/" + randomBytes(4).toString("hex"),
  repo = await api("/repos", "POST", { name }, 201),
  path = "/repos/" + username + "/" + encodeURIComponent(name),
  url = origin + "/" + username + "/" + encodeURIComponent(name);
const pair = await generateKeyPair("ES256", { extractable: true }),
  key = await api(
    "/api-keys",
    "POST",
    { name, public_key: await exportSPKI(pair.publicKey) },
    201,
  );
const token = (refs) =>
  new SignJWT({
    repo: username + "/" + name,
    scopes: ["git:read", "git:write"],
    refs,
  })
    .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: key.id })
    .setIssuer(username)
    .setSubject("native-git-features")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(pair.privateKey);
const ordinary = await token([]),
  verified = await token([["main", ["verify-sig"]]]),
  blocked = await token([["*", ["no-push"]]]);
const temp = await mkdtemp(join(tmpdir(), "onestorage-git-features-"));
let signing;
function git(args, cwd = temp, secret = ordinary, ok = true) {
  const p = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0:
        "Authorization: Basic " + Buffer.from("x:" + secret).toString("base64"),
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: "",
    },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (ok && p.status)
    throw Error(
      "git " +
        args[0] +
        " failed: " +
        p.stderr.replaceAll(secret, "[redacted]"),
    );
  return p;
}
try {
  git(["init", "-b", "main", "work"]);
  const work = join(temp, "work");
  git(["config", "user.name", "Signed Agent"], work);
  git(["config", "user.email", "signed@example.com"], work);
  const ssh = spawnSync(
    "ssh-keygen",
    ["-t", "ed25519", "-N", "", "-f", join(temp, "signing")],
    { encoding: "utf8" },
  );
  assert.equal(ssh.status, 0);
  signing = await api(
    "/signing-keys",
    "POST",
    { name, public_key: await readFile(join(temp, "signing.pub"), "utf8") },
    201,
  );
  git(["config", "gpg.format", "ssh"], work);
  git(["config", "user.signingkey", join(temp, "signing")], work);
  git(["config", "commit.gpgsign", "true"], work);
  git(["remote", "add", "origin", url + ".git"], work);
  await writeFile(join(work, "README"), "signed root\n");
  git(["add", "."], work);
  git(["commit", "-m", "Signed root"], work);
  git(["push", "-u", "origin", "main"], work, verified);
  const first = git(["rev-parse", "HEAD"], work).stdout.trim();
  await writeFile(join(work, "README"), "unsigned change\n");
  git(["add", "."], work);
  git(["-c", "commit.gpgsign=false", "commit", "-m", "Unsigned"], work);
  assert.notEqual(
    git(["push", "origin", "main"], work, verified, false).status,
    0,
  );
  assert.equal((await api(path + "/branch?branch=main")).sha, first);
  git(["reset", "--soft", "HEAD~1"], work);
  git(["commit", "-m", "Signed change"], work);
  git(["push", "origin", "main"], work, verified);
  git(["push", url + "+ephemeral.git", "HEAD:refs/heads/agent"], work);
  assert.ok(
    !git(["ls-remote", url + ".git"], work).stdout.includes("refs/heads/agent"),
  );
  assert.ok(
    git(["ls-remote", url + "+ephemeral.git"], work).stdout.includes(
      "refs/heads/agent",
    ),
  );
  assert.ok(
    !git(
      ["ls-remote", "--symref", url + "+ephemeral.git"],
      work,
    ).stdout.includes("HEAD"),
  );
  git(["push", url + "+import.git", "HEAD:refs/heads/imported"], work);
  assert.ok(
    git(["ls-remote", url + ".git"], work).stdout.includes(
      "refs/heads/imported",
    ),
  );
  assert.notEqual(
    git(["ls-remote", url + "+import.git"], work, ordinary, false).status,
    0,
  );
  git(
    [
      "-c",
      "core.notesRef=refs/notes/test",
      "notes",
      "add",
      "-m",
      "native note",
    ],
    work,
  );
  git(["push", "origin", "refs/notes/test"], work);
  const head = git(["rev-parse", "HEAD"], work).stdout.trim();
  assert.equal(
    (await api(path + "/notes?sha=" + head + "&notes_ref=refs/notes/test"))
      .note,
    "native note\n",
  );
  await writeFile(join(work, "README"), "revoked key\n");
  git(["add", "."], work);
  git(["commit", "-m", "Revoked signing key"], work);
  await api("/signing-keys/" + signing.id, "DELETE");
  signing = null;
  assert.notEqual(
    git(["push", "origin", "main"], work, verified, false).status,
    0,
  );
  assert.notEqual(
    git(
      ["push", url + "+ephemeral.git", "HEAD:refs/heads/blocked"],
      work,
      blocked,
      false,
    ).status,
    0,
  );
  console.log(
    "PASS: Native SSH signed push, unsigned/revoked rejection, ephemeral/import HTTP remotes and Git Notes",
  );
} finally {
  if (signing) await api("/signing-keys/" + signing.id, "DELETE");
  await api("/api-keys/" + key.id, "DELETE");
  await api(path, "DELETE");
  await rm(temp, { recursive: true, force: true });
}
