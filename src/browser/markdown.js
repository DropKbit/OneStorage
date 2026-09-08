import MarkdownIt from "markdown-it";
const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
  maxNesting: 40,
});
const defaultValidate = md.validateLink.bind(md);
md.validateLink = (url) => {
  const clean = url.replace(/[\x00-\x20\x7f]/g, "");
  return (
    defaultValidate(url) &&
    (!/^[a-z][a-z0-9+.-]*:/i.test(clean) || /^(https?:|mailto:)/i.test(clean))
  );
};
const escape = md.utils.escapeHtml;
function relativePath(href, env) {
  if (
    !env.base ||
    !href ||
    href.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/i.test(href) ||
    /[\x00-\x1f\\]/.test(href)
  )
    return null;
  try {
    const root = new URL(
      "https://repository.invalid/" +
        (env.path || "README.md").split("/").map(encodeURIComponent).join("/"),
    );
    const target = new URL(href, root);
    if (target.origin !== root.origin) return null;
    return {
      path: decodeURIComponent(target.pathname.slice(1)),
      hash: target.hash,
    };
  } catch {
    return null;
  }
}
md.renderer.rules.link_open = (tokens, i, options, env, self) => {
  const token = tokens[i],
    href = token.attrGet("href") || "";
  if (href.startsWith("#")) token.attrSet("href", "#md-" + href.slice(1));
  else {
    const local = relativePath(href, env);
    if (local) {
      token.attrSet(
        "href",
        env.base +
          "?" +
          new URLSearchParams({
            path: local.path,
            ref: env.ref || "HEAD",
            view: "blob",
          }) +
          (local.hash ? "#md-" + local.hash.slice(1) : ""),
      );
      token.attrSet("data-link", "");
    } else {
      token.attrSet("rel", "noopener noreferrer");
      token.attrSet("target", "_blank");
    }
  }
  return self.renderToken(tokens, i, options);
};
md.renderer.rules.image = (tokens, i, options, env, self) => {
  const token = tokens[i],
    src = token.attrGet("src") || "",
    alt = self.renderInlineAsText(token.children || [], options, env),
    local = relativePath(src, env);
  if (local && /\.(png|jpe?g|gif|webp)$/i.test(local.path))
    return `<img loading="lazy" alt="${escape(alt)}" src="${escape("/api/repos" + env.base + "/preview?" + new URLSearchParams({ path: local.path, ref: env.ref || "HEAD" }))}">`;
  return `<span class="markdown-image-link">${escape(alt || "图片")}（<a target="_blank" rel="noopener noreferrer" href="${escape(md.validateLink(src) ? src : "#")}">查看图片</a>）</span>`;
};
md.renderer.rules.heading_open = (tokens, i, options, env, self) => {
  const content = tokens[i + 1]?.content || "",
    id = content
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^\p{L}\p{N}_-]/gu, "");
  tokens[i].attrSet("id", "md-" + id);
  return self.renderToken(tokens, i, options);
};
const textRule = md.renderer.rules.text;
md.renderer.rules.text = (tokens, i, options, env, self) => {
  const token = tokens[i];
  if (token.meta?.task !== undefined)
    return (
      `<input type="checkbox" disabled${token.meta.task ? " checked" : ""} aria-label="${token.meta.task ? "已完成" : "未完成"}"> ` +
      escape(token.content)
    );
  return textRule
    ? textRule(tokens, i, options, env, self)
    : escape(token.content);
};
md.core.ruler.after("inline", "tasks", (state) => {
  for (let i = 2; i < state.tokens.length; i++) {
    const t = state.tokens[i],
      child = t.children?.[0];
    if (
      t.type === "inline" &&
      state.tokens[i - 2].type === "list_item_open" &&
      child?.type === "text" &&
      /^\[[ xX]\] /.test(child.content)
    ) {
      child.meta = { task: child.content[1].toLowerCase() === "x" };
      child.content = child.content.slice(4);
    }
  }
});
export function renderMarkdown(source, env = {}) {
  if (typeof source !== "string") return "";
  if (source.length > 200000) return "<pre>" + escape(source) + "</pre>";
  return md.render(source, env);
}
