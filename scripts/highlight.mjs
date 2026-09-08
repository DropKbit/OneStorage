import { build } from "esbuild";
await build({
  entryPoints: ["src/browser/highlight.js"],
  bundle: true,
  format: "esm",
  minify: true,
  outfile: "public/highlight.js",
  legalComments: "eof",
});
