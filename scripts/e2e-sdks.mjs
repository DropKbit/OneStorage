import assert from "node:assert/strict";
import { generateKeyPair, exportPKCS8, exportSPKI } from "jose";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
const origin = process.env.TEST_ORIGIN || "http://localhost:8787";
if (!["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw Error("Local SDK integration only");
const username = process.env.TEST_ADMIN_USERNAME || "owner";
let cookie = "";
async function api(path, method, body, status = 200) {
  const r = await fetch(origin + "/api" + path, {
    method,
    headers: {
      Origin: origin,
      Cookie: cookie,
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
const keys = await generateKeyPair("ES256", { extractable: true });
const key = await api(
  "/api-keys",
  "POST",
  { name: "SDK integration", public_key: await exportSPKI(keys.publicKey) },
  201,
);
const env = {
  ...process.env,
  TEST_ORIGIN: origin,
  TEST_ISSUER: username,
  TEST_PRIVATE_KEY: await exportPKCS8(keys.privateKey),
  TEST_KEY_ID: key.id,
};
const run = (cmd, args, cwd = process.cwd()) =>
  new Promise((yes, no) => {
    const p = spawn(cmd, args, { cwd, env, stdio: "inherit" });
    p.on("error", no);
    p.on("close", (code) =>
      code ? no(Error("SDK test exited " + code)) : yes(),
    );
  });
try {
  await run("node", ["--import", "tsx", "scripts/e2e-sdk-ts.ts"]);
  await run(
    process.env.PYTHON_BINARY || resolve(".data/python-sdk/bin/python"),
    ["-m", "unittest", "discover", "-s", "sdk/python", "-p", "test_sdk.py"],
  );
  await run(
    process.env.GO_BINARY || resolve(".data/toolchains/go/bin/go"),
    ["test", "-v", "./..."],
    resolve("sdk/go"),
  );
} finally {
  await api("/api-keys/" + key.id, "DELETE");
}
