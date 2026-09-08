const labels = {
  all: "全部内容",
  project: "项目",
  issue: "Issue",
  merge: "合并请求",
  wiki: "Wiki",
};
const states = {
  all: "全部状态",
  open: "打开",
  closed: "关闭",
  merged: "已合并",
};
export async function searchPage(h) {
  const { esc, api, layout, go, current } = h;
  if (!current()) return;
  const params = new URLSearchParams(location.search),
    q = params.get("q") || "";
  const select = (name, label, options, fallback) =>
    `<label class="field">${label}<select name="${name}">${Object.entries(
      options,
    )
      .map(
        ([value, text]) =>
          `<option value="${value}" ${(params.get(name) || fallback) === value ? "selected" : ""}>${text}</option>`,
      )
      .join("")}</select></label>`;
  document.title = "跨项目搜索 · OneStorage";
  layout(
    `<div class="titlebar"><h1>跨项目搜索</h1></div><form id="global-search" class="panel search-form" role="search"><label class="field" for="global-query">关键词<input id="global-query" name="q" value="${esc(q)}" placeholder="搜索标题、描述或正文" maxlength="128" required></label><div class="search-filters">${select("type", "内容类型", labels, "all")}${select("state", "协作状态", states, "all")}${select("archived", "归档项目", { include: "包含归档", exclude: "仅未归档", only: "仅已归档" }, "include")}<label class="field" for="search-namespace">空间标识<input id="search-namespace" name="namespace" value="${esc(params.get("namespace") || "")}" maxlength="64" placeholder="留空搜索所有可访问空间"></label></div><button type="submit" class="btn primary">搜索</button><p class="hint">搜索所有当前可访问项目的标题和正文。代码请进入项目的「搜索」页；评论和 Wiki 历史版本不包含在这里。指定协作状态时只显示 Issue 和合并请求。</p></form><section id="search-results" class="panel" aria-live="polite" aria-busy="${!!q.trim()}"><div class="empty">${q.trim() ? "正在搜索…" : "输入关键词开始搜索"}</div></section>`,
    "搜索",
    "search",
  );
  document
    .querySelector("#global-search")
    .addEventListener("submit", (event) => {
      event.preventDefault();
      const next = new URLSearchParams(new FormData(event.currentTarget));
      next.set("q", next.get("q").trim());
      go("/search?" + next);
    });
  if (!q.trim()) return;
  const target = document.querySelector("#search-results");
  try {
    const data = await api("/search?" + params);
    if (!current() || !target.isConnected) return;
    const highlight = (text) => {
      // Mirror SQLite's built-in ASCII-only case folding; all other text is literal.
      const fold = (s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
      const needle = fold(q.trim()),
        haystack = fold(text || "");
      let at = 0,
        html = "",
        index;
      while ((index = haystack.indexOf(needle, at)) !== -1) {
        html +=
          esc(text.slice(at, index)) +
          "<mark>" +
          esc(text.slice(index, index + needle.length)) +
          "</mark>";
        at = index + needle.length;
      }
      return html + esc((text || "").slice(at));
    };
    target.innerHTML =
      `<div class="panelhead"><strong>本页 ${data.results.length} 条结果</strong><span>${data.has_more ? "还有更多结果" : "已到最后一页"}</span></div>` +
      data.results
        .map((item) => {
          const base =
            "/" +
            encodeURIComponent(item.namespace) +
            "/" +
            encodeURIComponent(item.name);
          const url =
            base +
            (item.type === "project"
              ? ""
              : "/" +
                { issue: "issues", merge: "merges", wiki: "wiki" }[item.type] +
                "/" +
                encodeURIComponent(item.id));
          return `<article class="search-result"><div class="muted">${labels[item.type]} · <a data-link href="${esc(base)}">${esc(item.namespace)}/${esc(item.name)}</a>${item.state ? " · " + (states[item.state] || esc(item.state)) : ""}${item.archived_at ? " · 已归档" : ""}</div><h2><a data-link href="${esc(url)}">${highlight(item.title)}</a></h2>${item.excerpt ? `<p>${highlight(item.excerpt)}</p>` : ""}${item.type === "project" ? `<a data-link class="small" href="${esc(base + "/search?q=" + encodeURIComponent(q.trim()))}">搜索这个项目的代码 →</a>` : ""}</article>`;
        })
        .join("") +
      (data.results.length
        ? ""
        : '<div class="empty">没有符合当前筛选条件的结果</div>');
    if (data.next_cursor) {
      const next = new URLSearchParams(params);
      next.set("cursor", data.next_cursor);
      target.innerHTML += `<div class="panelhead"><a data-link class="btn" href="${esc("/search?" + next)}">下一页 →</a></div>`;
    }
  } catch (error) {
    if (!current() || !target.isConnected) return;
    target.innerHTML = `<div class="empty error">${esc(error.message)}</div>`;
  } finally {
    if (target.isConnected) target.setAttribute("aria-busy", "false");
  }
}
