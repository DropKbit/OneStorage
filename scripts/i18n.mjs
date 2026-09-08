import { build } from "esbuild";
await build({
  entryPoints: ["src/browser/i18n.js"],
  bundle: true,
  format: "esm",
  minify: true,
  outfile: "public/i18n.js",
});
