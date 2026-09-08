import fs from "node:fs/promises";
import path from "node:path";
import MarkdownIt from "markdown-it";
const escape = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const files = (await fs.readdir("docs"))
  .filter((f) => f.endsWith(".md"))
  .sort();
const rootPages = ["README", "CONTRIBUTING", "SECURITY"];
const pages = [
  ...rootPages.map((name) => ({ name, zh: name + ".md", en: name + ".en.md" })),
  ...files.map((f) => ({
    name: f.slice(0, -3),
    zh: "docs/" + f,
    en: "docs/en/" + f,
  })),
];
const sources = new Map();
for (const page of pages)
  for (const lang of ["zh-CN", "en"]) {
    const source = lang === "en" ? page.en : page.zh;
    const text = await fs.readFile(source, "utf8");
    sources.set(source, {
      page,
      lang,
      text,
      title: text.match(/^#\s+(.+)$/m)?.[1] || page.name,
    });
  }
const slug = (text) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_ -]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
for (const lang of ["zh-CN", "en"]) {
  await fs.mkdir(`public/docs/${lang}`, { recursive: true });
  const english = lang === "en",
    other = english ? "zh-CN" : "en";
  const items = pages.map((p) => sources.get(english ? p.en : p.zh));
  const nav = items
    .map(
      ({ page, title }) =>
        `<a href="/docs/${lang}/${page.name}.html">${escape(title)}</a>`,
    )
    .join("");
  for (const { page, text, title } of items) {
    const source = english ? page.en : page.zh;
    const md = new MarkdownIt({
      html: false,
      linkify: true,
      typographer: false,
    });
    const normalImage = md.renderer.rules.image;
    md.renderer.rules.image = (tokens, idx, options, env, self) => {
      if (
        tokens[idx].attrGet("src") ===
        "https://deploy.workers.cloudflare.com/button"
      )
        return `<strong>${english ? "Deploy to Cloudflare →" : "部署到 Cloudflare →"}</strong>`;
      return normalImage(tokens, idx, options, env, self);
    };
    const normalLink =
      md.renderer.rules.link_open ||
      ((tokens, idx, options, env, self) =>
        self.renderToken(tokens, idx, options));
    md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
      const token = tokens[idx],
        href = token.attrGet("href");
      if (href && !/^(?:[a-z]+:|\/|#)/i.test(href)) {
        const [file, hash] = href.split("#"),
          resolved = path.posix.normalize(
            path.posix.join(
              path.posix.dirname(source),
              decodeURIComponent(file),
            ),
          );
        const target = sources.get(resolved);
        if (target)
          token.attrSet(
            "href",
            `/docs/${target.lang}/${target.page.name}.html${hash ? "#" + hash : ""}`,
          );
        else
          token.attrSet(
            "href",
            `https://github.com/DropKbit/OneStorage/blob/main/${resolved}${hash ? "#" + hash : ""}`,
          );
      }
      return normalLink(tokens, idx, options, env, self);
    };
    const used = new Map();
    md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
      const base = slug(tokens[idx + 1].content),
        count = used.get(base) || 0;
      used.set(base, count + 1);
      tokens[idx].attrSet("id", base + (count ? "-" + count : ""));
      return self.renderToken(tokens, idx, options);
    };
    const content = md.render(text);
    const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · OneStorage Docs</title><link rel="stylesheet" href="/docs/site.css"><link rel="icon" href="/favicon.svg"><link rel="alternate" hreflang="${other}" href="/docs/${other}/${page.name}.html"><script defer src="/docs-client.js"></script></head><body><a class="skip" href="#content">${english ? "Skip to content" : "跳到正文"}</a><header><a class="brand" href="/?lang=${lang}">OneStorage</a><a href="/docs/${lang}/index.html">${english ? "Documentation" : "文档"}</a><nav aria-label="Language / 语言"><a lang="zh-CN" href="/docs/zh-CN/${page.name}.html" ${!english ? 'aria-current="page"' : ""}>简体中文</a><a lang="en" href="/docs/en/${page.name}.html" ${english ? 'aria-current="page"' : ""}>English</a></nav></header><div class="layout"><aside><details open><summary>${english ? "All documents" : "全部文档"}</summary><nav>${nav}</nav></details></aside><main id="content"><div class="source"><a href="https://github.com/DropKbit/OneStorage/blob/main/${source}">${english ? "View Markdown source" : "查看 Markdown 源文档"}</a></div>${content}</main></div><footer>OneStorage · AGPL-3.0-only</footer></body></html>`;
    await fs.writeFile(`public/docs/${lang}/${page.name}.html`, html);
  }
  const index = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OneStorage · ${english ? "Documentation" : "文档"}</title><link rel="stylesheet" href="/docs/site.css"><script defer src="/docs-client.js"></script></head><body><header><a class="brand" href="/?lang=${lang}">OneStorage</a><nav aria-label="Language / 语言"><a href="/docs/zh-CN/index.html" lang="zh-CN">简体中文</a><a href="/docs/en/index.html" lang="en">English</a></nav></header><main class="index"><h1>${english ? "Documentation" : "项目文档"}</h1><p>${english ? "Learn to deploy, use, and maintain your own Cloudflare Git platform. Feature guides include their supported scope; verification reports describe historical releases." : "了解如何部署、使用和维护自己的 Cloudflare Git 平台。功能指南包含支持边界；验收报告记录对应历史版本。"}</p><section class="doc-grid">${nav}</section></main><footer>OneStorage · AGPL-3.0-only</footer></body></html>`;
  await fs.writeFile(`public/docs/${lang}/index.html`, index);
}
await fs.writeFile(
  "public/docs/site.css",
  `*{box-sizing:border-box}body{margin:0;background:#f8fafc;color:#18212f;font:16px/1.7 system-ui,sans-serif}a{color:#225ac7;text-decoration:none}a:hover{text-decoration:underline}header{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:24px;padding:18px 28px;background:#fff;border-bottom:1px solid #e2e8f0}header nav{margin-left:auto;display:flex;gap:18px}.brand{font-weight:800;color:#18212f;font-size:20px}[aria-current]{font-weight:700;text-decoration:underline}.layout{display:grid;grid-template-columns:280px minmax(0,900px);max-width:1240px;margin:auto}aside{padding:25px 20px;height:calc(100vh - 76px);overflow:auto;position:sticky;top:76px}aside nav{display:flex;flex-direction:column;gap:9px;font-size:13px}summary{cursor:pointer;font-weight:700;margin-bottom:15px}main{padding:35px 40px;min-width:0;background:#fff}h1{font-size:30px;line-height:1.3}h2{margin-top:36px}h1,h2,h3{scroll-margin-top:100px}pre{overflow:auto;padding:18px;background:#f1f5f9;border-radius:8px;font-size:13px}code{font-family:ui-monospace,monospace;font-size:.88em;overflow-wrap:anywhere}pre code{overflow-wrap:normal}table{border-collapse:collapse;display:block;overflow:auto;font-size:14px}td,th{border:1px solid #d8e0eb;padding:9px 12px}th{background:#f1f5f9}img{max-width:100%}blockquote{margin-left:0;padding-left:18px;border-left:3px solid #94a3b8;color:#475569}.source{text-align:right;font-size:13px}.index{max-width:1100px;margin:auto}.doc-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px}.doc-grid a{padding:16px;border:1px solid #e2e8f0;border-radius:8px}footer{padding:25px;text-align:center;font-size:13px;color:#64748b}.skip{position:absolute;left:-9999px}.skip:focus{left:20px;top:80px;background:white;padding:10px;z-index:3}@media(max-width:760px){header{padding:12px;gap:12px;flex-wrap:wrap}.layout{display:block}aside{position:static;height:auto;max-height:220px;border-bottom:1px solid #ddd}main{padding:24px 18px}.source{text-align:left}.doc-grid{grid-template-columns:1fr}}`,
);
console.log(`Documentation: ${pages.length} pages × 2 languages`);
