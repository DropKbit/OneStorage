import test from "node:test";
import assert from "node:assert/strict";
import {
  requestLocale,
  supportedLocale,
  negotiateLocale,
} from "../src/i18n/locale";
import { canonicalPageURL } from "../src/domain";
test("language negotiation honors explicit choice, cookie and weighted browser preferences", () => {
  assert.equal(negotiateLocale("en-US;q=0.8,zh-CN;q=0.9"), "zh-CN");
  assert.equal(negotiateLocale("fr, en-GB;q=0.7"), "en");
  assert.equal(negotiateLocale("en;q=0,zh-CN;q=1"), "zh-CN");
  assert.equal(negotiateLocale("de;q=1,en;q=invalid"), "zh-CN");
  assert.equal(supportedLocale("<script>"), null);
  assert.equal(
    requestLocale(
      new Request("https://1s.hk/?lang=en", {
        headers: {
          cookie: "onestorage_locale=zh-CN",
          "accept-language": "zh-CN",
        },
      }),
    ),
    "en",
  );
  assert.equal(
    requestLocale(
      new Request("https://1s.hk/", {
        headers: {
          cookie: "onestorage_locale=zh-CN",
          "accept-language": "en-US",
        },
      }),
    ),
    "zh-CN",
  );
});
test("domain migration redirects browser pages without redirecting native Git and API requests", () => {
  const url = (path: string, method = "GET") =>
    canonicalPageURL(
      new Request("https://git.1s.hk" + path, { method }),
      "https://1s.hk",
      "https://git.1s.hk",
    );
  assert.equal(
    url("/1shk/nb?path=README.md&lang=en"),
    "https://1s.hk/1shk/nb?path=README.md&lang=en",
  );
  assert.equal(
    url("/docs/en/index.html", "HEAD"),
    "https://1s.hk/docs/en/index.html",
  );
  assert.equal(url("/1shk/nb.git/info/refs?service=git-upload-pack"), null);
  assert.equal(url("/1shk/nb.git/git-receive-pack", "POST"), null);
  assert.equal(url("/api/repos"), null);
  assert.equal(url("/mcp"), null);
  assert.equal(
    canonicalPageURL(
      new Request("https://unrelated.test/"),
      "https://1s.hk",
      "https://git.1s.hk",
    ),
    null,
  );
});
test("malformed URLs do not crash canonicalization and encoded APIs stay compatible", () => {
  for (const path of ["/%ZZ", "/%61pi/repos"])
    assert.equal(
      canonicalPageURL(
        new Request("https://git.1s.hk" + path),
        "https://1s.hk",
        "https://git.1s.hk",
      ),
      null,
    );
});
