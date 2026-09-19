import "./docs.mjs";
import { isPrivatePath, assertPublicFile } from "./source-policy.mjs";
import "./openapi.mjs";
import "./assets.mjs";
// Build-time only: publish an explicit allowlist of source files, never local state/secrets.
import { readFile, readdir, lstat, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
const files = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "wrangler.jsonc",
  "wrangler.local.jsonc",
  "wrangler.apps.jsonc",
  "wrangler.build.jsonc",
  "README.md",
  "README.en.md",
  "CONTRIBUTING.en.md",
  "SECURITY.en.md",
  "LICENSE",
  "SECURITY.md",
  "CONTRIBUTING.md",
  ".gitignore",
  ".gitleaks.toml",
  ".gitleaksignore",
];
try {
  if ((await lstat(".env.example")).isFile()) files.push(".env.example");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
async function collect(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (
      e.name === "__pycache__" ||
      e.name.endsWith(".egg-info") ||
      e.name.endsWith(".pyc")
    )
      continue;
    const path = join(dir, e.name);
    if (isPrivatePath(path)) continue;
    if (e.isSymbolicLink())
      throw Error("Source archive must not contain symlinks: " + path);
    if (e.isDirectory()) await collect(path);
    else if (e.isFile() && path !== "public/source.tar.gz") files.push(path);
  }
}
for (const dir of [
  "src",
  "sdk",
  "examples",
  "public",
  "scripts",
  "tests",
  "migrations",
  ".github",
])
  await collect(dir);
const chunks = [];
for (const file of files.sort()) {
  const path = "onestorage/" + file;
  if (Buffer.byteLength(path) > 100)
    throw Error("Source archive path too long: " + path);
  const data = await readFile(file),
    header = Buffer.alloc(512);
  assertPublicFile(file, data);
  header.write(path, 0, 100, "utf8");
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
  header.write("00000000000\0", 136);
  header.fill(32, 148, 156);
  header[156] = 48;
  header.write("ustar\0", 257);
  header.write("00", 263);
  header.write("onestorage", 265);
  header.write("onestorage", 297);
  const sum = header.reduce((n, b) => n + b, 0);
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  chunks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
}
chunks.push(Buffer.alloc(1024));
const archive = gzipSync(Buffer.concat(chunks), { level: 9 });
await writeFile("public/source.tar.gz", archive);
console.log(
  `Source archive: ${files.length} allowlisted files, ${archive.length} bytes`,
);
