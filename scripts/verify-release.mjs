// Read-only verification against the exact local release, including browser modules and source disclosure.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
const origin = (process.env.VERIFY_ORIGIN || "https://git.1s.hk").replace(
  /\/$/,
  "",
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const { version } = JSON.parse(await readFile("package.json", "utf8"));
const files = (await readdir("public")).filter(
  (file) =>
    file.endsWith(".js") ||
    ["index.html", "style.css", "openapi.json", "source.tar.gz"].includes(file),
);
for (const file of files) {
  const local = await readFile("public/" + file);
  const response = await fetch(
    origin +
      "/" +
      (file === "index.html" ? "" : file) +
      "?v=" +
      hash(local).slice(0, 16),
    { signal: AbortSignal.timeout(30000) },
  );
  assert.equal(response.status, 200, file);
  if (file.endsWith(".js")) {
    assert.match(response.headers.get("content-type"), /javascript/, file);
    assert.match(response.headers.get("cache-control"), /immutable/, file);
  }
  assert.equal(
    hash(Buffer.from(await response.arrayBuffer())),
    hash(local),
    file + " differs from local release",
  );
}
const health = await (
  await fetch(origin + "/api/health", { signal: AbortSignal.timeout(30000) })
).json();
assert.equal(health.version, version);
if (origin === "https://git.1s.hk") {
  const response = await fetch("https://1s.hk", {
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /cub(elink|e.?link)/i);
}
console.log(
  JSON.stringify({
    origin,
    version,
    files,
    sourceSHA256: hash(await readFile("public/source.tar.gz")),
    health,
    cubelink: origin === "https://git.1s.hk" ? "verified" : "not applicable",
  }),
);
