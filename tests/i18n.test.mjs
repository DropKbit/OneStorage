import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { parse } from "acorn";
import { translateLiteral, translateTemplate } from "../src/i18n/core.js";
const messages = JSON.parse(
  await fs.readFile(new URL("../src/i18n/en.json", import.meta.url), "utf8"),
);
test("UI translations preserve interpolation values, including code and template-like user content", () => {
  assert.equal(translateLiteral("当前密码", "en"), "Current password");
  assert.equal(translateLiteral("当前密码", "zh-CN"), "当前密码");
  assert.equal(
    translateLiteral('<label title="当前密码">用户名</label>', "en"),
    '<label title="Current password">Username</label>',
  );
  const untrusted = "项目 <img src=x> ⟦0⟧ ${secret}";
  assert.equal(
    translateTemplate(["使用 ", " 登录"], [untrusted], "en"),
    "使用 " + untrusted + " 登录",
  );
  // This catalog entry has a nonzero placeholder because it originally lives inside a larger HTML template.
  assert.equal(
    translateTemplate(
      ['<a href="', '">使用 ', " 登录</a>"],
      ["/", untrusted],
      "en",
    ),
    '<a href="/">Sign in with ' + untrusted + "</a>",
  );
});
test("every catalog translation preserves its placeholders", () => {
  for (const [key, value] of Object.entries(messages)) {
    assert.deepEqual(
      (key.match(/⟦\d+⟧/g) || []).sort(),
      (value.match(/⟦\d+⟧/g) || []).sort(),
      key,
    );
    assert.equal(/\p{Script=Han}/u.test(value), false, key);
  }
});
test("all application-owned Chinese UI literals are explicitly localized and covered", async () => {
  const names = [
    "account",
    "app",
    "ci-cache",
    "ci-variables",
    "collaboration",
    "deploy-tokens",
    "forge",
    "issues",
    "manage",
    "oidc",
    "packages",
    "search",
  ];
  const files = [
    ...names.map((n) => `public/${n}.js`),
    "src/browser/notebook.js",
  ];
  const han = /\p{Script=Han}/u;
  for (const file of files) {
    const source = await fs.readFile(
      new URL("../" + file, import.meta.url),
      "utf8",
    );
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    function walk(node, parent) {
      let literal;
      if (node.type === "Literal" && typeof node.value === "string")
        literal = node.value;
      if (node.type === "TemplateLiteral")
        literal = node.quasis
          .map(
            (q, i) =>
              q.value.cooked + (i < node.expressions.length ? `⟦${i}⟧` : ""),
          )
          .join("");
      if (literal && han.test(literal)) {
        assert.ok(
          node.type === "Literal"
            ? parent?.type === "CallExpression" &&
                parent.callee.name === "i18nText"
            : parent?.type === "TaggedTemplateExpression" &&
                parent.tag.name === "i18nHTML",
          `${file}: untranslated literal ${literal.slice(0, 80)}`,
        );
        for (const m of literal.matchAll(/[^<>"'`\n]+/g))
          if (han.test(m[0]))
            assert.ok(
              Object.hasOwn(messages, m[0].trim()),
              `${file}: missing ${m[0].trim()}`,
            );
      }
      for (const value of Object.values(node))
        if (Array.isArray(value))
          value.forEach((v) => {
            if (v?.type) walk(v, node);
          });
        else if (value?.type) walk(value, node);
    }
    walk(ast);
  }
});
test("known API errors translate without altering unknown server or user text", async () => {
  const { translateError } = await import("../src/i18n/core.js");
  assert.equal(
    translateError("Invalid username or password", "zh-CN"),
    "用户名或密码错误",
  );
  assert.equal(
    translateError("Invalid username or password", "en"),
    "Invalid username or password",
  );
  assert.equal(
    translateError("user text: Invalid username or password", "zh-CN"),
    "user text: Invalid username or password",
  );
});
