import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import yaml from "highlight.js/lib/languages/yaml";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import sql from "highlight.js/lib/languages/sql";
import markdown from "highlight.js/lib/languages/markdown";
import diff from "highlight.js/lib/languages/diff";
import java from "highlight.js/lib/languages/java";
import cpp from "highlight.js/lib/languages/cpp";
import dockerfile from "highlight.js/lib/languages/dockerfile";
for (const [name, grammar] of Object.entries({
  javascript,
  typescript,
  python,
  go,
  rust,
  json,
  bash,
  yaml,
  css,
  xml,
  sql,
  markdown,
  diff,
  java,
  cpp,
  dockerfile,
}))
  hljs.registerLanguage(name, grammar);
const extensions = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  go: "go",
  rs: "rust",
  json: "json",
  jsonc: "javascript",
  sh: "bash",
  bash: "bash",
  yml: "yaml",
  yaml: "yaml",
  css: "css",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  sql: "sql",
  md: "markdown",
  diff: "diff",
  patch: "diff",
  java: "java",
  c: "cpp",
  h: "cpp",
  cpp: "cpp",
  hpp: "cpp",
};
export function highlightCode(code, path) {
  const language =
    path.toLowerCase() === "dockerfile"
      ? "dockerfile"
      : extensions[path.split(".").at(-1)?.toLowerCase()];
  if (!language || code.length > 200000) return null;
  try {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}
