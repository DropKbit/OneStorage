// Run only in a disposable checkout. The canonical production config stays on main.
import fs from "node:fs/promises";
import { parse } from "jsonc-parser";
import path from "node:path";
const target = process.argv[2];
if (!target || path.resolve(target) === process.cwd())
  throw Error("Specify a separate template checkout directory");
const read = async (f) =>
  parse(await fs.readFile(path.join(target, f), "utf8"));
const write = async (f, data) =>
  fs.writeFile(path.join(target, f), JSON.stringify(data, null, 2) + "\n");
const main = await read("wrangler.jsonc");
main.name = "onestorage";
delete main.routes;
delete main.account_id;
delete main.services;
// The Deploy form treats every declared var as required, even an empty default.
// Origins are derived after deploying the gateway; optional webhook hosts stay unset.
delete main.vars;
main.d1_databases = [
  {
    binding: "DB",
    database_name: "onestorage",
    database_id: "00000000-0000-0000-0000-000000000000",
    migrations_dir: "migrations",
  },
];
main.r2_buckets = [
  { binding: "OBJECTS", bucket_name: "onestorage-objects" },
  { binding: "NPM_CACHE", bucket_name: "onestorage-npm-cache" },
];
main.secrets = { required: ["CREDENTIAL_ENCRYPTION_KEY"] };
await write("wrangler.jsonc", main);
const compiler = await read("wrangler.build.jsonc");
compiler.name = "onestorage-build";
delete compiler.account_id;
delete compiler.routes;
await write("wrangler.build.jsonc", compiler);
const apps = await read("wrangler.apps.jsonc");
apps.name = "onestorage-apps";
delete apps.account_id;
delete apps.routes;
apps.d1_databases = main.d1_databases;
apps.r2_buckets = [main.r2_buckets[0]];
await write("wrangler.apps.jsonc", apps);
const pkg = await read("package.json");
pkg.scripts.build = "node scripts/source.mjs";
pkg.scripts.deploy = "node scripts/deploy-template.mjs";
delete pkg.scripts.prebuild;
delete pkg.scripts.predeploy;
pkg.cloudflare = {
  bindings: {
    BOOTSTRAP_SECRET: {
      description:
        "首次创建管理员的初始化密钥。请使用 openssl rand -hex 32 生成并保存，不使用本地开发值。",
    },
    CREDENTIAL_ENCRYPTION_KEY: {
      description:
        "凭据加密密钥。请使用 openssl rand -base64 32 生成（32 随机字节），升级时必须保留。",
    },
    NPM_CACHE: {
      description: "独立的公共 npm 下载缓存 R2 桶；不能与 Git 对象桶共用。",
    },
  },
};
await write("package.json", pkg);
await fs.writeFile(
  path.join(target, ".env.example"),
  "# Installer prompts only. Generate your own values. Never use local test secrets.\nBOOTSTRAP_SECRET=\nCREDENTIAL_ENCRYPTION_KEY=\n",
);
// Root lock package metadata is unchanged except scripts, which package-lock does not store.
console.log(
  "Prepared portable deploy template; no production IDs, domains or credentials included.",
);
