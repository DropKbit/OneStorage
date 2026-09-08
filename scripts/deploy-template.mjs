// Cloudflare Deploy button provisions root bindings before this command runs.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { parse } from "jsonc-parser";
const require = createRequire(import.meta.url),
  wrangler = path.join(
    path.dirname(require.resolve("wrangler/package.json")),
    "bin/wrangler.js",
  );
export function deploymentConfigs(main, compiler, apps) {
  const name = main.name;
  if (!/^[a-z][a-z0-9-]{0,48}[a-z0-9]$/.test(name))
    throw Error(
      "Worker name must be 2–50 lowercase letters, digits or hyphens",
    );
  if (
    main.routes?.length ||
    main.account_id ||
    ["https://git.1s.hk", "https://1s.hk"].includes(main.vars?.APP_ORIGIN)
  )
    throw Error(
      "Use the portable deploy branch, not a production configuration",
    );
  const db = main.d1_databases?.find((x) => x.binding === "DB"),
    objects = main.r2_buckets?.find((x) => x.binding === "OBJECTS"),
    cache = main.r2_buckets?.find((x) => x.binding === "NPM_CACHE");
  if (!db || !db.database_id || /^0+-0+-0+-0+-0+$/.test(db.database_id))
    throw Error("Cloudflare must provision the DB binding before deployment");
  if (
    !objects?.bucket_name ||
    !cache?.bucket_name ||
    objects.bucket_name === cache.bucket_name
  )
    throw Error("Two distinct R2 buckets are required");
  if (!main.queues?.producers?.length || !main.queues?.consumers?.length)
    throw Error("Queue producer and consumer are required");
  if (main.queues.producers[0].queue !== main.queues.consumers[0].queue)
    throw Error("Queue producer/consumer must use the same provisioned queue");
  const primary = structuredClone(main);
  primary.services = [{ binding: "BUILDER", service: name + "-build" }];
  primary.workers_dev = true;
  const build = {
    ...compiler,
    name: name + "-build",
    r2_buckets: [{ ...cache, binding: "NPM_CACHE" }],
    workers_dev: false,
    preview_urls: false,
  };
  const gateway = {
    ...apps,
    name: name + "-apps",
    d1_databases: [db],
    r2_buckets: [objects],
    workers_dev: true,
  };
  delete build.routes;
  delete build.account_id;
  delete gateway.routes;
  delete gateway.account_id;
  return { primary, build, gateway };
}
export function childEnvironment(env, primary = false) {
  const out = { ...env };
  if (!primary)
    for (const key of Object.keys(out))
      if (key.startsWith("WRANGLER_CI_")) delete out[key];
  return out;
}
function run(args, primary = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrangler, ...args], {
      env: childEnvironment(process.env, primary),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (d) => {
        output += d;
        process.stdout.write(d);
      });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(output)
        : reject(Error("Wrangler command failed: " + args[0])),
    );
  });
}
export function gatewayOrigin(output, name) {
  const urls = output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/g) || [];
  const url = urls.find((u) => new URL(u).hostname.startsWith(name + "-apps."));
  if (!url) throw Error("No deployed apps workers.dev URL found");
  return url;
}
export async function deploy() {
  const load = async (f) => parse(await fs.readFile(f, "utf8"));
  const source = await load("wrangler.jsonc");
  source.name = process.env.WRANGLER_CI_OVERRIDE_NAME || source.name;
  const { primary, build, gateway } = deploymentConfigs(
    source,
    await load("wrangler.build.jsonc"),
    await load("wrangler.apps.jsonc"),
  );
  // Config files stay beside root paths so source/assets/migrations remain correctly resolved.
  const files = [
    ".onestorage-build.generated.json",
    ".onestorage-apps.generated.json",
    ".onestorage-main.generated.json",
  ];
  try {
    for (const [i, cfg] of [build, gateway, primary].entries())
      await fs.writeFile(files[i], JSON.stringify(cfg, null, 2) + "\n");
    await run(
      ["d1", "migrations", "apply", "DB", "--remote", "--config", files[2]],
      true,
    );
    await run(["deploy", "--config", files[0]]);
    const out = await run(["deploy", "--config", files[1]]),
      appsURL = gatewayOrigin(out, primary.name);
    primary.vars = {
      ...primary.vars,
      APPS_ORIGIN: appsURL,
      APP_ORIGIN:
        primary.vars?.APP_ORIGIN ||
        appsURL.replace(
          "://" + primary.name + "-apps.",
          "://" + primary.name + ".",
        ),
    };
    await fs.writeFile(files[2], JSON.stringify(primary, null, 2) + "\n");
    await run(["deploy", "--config", files[2]], true);
    console.log(
      "OneStorage ready: " +
        primary.vars.APP_ORIGIN +
        " — initialize the administrator with your BOOTSTRAP_SECRET.",
    );
  } finally {
    for (const f of files) await fs.rm(f, { force: true });
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await deploy();
