const labels = {
  all: "全部协作内容",
  code: "代码",
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
    `<div class="titlebar"><h1>跨项目搜索</h1></div><form id="global-search" class="panel search-form" role="search"><label class="field" for="global-query">关键词<input id="global-query" name="q" value="${esc(q)}" placeholder="搜索标题、正文或选择代码范围" maxlength="128" required></label><div class="search-filters">${select("type", "内容类型", labels, "all")}${select("state", "协作状态", states, "all")}${select("archived", "归档项目", { include: "包含归档", exclude: "仅未归档", only: "仅已归档" }, "include")}<label class="field" for="search-namespace">空间标识<input id="search-namespace" name="namespace" value="${esc(params.get("namespace") || "")}" maxlength="64" placeholder="留空搜索所有可访问空间"></label></div><div class="search-filters" id="code-search-filters"><label class="field">文件路径包含<input name="path" value="${esc(params.get("path") || "")}" maxlength="1000"></label><label class="field">扩展名<input name="extension" value="${esc(params.get("extension") || "")}" maxlength="32" placeholder="例如 ts、py"></label></div><button type="submit" class="btn primary">搜索</button><p class="hint">代码搜索至少输入三个字符，检索各项目默认分支的已发布索引快照。更新异步完成；结果中的版本和覆盖提示说明索引状态。协作搜索不包括评论及 Wiki 历史。</p></form><section id="search-results" class="panel" aria-live="polite" aria-busy="${!!q.trim()}"><div class="empty">${q.trim() ? "正在搜索…" : "输入关键词开始搜索"}</div></section>`,
    "搜索",
    "search",
  );
  const typeSelect = document.querySelector('#global-search [name="type"]');
  const updateScope = () => {
    const code = typeSelect.value === "code";
    document.querySelector("#code-search-filters").style.display = code
      ? ""
      : "none";
    document.querySelector('#global-search [name="state"]').disabled = code;
    document.querySelector("#global-query").minLength = code ? 3 : 1;
  };
  typeSelect.addEventListener("change", updateScope);
  updateScope();
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
      (data.coverage
        ? '<p class="detail-body info">可访问项目 ' +
          data.coverage.projects +
          " 个，已有索引 " +
          data.coverage.indexed_projects +
          " 个；等待更新 " +
          data.coverage.pending_projects +
          " 个，覆盖不完整 " +
          data.coverage.partial_projects +
          " 个，更新异常 " +
          data.coverage.failed_projects +
          " 个。无命中不代表未完成索引的项目没有相关代码。</p>"
        : "") +
      data.results
        .map((item) => {
          const base =
            "/" +
            encodeURIComponent(item.namespace) +
            "/" +
            encodeURIComponent(item.name);
          const url =
            item.type === "code"
              ? base +
                "?ref=" +
                encodeURIComponent(item.indexed_sha) +
                "&path=" +
                encodeURIComponent(item.path) +
                "&view=blob#L" +
                item.line
              : base +
                (item.type === "project"
                  ? ""
                  : "/" +
                    { issue: "issues", merge: "merges", wiki: "wiki" }[
                      item.type
                    ] +
                    "/" +
                    encodeURIComponent(item.id));
          return `<article class="search-result"><div class="muted">${labels[item.type]} · <a data-link href="${esc(base)}">${esc(item.namespace)}/${esc(item.name)}</a>${item.state ? " · " + (states[item.state] || esc(item.state)) : ""}${item.archived_at ? " · 已归档" : ""}</div><h2><a data-link href="${esc(url)}">${highlight(item.title || item.path)}</a></h2>${item.type === "code" ? `<p class="muted">${esc(item.indexed_branch)} @ <code>${esc(item.indexed_sha.slice(0, 12))}</code> · 第 ${item.line} 行 · ${esc(new Date(item.indexed_at).toLocaleString())}${item.stale ? " · 索引更新中" : ""}</p>` : ""}${item.excerpt ? `<p>${highlight(item.excerpt)}</p>` : ""}${item.type === "project" ? `<a data-link class="small" href="${esc(base + "/search?q=" + encodeURIComponent(q.trim()))}">搜索这个项目的代码 →</a>` : ""}</article>`;
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

export function mountCodeIndex(host, r, ap, h) {
  const labels = {
    queued: "等待索引",
    indexing: "正在索引",
    ready: "索引就绪",
    partial: "索引覆盖不完整",
    failed: "索引更新异常",
  };
  let stopped = false;
  async function load() {
    if (!h.current() || !host.isConnected) return;
    try {
      const row = await h.api(ap + "/code-index");
      if (!h.current() || !host.isConnected) return;
      const c = row.coverage;
      host.innerHTML =
        '<div class="panelhead"><strong>跨项目代码索引 · ' +
        h.esc(labels[row.status] || row.status) +
        "</strong>" +
        (["owner", "maintainer"].includes(r.role)
          ? '<button class="btn small" type="button" data-rebuild-index>重建索引</button>'
          : "") +
        '</div><div class="detail-body">' +
        (row.indexed_sha
          ? "<p><code>" +
            h.esc(row.indexed_sha.slice(0, 12)) +
            "</code> · " +
            h.esc(row.indexed_branch) +
            " · " +
            h.esc(new Date(row.indexed_at).toLocaleString()) +
            "</p>"
          : "<p>尚无已发布的代码索引。</p>") +
        (c && row.indexed_sha
          ? "<p>已检查 " +
            c.files +
            " 个条目，索引 " +
            c.indexed_files +
            " 个文件，跳过 " +
            c.skipped_files +
            " 个条目。" +
            (c.unscanned ? "还有未扫描内容；已达到本轮索引限制。" : "") +
            "</p>"
          : "") +
        (row.stale
          ? "<p>有待处理更新。下方项目内搜索直接读取 Git，跨项目搜索使用已发布索引快照。</p>"
          : "") +
        (row.error ? '<p class="error">' + h.esc(row.error) + "</p>" : "") +
        '<a data-link href="/search?type=code&namespace=' +
        encodeURIComponent(r.namespace) +
        '">跨项目搜索代码 →</a></div>';
      host
        .querySelector("[data-rebuild-index]")
        ?.addEventListener("click", async (e) => {
          e.target.disabled = true;
          try {
            await h.api(ap + "/code-index/rebuild", {
              method: "POST",
              body: {},
            });
            await load();
          } catch (error) {
            h.notice(error.message);
            e.target.disabled = false;
          }
        });
    } catch (error) {
      if (h.current() && host.isConnected) {
        host.textContent = error.message;
        stopped = true;
      }
    }
  }
  const poll = async () => {
    if (!h.current() || !host.isConnected) return;
    if (!document.hidden && !stopped) await load();
    setTimeout(poll, 10000);
  };
  poll();
}
