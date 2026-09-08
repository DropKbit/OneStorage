import { build } from "esbuild";
for (const name of ["markdown", "qr", "notebook"])
  await build({
    entryPoints: [`src/browser/${name}.js`],
    bundle: true,
    external: name === "notebook" ? ["./markdown.js", "./highlight.js"] : [],
    format: "esm",
    minify: true,
    outfile: `public/${name}.js`,
    legalComments: "eof",
  });
