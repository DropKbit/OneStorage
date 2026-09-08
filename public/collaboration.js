const button = (text, action, id = "") =>
  `<button type="button" class="btn small" data-collab="${action}" data-id="${id}">${text}</button>`;
function actions(h, fn) {
  document.querySelectorAll("[data-collab]").forEach(
    (b) =>
      (b.onclick = async () => {
        b.disabled = true;
        try {
          await fn(b.dataset.collab, b.dataset.id, b);
        } catch (e) {
          h.notice(e.message);
        } finally {
          b.disabled = false;
        }
      }),
  );
}
const writable = (r) =>
    !r.archived_at && ["owner", "maintainer", "developer"].includes(r.role),
  maintain = (r) => !r.archived_at && ["owner", "maintainer"].includes(r.role);
export async function reviewPage(r, base, ap, h, id) {
  const { api, repoLayout, esc, field, textarea, bindForm, render } = h,
    m = await api(
      ap +
        "/merges/" +
        id +
        (new URLSearchParams(location.search).get("discussions_after")
          ? "?discussions_after=" +
            encodeURIComponent(
              new URLSearchParams(location.search).get("discussions_after"),
            )
          : ""),
    );
  if (!h.current()) return;
  repoLayout(
    r,
    "merges",
    `<div class="titlebar"><div><h2>!${m.id} ${esc(m.title)}</h2><p>${esc(m.source_namespace || r.namespace)}/${esc(m.source_name || r.name)}:${esc(m.source)} → ${esc(m.target)} · ${esc(m.author)}</p></div><span class="pill">${esc(m.state)}</span></div><div class="panel"><div class="detail-body markdown" data-markdown>${esc(m.body)}</div><div class="panelhead"><strong>审阅与检查</strong><span>${m.gate.approvals} 个有效批准</span></div><div class="detail-body">${m.stale && m.state === "open" ? '<p class="error">分支已有新提交。更新此请求后，需要重新审阅。</p>' : ""}${codeownersPanel(m.gate.codeowners, esc)}${m.closing_issues?.length ? `<p>合并到默认分支后关闭：${m.closing_issues.map((id) => `<a data-link href="${base}/issues/${id}">#${id}</a>`).join("、")}</p>` : ""}${m.gate.reasons.map((x) => `<p>${esc(x)}</p>`).join("")}<p>源提交 CI：${m.gate.ci ? `<a data-link href="${base}/ci/${m.gate.ci.id}">${esc(m.gate.ci.status)}</a>` : "尚未运行"}</p>${(h.user?.id === m.author_id || maintain(r)) && m.state !== "merged" ? button("更新到最新提交", "refresh") + button(m.state === "open" ? "关闭请求" : "重新打开", "toggle") : ""}</div>${maintain(r) && m.state === "open" ? button("运行此版本 CI", "pipeline") : ""}${m.gate.reviews.map((v) => `<div class="comment"><strong>${esc(v.username)} · ${esc(v.verdict)}</strong> <code>${v.source_sha.slice(0, 8)}</code>${v.source_sha !== m.source_sha || v.target_sha !== m.target_sha ? ' <span class="muted">旧版本</span>' : ""}<div class="markdown" data-markdown>${esc(v.body)}</div></div>`).join("")}${h.user && m.state === "open" ? `<form class="form" id="review"><label>审阅意见<select name="verdict"><option value="comment">评论</option>${writable(r) && h.user.id !== m.author_id ? '<option value="approve">批准</option><option value="changes">要求修改</option>' : ""}</select></label>${textarea("说明", "body")}<button class="btn primary" type="submit">提交审阅</button></form>` : ""}</div><div class="panel"><div class="panelhead"><strong>代码变更</strong><code>${m.target_sha.slice(0, 8)} → ${m.source_sha.slice(0, 8)}</code></div>${reviewDiff(m.diff, esc, !!h.user && m.state === "open")}</div><section class="panel" id="discussions"><div class="panelhead"><strong>行级讨论</strong><span>${m.gate.unresolved || 0} 个待解决审阅讨论</span></div><div id="discussion-list">${(m.discussions || []).map((d) => discussionRow(d, m, esc)).join("") || '<p class="detail-body muted">暂无讨论</p>'}</div>${m.discussions_next ? `<a data-link class="btn small" href="${base}/merges/${id}?discussions_after=${m.discussions_next}">更多讨论 →</a>` : ""}${h.user && m.state === "open" ? `<form id="new-discussion" class="form"><p id="discussion-location">普通讨论 · 可点击差异行号定位到代码</p><input type="hidden" name="path"><input type="hidden" name="side"><input type="hidden" name="line">${textarea("讨论内容", "body")}<div class="inline"><button class="btn primary" type="submit">发起讨论</button><button class="btn" type="button" id="clear-discussion-location">清除行定位</button></div></form>` : ""}</section>${maintain(r) && m.state === "open" ? `<form id="merge-reviewed" class="form panel"><label>合并方式<select name="strategy"><option value="ff_prefer">快进或三方合并</option><option value="merge">创建合并提交</option><option value="ff_only">仅快进</option></select></label><label><input type="checkbox" name="squash"> 压缩提交</label><button class="btn primary" type="submit" ${m.gate.allowed ? "" : "disabled"}>合并此版本</button></form>` : ""}`,
  );
  bindForm("#review", async (b) => {
    await api(ap + "/merges/" + id + "/reviews", {
      method: "POST",
      body: { ...b, source_sha: m.source_sha, target_sha: m.target_sha },
    });
    render();
  });
  bindForm("#merge-reviewed", async (b) => {
    await api(ap + "/merges/" + id + "/merge", {
      method: "POST",
      body: {
        strategy: b.strategy,
        squash: b.squash === "on",
        revision: m.revision,
      },
    });
    render();
  });
  bindDiscussions(m, r, base, ap, h, id);
  actions(h, async (a) => {
    if (a === "pipeline") {
      const run = await api(ap + "/merges/" + id + "/pipeline", {
        method: "POST",
        body: {},
      });
      h.go(base + "/ci/" + run.id);
      return;
    }
    await api(ap + "/merges/" + id, {
      method: "PATCH",
      body:
        a === "refresh"
          ? { refresh: true, revision: m.revision }
          : {
              state: m.state === "open" ? "closed" : "open",
              revision: m.revision,
            },
    });
    render();
  });
}
export async function projectPage(r, base, ap, h, tab, sub) {
  const { api, repoLayout, esc, field, textarea, bindForm, render, go } = h;
  if (tab === "protect") {
    const { rules } = await api(ap + "/protections");
    if (!h.current()) return;
    repoLayout(
      r,
      "protect",
      `<div class="panel"><div class="panelhead"><h2>受保护分支</h2></div>${rules.map((x) => `<div class="token-row"><div><strong>${esc(x.branch)}</strong><p>禁止强推和删除 · ${x.require_mr ? "必须通过合并请求 · " : ""}${x.approvals} 人批准${x.require_ci ? " · CI 必须成功" : ""}${x.require_resolved ? " · 审阅讨论必须解决" : ""}${x.require_codeowners ? " · CODEOWNERS 必须批准" : ""}</p></div>${maintain(r) ? button("移除保护", "delete", esc(x.branch)) : ""}</div>`).join("") || '<div class="empty">暂无规则</div>'}${maintain(r) ? `<form id="protection" class="form">${field("分支名称", "branch", "text", r.default_branch)}${field("独立审阅批准人数", "approvals", "number", "1")}<label><input type="checkbox" name="require_mr" checked> 必须通过合并请求</label><label><input type="checkbox" name="require_ci"> 最新源提交 CI 必须成功</label><label><input type="checkbox" name="require_resolved"> 目标仓库审阅者的讨论必须解决</label><label><input type="checkbox" name="require_codeowners"> CODEOWNERS 指定的负责人必须批准</label><p class="muted">从目标分支的 CODEOWNERS、.gitlab/CODEOWNERS、docs/CODEOWNERS 或 .github/CODEOWNERS 依次读取规则；开启后缺少有效文件会阻止合并。</p><button class="btn primary" type="submit">保存规则</button></form>` : ""}</div>`,
    );
    bindForm("#protection", async (b) => {
      await api(ap + "/protections", {
        method: "PUT",
        body: {
          ...b,
          approvals: Number(b.approvals),
          require_mr: b.require_mr === "on",
          require_ci: b.require_ci === "on",
          require_resolved: b.require_resolved === "on",
          require_codeowners: b.require_codeowners === "on",
        },
      });
      render();
    });
    actions(h, async (a, id) => {
      await api(ap + "/protections", {
        method: "DELETE",
        body: { branch: id },
      });
      render();
    });
    return;
  }
  if (tab === "planning") {
    const d = await api(ap + "/planning");
    if (!h.current()) return;
    repoLayout(
      r,
      "planning",
      `<div class="forge-grid"><section class="panel"><div class="panelhead"><h2>标签</h2></div>${d.labels.map((l) => `<div class="token-row"><span class="pill" data-label-color="${l.color}">${esc(l.name)}</span>${writable(r) ? button("删除", "label-delete", l.id) : ""}</div>`).join("")}${writable(r) ? `<form class="form" id="label">${field("标签名称", "name")}${field("颜色（六位十六进制）", "color", "text", "64748b")}<button class="btn" type="submit">添加标签</button></form>` : ""}</section><section class="panel"><div class="panelhead"><h2>里程碑</h2></div>${d.milestones.map((m) => `<div class="token-row"><div><strong>${esc(m.title)}</strong><p>${m.closed}/${m.total} 完成 · ${esc(m.state)} · ${esc(m.due_date || "无截止日期")}</p><p>${esc(m.description)}</p></div>${writable(r) ? button(m.state === "open" ? "关闭" : "重开", "milestone-toggle", m.id) : ""}</div>`).join("")}${writable(r) ? `<form class="form" id="milestone">${field("标题", "title")}${textarea("说明", "description")}<label>截止日期<input type="date" name="due_date"></label><button class="btn" type="submit">创建里程碑</button></form>` : ""}</section></div>`,
    );
    document.querySelectorAll("[data-label-color]").forEach((el) => {
      el.style.borderColor = "#" + el.dataset.labelColor;
    });
    bindForm("#label", async (b) => {
      await api(ap + "/labels", { method: "POST", body: b });
      render();
    });
    bindForm("#milestone", async (b) => {
      await api(ap + "/milestones", {
        method: "POST",
        body: { ...b, due_date: b.due_date || null },
      });
      render();
    });
    actions(h, async (a, id) => {
      if (a === "label-delete")
        await api(ap + "/labels/" + id, { method: "DELETE" });
      else
        await api(ap + "/milestones/" + id, {
          method: "PATCH",
          body: {
            state:
              d.milestones.find((m) => m.id === id).state === "open"
                ? "closed"
                : "open",
          },
        });
      render();
    });
    return;
  }
  if (tab === "releases") {
    const { releases } = await api(ap + "/releases");
    if (!h.current()) return;
    repoLayout(
      r,
      "releases",
      `<div class="titlebar"><h2>版本发布</h2></div>${releases.map((x) => `<section class="panel"><div class="panelhead"><strong>${esc(x.title)} · ${esc(x.tag)}</strong><span>${x.prerelease ? "预发布" : "正式版"}</span></div><div class="detail-body"><div class="markdown" data-markdown>${esc(x.body)}</div><p><code>${x.sha}</code> · ${esc(x.author)}</p>${button("下载源码", "download", x.sha)} ${maintain(r) ? button("删除发布", "delete", x.id) : ""}</div></section>`).join("") || '<div class="empty">从已有 Git 标签发布一个版本。</div>'}${maintain(r) ? `<form class="panel form" id="release">${field("已有标签", "tag")}${field("发布标题", "title")}${textarea("更新说明", "body")}<label><input type="checkbox" name="prerelease"> 预发布版本</label><button class="btn primary" type="submit">发布版本</button></form>` : ""}`,
    );
    bindForm("#release", async (b) => {
      await api(ap + "/releases", {
        method: "POST",
        body: { ...b, prerelease: b.prerelease === "on" },
      });
      render();
    });
    actions(h, async (a, id) => {
      if (a === "download") {
        const response = await fetch("/api" + ap + "/archive", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ref: id }),
        });
        if (!response.ok) throw Error((await response.json()).error);
        const url = URL.createObjectURL(await response.blob()),
          link = document.createElement("a");
        link.href = url;
        link.download = r.name + "-" + id.slice(0, 8) + ".tar.gz";
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return;
      }
      await api(ap + "/releases/" + id, { method: "DELETE" });
      render();
    });
    return;
  }
  if (tab === "deployments") {
    const d = await api(ap + "/deployments");
    if (!h.current()) return;
    repoLayout(
      r,
      "deployments",
      `<div class="titlebar"><h2>Cloudflare 应用发布</h2></div><div class="panel"><div class="detail-body"><p>成功流水线生成不可变版本。激活版本即可发布；选择历史版本即可回滚。启用公开访问后，任何人都能访问应用。</p></div>${d.environments.map((e) => `<div class="token-row"><div><strong>${esc(e.name)}</strong><p>${e.deployment_id ? e.deployment_id.slice(0, 8) : "尚未激活"} · ${e.public ? "公开" : "未公开"}</p>${e.public && e.deployment_id ? `<a target="_blank" rel="noopener noreferrer" href="${esc(e.url)}">打开应用 ↗</a>` : ""}</div>${maintain(r) && e.deployment_id ? button("停止公开访问", "unpublish", esc(e.name)) : ""}</div>`).join("")}</div><div class="panel"><div class="panelhead"><strong>可用版本</strong></div>${d.deployments.map((x) => `<div class="token-row"><div><strong>${esc(x.environment)}</strong> · <code>${x.sha.slice(0, 12)}</code><p>${esc(x.created_at)} · <a data-link href="${base}/ci/${x.run_id}">流水线</a></p></div>${maintain(r) ? button("激活并公开此版本", "activate", x.id) : ""}</div>`).join("") || '<div class="empty">在 Worker 流水线中添加 deploy 配置。</div>'}</div>`,
    );
    actions(h, async (a, id) => {
      const dep = d.deployments.find((x) => x.id === id),
        env = d.environments.find((e) => e.name === (dep?.environment || id));
      await api(ap + "/environments/" + env.name, {
        method: "PUT",
        body: {
          deployment_id: dep?.id || env.deployment_id,
          expected_deployment_id: env.deployment_id,
          public: a === "activate",
        },
      });
      render();
    });
    return;
  }
  if (tab === "wiki") {
    if (sub) {
      const version = new URLSearchParams(location.search).get("version"),
        p = await api(
          ap + "/wiki/" + sub + (version ? "?version=" + version : ""),
        );
      if (!h.current()) return;
      repoLayout(
        r,
        "wiki",
        `<div class="titlebar"><h2>${esc(p.title)}</h2><a data-link class="btn" href="${base}/wiki">全部页面</a></div><div class="panel detail-body"><div class="markdown" data-markdown>${esc(p.body)}</div></div><p>版本 ${p.version} · ${p.history.map((v) => `<a data-link href="${base}/wiki/${sub}?version=${v.version}">v${v.version}</a>`).join(" · ")}</p>${writable(r) && !version ? `<details class="panel"><summary class="panelhead">编辑页面</summary><form id="wiki-edit" class="form">${field("标题", "title", "text", p.title)}${textarea("正文", "body", p.body)}<button type="submit" class="btn primary">保存新版本</button></form></details>` : ""}`,
      );
      bindForm("#wiki-edit", async (b) => {
        await api(ap + "/wiki/" + sub, {
          method: "PUT",
          body: { ...b, expected_version: p.version },
        });
        render();
      });
      return;
    }
    const { pages } = await api(ap + "/wiki");
    if (!h.current()) return;
    repoLayout(
      r,
      "wiki",
      `<div class="panel"><div class="panelhead"><h2>项目 Wiki</h2></div>${pages.map((p) => `<div class="token-row"><a data-link href="${base}/wiki/${esc(p.slug)}">${esc(p.title)}</a><span>v${p.version}</span></div>`).join("") || '<div class="empty">记录项目设计、操作手册和团队约定。</div>'}</div>${writable(r) ? `<form id="wiki-new" class="form panel">${field("页面标识", "slug")}${field("标题", "title")}${textarea("正文", "body")}<button class="btn primary" type="submit">创建页面</button></form>` : ""}`,
    );
    bindForm("#wiki-new", async (b) => {
      await api(ap + "/wiki/" + encodeURIComponent(b.slug), {
        method: "PUT",
        body: { title: b.title, body: b.body, expected_version: 0 },
      });
      go(base + "/wiki/" + b.slug);
    });
    return;
  }
}
export async function issuePlanning(r, ap, h, issue) {
  if (!writable(r)) return;
  const { api, esc, field, bindForm, render } = h,
    d = await api(ap + "/planning");
  if (!h.current()) return;
  const panel = document.createElement("section");
  panel.className = "panel";
  panel.innerHTML = `<form class="form" id="issue-planning"><h3>指派与规划</h3><label>负责人（仓库成员）<input name="assignee" value="${esc(issue.assignee || "")}"></label><label>里程碑<select name="milestone_id"><option value="">无</option>${d.milestones.map((m) => `<option value="${m.id}" ${m.id === issue.milestone_id ? "selected" : ""}>${esc(m.title)}</option>`).join("")}</select></label><div>${d.labels.map((l) => `<label class="check"><input type="checkbox" name="label:${l.id}" ${issue.labels.some((x) => x.id === l.id) ? "checked" : ""}>${esc(l.name)}</label>`).join("")}</div><button type="submit" class="btn">保存分配</button></form>`;
  document.querySelector(".content").append(panel);
  bindForm("#issue-planning", async (b) => {
    await api(ap + "/issues/" + issue.id + "/planning", {
      method: "PUT",
      body: {
        revision: issue.revision,
        assignee: b.assignee || null,
        milestone_id: b.milestone_id || null,
        labels: Object.keys(b)
          .filter((k) => k.startsWith("label:"))
          .map((k) => k.slice(6)),
      },
    });
    render();
  });
}
export async function notificationsPage(h) {
  const { api, layout, esc, render } = h,
    { notifications: n } = await api("/notifications");
  if (!h.current()) return;
  layout(
    `<div class="titlebar"><h1>通知</h1>${n.length ? button("全部标为已读", "read") : ""}</div><div class="panel">${n.map((x) => `<div class="token-row"><div><a data-link href="/${esc(x.namespace)}/${esc(x.name)}">${esc(x.namespace)}/${esc(x.name)}</a><p>${esc(x.action)} · ${esc(x.detail)}</p></div><span>${x.read ? "已读" : "未读"}</span></div>`).join("") || '<div class="empty">关注项目后，在这里查看协作更新。</div>'}</div>`,
    "通知",
  );
  actions(h, async () => {
    await api("/notifications/read", {
      method: "POST",
      body: { through_id: n[0].id },
    });
    render();
  });
}

export async function social(r, ap, h) {
  if (!h.user) return;
  const d = await h.api(ap + "/social");
  if (!h.current()) return;
  const el = document.createElement("div");
  el.className = "toolbar";
  el.innerHTML =
    button((d.starred ? "★ 已收藏" : "☆ 收藏") + " " + d.stars, "star") +
    button(d.watching ? "正在关注" : "关注项目", "watch");
  document.querySelector(".content > .titlebar")?.append(el);
  el.querySelectorAll("[data-collab]").forEach(
    (b) =>
      (b.onclick = async () => {
        try {
          const on = b.dataset.collab === "star" ? d.starred : d.watching;
          await h.api(ap + "/" + b.dataset.collab, {
            method: on ? "DELETE" : "PUT",
          });
          h.render();
        } catch (e) {
          h.notice(e.message);
        }
      }),
  );
}
export async function mergesPage(r, base, ap, h) {
  const { api, repoLayout, esc, field, textarea, bindForm, go } = h;
  const [{ merges }, { branches }, sources] = await Promise.all([
    api(ap + "/merges"),
    api(ap + "/branches"),
    h.user ? api(ap + "/merge-sources") : { repositories: [] },
  ]);
  if (!h.current()) return;
  const repositories = sources.repositories;
  repoLayout(
    r,
    "merges",
    `<div class="stack">${h.user && repositories.length && branches.length ? `<details class="panel"><summary class="panelhead">＋ 新建合并请求</summary><form class="form" id="new-merge">${field("标题", "title")}<div class="field"><label>来源仓库<select name="source_repo" id="merge-source-repo">${repositories.map((s) => `<option value="${s.id}" ${s.id === r.id ? "selected" : ""}>${esc(s.namespace)}/${esc(s.name)}</option>`).join("")}</select></label></div><div class="inline"><div class="field"><label>来源分支<select name="source" id="merge-source-branch"></select></label></div><div class="field"><label>目标分支<select name="target">${branches.map((b) => `<option value="${esc(b.name)}" ${b.name === r.default_branch ? "selected" : ""}>${esc(b.name)}</option>`).join("")}</select></label></div></div><p class="hint">创建请求会把来源分支的提交历史及关联文件发布给目标仓库的读者。Fork 的其他分支和仓库权限保持独立。</p>${textarea("描述", "body")}<button class="btn primary" type="submit">创建合并请求</button></form></details>` : h.user ? '<div class="info">先 Fork 这个仓库并推送变更，再回到这里提交合并请求。</div>' : ""}<div class="panel"><div class="panelhead"><strong>合并请求</strong><span>最近 100 条</span></div>${merges.map((m) => `<div class="issue-row"><span class="status-icon">⑂</span><div><a data-link class="subject" href="${base}/merges/${m.id}">${esc(m.title)}</a><p class="muted">!${m.id} · ${esc(m.source_namespace || r.namespace)}/${esc(m.source_name || r.name)}:${esc(m.source)} → ${esc(m.target)} · ${esc(m.state)}</p></div></div>`).join("") || '<div class="empty">暂无合并请求</div>'}</div></div>`,
  );
  const selector = document.querySelector("#merge-source-repo");
  if (selector) {
    let sequence = 0;
    const load = async () => {
      const seq = ++sequence,
        source = repositories.find((x) => x.id === selector.value),
        select = document.querySelector('#new-merge [name="source"]'),
        button = document.querySelector("#new-merge button[type=submit]");
      button.disabled = true;
      try {
        const rows =
          source.id === r.id
            ? { branches }
            : await api(
                "/repos/" +
                  source.namespace +
                  "/" +
                  encodeURIComponent(source.name) +
                  "/branches",
              );
        if (!h.current() || seq !== sequence) return;
        select.innerHTML = rows.branches
          .map((b) => `<option value="${esc(b.name)}">${esc(b.name)}</option>`)
          .join("");
        button.disabled = !rows.branches.length;
      } catch (e) {
        if (h.current() && seq === sequence) {
          select.replaceChildren();
          select.insertAdjacentHTML(
            "beforebegin",
            `<p class="error">${esc(e.message)}</p>`,
          );
        }
      }
    };
    selector.onchange = load;
    await load();
  }
  bindForm("#new-merge", async (b) => {
    const m = await api(ap + "/merges", { method: "POST", body: b });
    go(base + "/merges/" + m.id);
  });
}
export function reviewDiff(diff, esc, interactive) {
  if (!diff) return '<div class="empty">无文件差异</div>';
  let path = "",
    inHunk = false,
    old = 0,
    next = 0;
  return (
    '<div class="review-diff">' +
    diff
      .split("\n")
      .map((line) => {
        const header = line.match(
          /^diff --git ("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/,
        );
        if (header) {
          try {
            path = JSON.parse(header[2]).slice(2);
          } catch {
            path = "";
          }
          old = next = 0;
          inHunk = false;
        }
        const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunk) {
          inHunk = true;
          old = Number(hunk[1]);
          next = Number(hunk[2]);
        }
        let left = "",
          right = "",
          kind = "";
        if (path && !header && !hunk && inHunk) {
          if (line.startsWith("-")) {
            left = old++;
            kind = "removed";
          } else if (line.startsWith("+")) {
            right = next++;
            kind = "added";
          } else if (line.startsWith(" ")) {
            left = old++;
            right = next++;
          }
        }
        const number = (value, side) =>
          value && interactive
            ? `<button type="button" class="diff-line-number" data-review-path="${esc(path)}" data-review-line="${value}" data-review-side="${side}" aria-label="讨论 ${esc(path)} ${side === "old" ? "旧" : "新"}第 ${value} 行">${value}</button>`
            : esc(value);
        return `<div class="review-diff-row ${kind}"><span>${number(left, "old")}</span><span>${number(right, "new")}</span><code>${esc(line)}</code></div>`;
      })
      .join("") +
    "</div>"
  );
}
function discussionRow(d, m, esc) {
  return `<article class="discussion" data-thread-id="${d.id}"><div class="panelhead"><strong>${esc(d.author)} · ${d.resolved ? "已解决" : "未解决"}</strong><span>${d.source_sha !== m.source_sha || d.target_sha !== m.target_sha ? "旧版本 · " : ""}${d.path ? `${esc(d.path)} · ${d.side === "old" ? "旧" : "新"}第 ${d.line} 行` : "普通讨论"}</span></div><div class="detail-body"><button type="button" class="btn small" data-open-discussion="${d.id}">查看讨论 (${d.comments_count})</button><div id="discussion-${d.id}"></div></div></article>`;
}
function bindDiscussions(m, r, base, ap, h, id) {
  const { api, esc, textarea, bindForm, render } = h,
    root = ap + "/merges/" + id;
  document.querySelectorAll("[data-review-line]").forEach(
    (b) =>
      (b.onclick = () => {
        const form = document.querySelector("#new-discussion");
        for (const key of ["path", "side", "line"])
          form.elements[key].value =
            b.dataset["review" + key[0].toUpperCase() + key.slice(1)];
        document.querySelector("#discussion-location").textContent =
          b.dataset.reviewPath +
          " · " +
          (b.dataset.reviewSide === "old" ? "旧" : "新") +
          "第 " +
          b.dataset.reviewLine +
          " 行";
        form.scrollIntoView({ block: "center" });
        form.elements.body.focus();
      }),
  );
  const clear = document.querySelector("#clear-discussion-location");
  if (clear)
    clear.onclick = () => {
      const f = document.querySelector("#new-discussion");
      for (const key of ["path", "side", "line"]) f.elements[key].value = "";
      document.querySelector("#discussion-location").textContent = "普通讨论";
    };
  bindForm("#new-discussion", async (b) => {
    if (!b.path) {
      delete b.path;
      delete b.side;
      delete b.line;
    } else b.line = Number(b.line);
    await api(root + "/discussions", {
      method: "POST",
      body: { ...b, source_sha: m.source_sha, target_sha: m.target_sha },
    });
    render();
  });
  document.querySelectorAll("[data-open-discussion]").forEach(
    (button) =>
      (button.onclick = async () => {
        const thread = button.dataset.openDiscussion;
        button.disabled = true;
        try {
          const response = await api(root + "/discussions/" + thread);
          if (!h.current()) return;
          const box = document.querySelector("#discussion-" + thread),
            rows = response.comments;
          const comment = (x) =>
            `<div class="comment"><strong>${esc(x.author)}</strong><div class="markdown" data-markdown data-ref="${m.source_sha}" data-base="${esc(base)}">${esc(x.body)}</div></div>`;
          box.innerHTML = `<div id="thread-comments-${thread}">${rows.map(comment).join("")}</div>${response.next ? '<button class="btn small" type="button" id="more-comments-' + thread + '">更多回复</button>' : ""}${h.user && m.state === "open" ? `<form id="reply-${thread}" class="form">${textarea("回复", "body")}<button type="submit" class="btn primary">回复</button></form>${h.user.id === response.thread.author_id || h.user.id === m.author_id || writable(r) ? `<button type="button" class="btn small" id="resolve-${thread}">${response.thread.resolved ? "重新打开讨论" : "标记已解决"}</button>` : ""}` : ""}`;
          bindForm("#reply-" + thread, async (b) => {
            await api(root + "/discussions/" + thread + "/comments", {
              method: "POST",
              body: b,
            });
            render();
          });
          const resolve = document.querySelector("#resolve-" + thread);
          if (resolve)
            resolve.onclick = async () => {
              resolve.disabled = true;
              try {
                await api(root + "/discussions/" + thread, {
                  method: "PATCH",
                  body: { resolved: !response.thread.resolved },
                });
                render();
              } catch (e) {
                h.notice(e.message);
                resolve.disabled = false;
              }
            };
          let cursor = response.next;
          const more = document.querySelector("#more-comments-" + thread);
          if (more)
            more.onclick = async () => {
              more.disabled = true;
              try {
                const page = await api(
                  root + "/discussions/" + thread + "?after=" + cursor,
                );
                if (!h.current()) return;
                document
                  .querySelector("#thread-comments-" + thread)
                  .insertAdjacentHTML(
                    "beforeend",
                    page.comments.map(comment).join(""),
                  );
                cursor = page.next;
                if (!cursor) more.remove();
                else more.disabled = false;
                h.markdown({ base, ref: m.source_sha }).catch(() => {});
              } catch (e) {
                h.notice(e.message);
                more.disabled = false;
              }
            };
          h.markdown({ base, ref: m.source_sha }).catch(() => {});
        } catch (e) {
          h.notice(e.message);
        } finally {
          button.disabled = false;
        }
      }),
  );
}

export function codeownersPanel(codeowners, esc) {
  if (!codeowners) return "";
  return `<details class="codeowners"><summary>CODEOWNERS · ${esc(codeowners.file || "缺少规则文件")} · ${codeowners.allowed ? "已满足" : "等待批准"}</summary><p>规则来自目标提交 <code>${esc(codeowners.target_sha.slice(0, 8))}</code>。每条匹配规则独立计数，作者及已失去开发权限的成员不计入。</p>${codeowners.requirements.map((r) => `<div class="comment"><strong>${esc(r.section)} · ${esc(r.pattern)}</strong><p>${r.approved_count ?? r.approved.length}/${r.required} 个批准${r.required === 0 ? "（可选）" : ""} · ${r.owners.map(esc).join(" ")}</p><p>可审批（共 ${r.eligible_count ?? r.eligible.length} 人，最多显示 50 人）：${r.eligible.map(esc).join("、") || "暂无独立负责人"}</p><p>已批准：${r.approved.map(esc).join("、") || "暂无"}</p><details><summary>${r.path_count ?? r.paths.length} 个文件（最多显示 20 个）</summary>${r.paths.map((p) => `<div><code>${esc(p)}</code></div>`).join("")}</details></div>`).join("")}</details>`;
}
