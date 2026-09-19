import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import "../scripts/docs.mjs";
const names = [
  "README",
  "CONTRIBUTING",
  "SECURITY",
  ...(
    await fs.readdir("docs").catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    })
  )
    .filter((n) => n.endsWith(".md"))
    .map((n) => n.slice(0, -3)),
];
test("every document has two generated languages with working page, source and anchor links", async () => {
  for (const locale of ["zh-CN", "en"])
    for (const name of [...names, "index"]) {
      const html = await fs.readFile(
        `public/docs/${locale}/${name}.html`,
        "utf8",
      );
      assert.ok(html.includes(`<html lang="${locale}">`));
      assert.ok(
        html.includes(`/docs/${locale === "en" ? "zh-CN" : "en"}/${name}.html`),
      );
      for (const m of html.matchAll(/href="(\/docs\/[^"#]+)(?:#([^"]+))?"/g)) {
        const target = await fs.readFile("public" + m[1], "utf8");
        if (m[2])
          assert.ok(
            target.includes('id="' + decodeURIComponent(m[2]) + '"'),
            `${name}: missing anchor ${m[0]}`,
          );
      }
      for (const m of html.matchAll(
        /href="https:\/\/github.com\/DropKbit\/OneStorage\/blob\/main\/([^"#]+)(?:#[^"]*)?"/g,
      ))
        await fs.access(m[1]);
    }
});
