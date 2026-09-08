import "./content.mjs";
import "./highlight.mjs";
// Content-version the public entry points. HTML revalidates; versioned assets can stay cached.
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const hash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
async function update(path, content) {
  if ((await readFile(path, "utf8")) !== content)
    await writeFile(path, content);
}
const oidcVersion = hash(await readFile("public/oidc.js"));
await update(
  "public/account.js",
  (await readFile("public/account.js", "utf8")).replace(
    /from "\.\/oidc\.js(?:\?v=[a-f0-9]+)?"/,
    `from "./oidc.js?v=${oidcVersion}"`,
  ),
);
const cacheVersion = hash(await readFile("public/ci-cache.js"));
await update(
  "public/manage.js",
  (await readFile("public/manage.js", "utf8")).replace(
    /from "\.\/ci-cache\.js(?:\?v=[a-f0-9]+)?"/,
    `from "./ci-cache.js?v=${cacheVersion}"`,
  ),
);
const variableVersion = hash(await readFile("public/ci-variables.js"));
await update(
  "public/manage.js",
  (await readFile("public/manage.js", "utf8")).replace(
    /from "\.\/ci-variables\.js(?:\?v=[a-f0-9]+)?"/,
    `from "./ci-variables.js?v=${variableVersion}"`,
  ),
);
const forge = hash(await readFile("public/forge.js"));
let app = await readFile("public/app.js", "utf8");
for (const name of [
  "search",
  "deploy-tokens",
  "packages",
  "manage",
  "issues",
  "highlight",
  "collaboration",
  "account",
  "oidc",
  "markdown",
  "qr",
]) {
  const version = hash(await readFile(`public/${name}.js`));
  app = app.replace(
    new RegExp(`(["'\"])(\\.\\/${name}\\.js)(?:\\?v=[a-f0-9]+)?\\1`, "g"),
    (_, quote, path) => `${quote}${path}?v=${version}${quote}`,
  );
}
app = app.replace(
  /from "\.\/forge\.js(?:\?v=[a-f0-9]+)?"/,
  `from "./forge.js?v=${forge}"`,
);
await update("public/app.js", app);
const appHash = hash(app),
  styleHash = hash(await readFile("public/style.css"));
let html = await readFile("public/index.html", "utf8");
html = html
  .replace(
    /href="\/style\.css(?:\?v=[a-f0-9]+)?"/,
    `href="/style.css?v=${styleHash}"`,
  )
  .replace(/src="\/app\.js(?:\?v=[a-f0-9]+)?"/, `src="/app.js?v=${appHash}"`);
html = html.replace(
  /\s*<link rel="modulepreload" href="\/forge\.js[^\"]*"\s*\/?>(?:\n)?/,
  "\n",
);
html = html.replace(
  '    <script type="module"',
  `    <link rel="modulepreload" href="/forge.js?v=${forge}" />\n    <script type="module"`,
);
await update("public/index.html", html);
