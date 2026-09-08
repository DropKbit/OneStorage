import { text as i18nText, html as i18nHTML, getLocale } from "./i18n.js";
import DOMPurify from "dompurify";
import { renderMarkdown } from "./markdown.js";
import { highlightCode } from "./highlight.js";
import {
  parseNotebook,
  notebookText,
  notebookImage,
  NOTEBOOK_LIMITS,
} from "./notebook-model.ts";
const element = (tag, cls, text) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
};
const languagePaths = {
  python: "cell.py",
  javascript: "cell.js",
  typescript: "cell.ts",
  bash: "cell.sh",
  shell: "cell.sh",
  go: "cell.go",
  rust: "cell.rs",
  java: "cell.java",
  sql: "cell.sql",
  julia: "cell.julia",
  r: "cell.r",
};
const textOutput = (parent, text, cls = "") => {
  const raw = notebookText(text);
  if (raw === null) return false;
  parent.append(
    element(
      "pre",
      "notebook-output-text " + cls,
      raw
        .slice(0, NOTEBOOK_LIMITS.text)
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""),
    ),
  );
  if (raw.length > NOTEBOOK_LIMITS.text)
    parent.append(
      element("p", "muted", i18nText("输出已截断，请查看 JSON 源码。")),
    );
  return true;
};
function richOutput(parent, bundle, env) {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle))
    return false;
  const image = notebookImage(bundle);
  if (image) {
    const img = element("img", "notebook-image");
    img.alt = i18nText("笔记本输出图片");
    img.loading = "lazy";
    img.src = image;
    img.onerror = () => {
      img.replaceWith(
        element("p", "muted", i18nText("图片内容损坏，无法显示。")),
      );
    };
    parent.append(img);
    return true;
  }
  const html = notebookText(bundle["text/html"]);
  if (html !== null && html.length <= NOTEBOOK_LIMITS.text) {
    const safe = DOMPurify.sanitize(html, {
      ALLOWED_TAGS: [
        "p",
        "div",
        "span",
        "pre",
        "code",
        "b",
        "strong",
        "i",
        "em",
        "u",
        "s",
        "br",
        "hr",
        "table",
        "thead",
        "tbody",
        "tfoot",
        "tr",
        "td",
        "th",
        "caption",
        "ul",
        "ol",
        "li",
        "blockquote",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "dl",
        "dt",
        "dd",
        "sup",
        "sub",
      ],
      ALLOWED_ATTR: ["colspan", "rowspan", "scope"],
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
      RETURN_DOM_FRAGMENT: true,
    });
    if (
      safe.querySelectorAll("*").length <= 1500 &&
      (safe.textContent.trim() || safe.querySelector("table"))
    ) {
      const box = element("div", "markdown notebook-html");
      box.append(safe);
      parent.append(box);
      parent.append(
        element(
          "p",
          "muted notebook-output-note",
          i18nText("静态 HTML 输出 · 样式、链接、图片与交互内容已过滤"),
        ),
      );
      return true;
    }
  }
  const markdown = notebookText(bundle["text/markdown"]);
  if (markdown !== null) {
    const box = element("div", "markdown");
    box.innerHTML = renderMarkdown(
      markdown.slice(0, NOTEBOOK_LIMITS.text),
      env,
    );
    parent.append(box);
    if (markdown.length > NOTEBOOK_LIMITS.text)
      parent.append(element("p", "muted", i18nText("输出已截断。")));
    return true;
  }
  if (bundle["application/json"] !== undefined)
    return textOutput(
      parent,
      JSON.stringify(bundle["application/json"], null, 2),
    );
  return textOutput(parent, bundle["text/plain"]);
}
export function mountNotebook(target, source, context = {}) {
  target.replaceChildren();
  const toolbar = element("div", "notebook-toolbar"),
    previewButton = element("button", "btn small", i18nText("预览")),
    sourceButton = element("button", "btn small", i18nText("JSON 源码"));
  previewButton.type = sourceButton.type = "button";
  toolbar.append(previewButton, sourceButton);
  const preview = element("div", "notebook-preview"),
    raw = element("div", "notebook-raw");
  raw.hidden = true;
  target.append(toolbar, preview, raw);
  let model,
    rawReady = false,
    position = 0;
  const showRaw = () => {
    preview.hidden = true;
    raw.hidden = false;
    previewButton.setAttribute("aria-pressed", "false");
    sourceButton.setAttribute("aria-pressed", "true");
    if (!rawReady) {
      rawReady = true;
      const lines = source.slice(0, NOTEBOOK_LIMITS.bytes).split("\n", 10001);
      const shown = lines.slice(0, 10000).join("\n"),
        view = element("div", "code-viewer"),
        numbers = element("pre", "line-numbers"),
        pre = element("pre"),
        code = element("code", null, shown);
      code.dataset.path = "notebook.json";
      for (let i = 0; i < Math.min(lines.length, 10000); i++) {
        const n = element("span", null, String(i + 1));
        n.id = "L" + (i + 1);
        numbers.append(n, document.createTextNode("\n"));
      }
      const highlighted = highlightCode(shown, "notebook.json");
      if (highlighted !== null) code.innerHTML = highlighted;
      pre.append(code);
      view.append(numbers, pre);
      raw.append(view);
      if (lines.length > 10000 || source.length > NOTEBOOK_LIMITS.bytes)
        raw.prepend(
          element(
            "p",
            "info",
            i18nText(
              "源码视图最多显示前 10,000 行 / 2 MiB 字符，请通过 Git 查看完整文件。",
            ),
          ),
        );
    }
    if (/^#L[1-9][0-9]*$/.test(location.hash))
      raw.querySelector(location.hash)?.scrollIntoView({ block: "center" });
  };
  sourceButton.onclick = showRaw;
  previewButton.onclick = () => {
    raw.hidden = true;
    preview.hidden = false;
    previewButton.setAttribute("aria-pressed", "true");
    sourceButton.setAttribute("aria-pressed", "false");
  };
  previewButton.setAttribute("aria-pressed", "true");
  sourceButton.setAttribute("aria-pressed", "false");
  try {
    model = parseNotebook(source, getLocale());
  } catch (e) {
    preview.append(element("p", "info", e.message));
    if (/^#L/.test(location.hash)) showRaw();
    return;
  }
  preview.append(
    element(
      "p",
      "notebook-summary",
      i18nHTML`${model.total} 个单元 · ${model.language || i18nText("未指定语言")} · 只读预览，不执行代码`,
    ),
  );
  if (model.omitted)
    preview.append(
      element(
        "p",
        "info",
        i18nHTML`预览最多 1,000 个单元，已省略 ${model.omitted} 个。`,
      ),
    );
  const cells = element("div", "notebook-cells"),
    more = element("button", "btn notebook-more", i18nText("加载更多单元"));
  more.type = "button";
  preview.append(cells, more);
  const append = () => {
    for (const cell of model.cells.slice(position, position + 25)) {
      const section = element("section", "notebook-cell"),
        header = element("div", "notebook-cell-heading");
      section.id = "nb-cell-" + cell.index;
      const link = element(
        "a",
        "notebook-cell-link",
        i18nHTML`单元 ${cell.index}`,
      );
      link.href = "#" + section.id;
      header.append(
        link,
        element(
          "span",
          "muted",
          cell.type === "code" ? `In [${cell.execution ?? " "}]` : cell.type,
        ),
      );
      section.append(header);
      const env = {
        ...context,
        idPrefix: `nb-c${cell.index}-`,
        resolveAttachment: (name) => {
          try {
            name = decodeURIComponent(name);
          } catch {
            return null;
          }
          return Object.hasOwn(cell.attachments, name)
            ? notebookImage(cell.attachments[name])
            : null;
        },
      };
      if (cell.type === "markdown") {
        const box = element("div", "markdown notebook-markdown");
        box.innerHTML = renderMarkdown(cell.source, env);
        section.append(box);
      } else if (cell.type === "code") {
        const pre = element("pre", "notebook-code"),
          code = element("code", null, cell.source),
          html = highlightCode(
            cell.source,
            languagePaths[model.language.toLowerCase()] || "cell.txt",
          );
        if (html !== null) code.innerHTML = html;
        pre.append(code);
        section.append(pre);
        for (const output of cell.outputs) {
          const box = element("div", "notebook-output");
          let rendered = false;
          if (output.output_type === "stream")
            rendered = textOutput(
              box,
              output.text,
              output.name === "stderr" ? "notebook-error" : "",
            );
          else if (output.output_type === "error")
            rendered = textOutput(
              box,
              (Array.isArray(output.traceback) &&
              output.traceback.every((v) => typeof v === "string")
                ? output.traceback.join("\n")
                : notebookText(output.traceback)) ||
                `${typeof output.ename === "string" ? output.ename : "Error"}: ${typeof output.evalue === "string" ? output.evalue : ""}`,
              "notebook-error",
            );
          else if (
            ["display_data", "execute_result"].includes(output.output_type)
          )
            rendered = richOutput(box, output.data, env);
          if (!rendered)
            box.append(
              element(
                "p",
                "muted",
                i18nText("此输出格式无法预览，请查看 JSON 源码。"),
              ),
            );
          section.append(box);
        }
      } else {
        textOutput(section, cell.source);
        if (cell.type !== "raw")
          section.append(
            element("p", "muted", i18nText("未支持的单元类型，已显示原文。")),
          );
      }
      for (const warning of cell.warnings)
        section.append(element("p", "info", warning));
      cells.append(section);
    }
    position = Math.min(position + 25, model.cells.length);
    more.hidden = position >= model.cells.length;
  };
  more.onclick = append;
  append();
  const match = location.hash.match(/^#nb-cell-([1-9][0-9]*)$/);
  if (match) {
    const number = Number(match[1]);
    if (number <= model.cells.length) {
      while (position < number) append();
      target.querySelector(location.hash)?.scrollIntoView({ block: "center" });
    }
  }
  if (/^#L[1-9][0-9]*$/.test(location.hash)) showRaw();
}
