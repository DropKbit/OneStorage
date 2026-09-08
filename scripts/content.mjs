import { build } from "esbuild";
for (const name of ["markdown", "qr"])
  await build({
    entryPoints: [`src/browser/${name}.js`],
    bundle: true,
    format: "esm",
    minify: true,
    outfile: `public/${name}.js`,
    legalComments: "eof",
  });
