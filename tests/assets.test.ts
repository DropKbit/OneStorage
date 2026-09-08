import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import app from "../src/app";
import type { Env } from "../src/types";
test("every published browser module is routed to its asset rather than the HTML shell, without requiring authentication", async () => {
  const env = {
    APP_ORIGIN: "https://test",
    ASSETS: {
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname;
        return new Response(await readFile("public" + path), {
          headers: {
            "content-type": path.endsWith(".js")
              ? "text/javascript"
              : "text/html",
          },
        });
      },
    },
  } as unknown as Env;
  for (const file of (await readdir("public")).filter((f) =>
    f.endsWith(".js"),
  )) {
    const response = await app.request(
      "https://test/" + file + "?v=1234567890abcdef",
      {},
      env,
    );
    assert.equal(response.status, 200, file);
    assert.match(response.headers.get("content-type")!, /javascript/, file);
    assert.equal(
      await response.text(),
      await readFile("public/" + file, "utf8"),
      file,
    );
    assert.match(response.headers.get("cache-control")!, /immutable/);
  }
  const shell = await app.request("https://test/owner/repo/issues", {}, env);
  assert.equal(await shell.text(), await readFile("public/index.html", "utf8"));
});
test("documentation routes serve real language pages and never fall back to the application shell", async () => {
  const env = {
    APP_ORIGIN: "https://test",
    ASSETS: {
      fetch: async (request: Request) =>
        new Response("document:" + new URL(request.url).pathname, {
          headers: { "content-type": "text/html" },
        }),
    },
  } as unknown as Env;
  for (const lang of ["en", "zh-CN"]) {
    const landing = await app.request(
      "https://test/docs",
      { headers: { cookie: `onestorage_locale=${lang}` } },
      env,
    );
    assert.equal(landing.headers.get("location"), `/docs/${lang}/index.html`);
    const page = await app.request(
      `https://test/docs/${lang}/README.html`,
      {},
      env,
    );
    assert.equal(await page.text(), `document:/docs/${lang}/README.html`);
    assert.equal(page.headers.get("content-language"), lang);
  }
  const invalid = await app.request(
    "https://test/docs/unknown/README.html",
    {},
    env,
  );
  assert.equal(invalid.status, 404);
  const malformed = await app.request("https://test/%ZZ", {}, env);
  assert.equal(malformed.status, 400);
});
