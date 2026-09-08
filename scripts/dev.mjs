import { spawn } from "node:child_process";
const children = [];
function run(cmd, args, options = {}) {
  const child = spawn(cmd, args, { stdio: "inherit", ...options });
  children.push(child);
  return child;
}
const migration = run("npx", [
  "wrangler",
  "d1",
  "migrations",
  "apply",
  "DB",
  "--local",
  "--config",
  "wrangler.local.jsonc",
]);
migration.on("exit", (code) => {
  if (code) return process.exit(code);
  run("npx", [
    "wrangler",
    "dev",
    "--config",
    "wrangler.local.jsonc",
    "--config",
    "wrangler.build.jsonc",
  ]);
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    for (const child of children) child.kill("SIGTERM");
    process.exit();
  });
