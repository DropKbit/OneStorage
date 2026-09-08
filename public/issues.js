import {
  text as i18nText,
  html as i18nHTML,
  getLocale,
} from "./i18n.js?v=b03346d448c25b98";
const writable = (r) =>
  !r.archived_at && ["developer", "maintainer", "owner"].includes(r.role);
const maintain = (r) =>
  !r.archived_at && ["maintainer", "owner"].includes(r.role);
export function issueCard(i, base, esc, select = false, board) {
  return `<article class="issue-card" ${board ? `draggable="${board.writable}" data-issue-id="${i.id}" data-revision="${i.revision}" data-column="${esc(board.column)}"` : ""}>${select ? i18nHTML`<input type="checkbox" aria-label="选择 Issue ${i.id}" data-select-issue="${i.id}" data-revision="${i.revision}">` : ""}<div><a data-link class="subject" href="${base}/issues/${i.id}">${esc(i.title)}</a><p class="muted">#${i.id} · ${esc(i.author)} · ${i.state === "open" ? i18nText("开放") : i18nText("已关闭")}${i.assignee ? i18nText(" · 指派给 ") + esc(i.assignee) : ""}${i.milestone ? " · " + esc(i.milestone) : ""}</p><div class="issue-labels">${i.labels.map((l) => `<span class="pill" style="border-color:#${/^[a-f0-9]{6}$/i.test(l.color) ? l.color : "64748b"}">${esc(l.name)}</span>`).join("")}</div>${
    board?.writable
      ? i18nHTML`<label class="muted">移动到<select data-move-issue="${i.id}" data-revision="${i.revision}" data-from="${esc(board.column)}"><option value="">选择列</option>${board.columns
          .filter((c) => c.id !== board.column)
          .map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`)
          .join("")}</select></label>`
      : ""
  }</div></article>`;
}
export async function issuesPage(r, base, ap, h) {
  const {
      api,
      repoLayout,
      esc,
      field,
      textarea,
      bindForm,
      go,
      render,
      notice,
    } = h,
    params = new URLSearchParams(location.search),
    isBoard = params.get("view") === "board",
    boardId = params.get("board") || "default";
  const listParams = new URLSearchParams(params);
  listParams.set("limit", "50");
  const [planning, boards, data] = await Promise.all([
    api(ap + "/planning"),
    api(ap + "/issue-boards"),
    api(
      ap +
        (isBoard
          ? "/issue-boards/" + encodeURIComponent(boardId)
          : "/issues?" + listParams),
    ),
  ]);
  if (!h.current()) return;
  const option = (value, label, selected) =>
    `<option value="${esc(value)}" ${selected === value ? "selected" : ""}>${esc(label)}</option>`;
  const labelChecks = (prefix, selected = []) =>
    planning.labels
      .map(
        (l) =>
          `<label class="check"><input type="checkbox" name="${prefix}:${l.id}" ${selected.includes(l.id) ? "checked" : ""}>${esc(l.name)}</label>`,
      )
      .join("");
  const filter = i18nHTML`<form class="form panel issue-filters" id="issue-filters">${field(i18nText("搜索标题和描述"), "q", "text", params.get("q") || "")}<div class="inline">${
    !isBoard
      ? i18nHTML`<label>状态<select name="state">${[
          ["all", i18nText("全部")],
          ["open", i18nText("开放")],
          ["closed", i18nText("已关闭")],
        ]
          .map(([v, l]) => option(v, l, params.get("state") || "all"))
          .join("")}</select></label>`
      : ""
  }${field(i18nText("作者（用户名或 me）"), "author", "text", params.get("author") || "")}${field(i18nText("负责人（用户名、me 或 none）"), "assignee", "text", params.get("assignee") || "")}<label>里程碑<select name="milestone">${option("", i18nText("全部"), params.get("milestone"))}${option("none", i18nText("未分配"), params.get("milestone"))}${planning.milestones.map((m) => option(m.id, m.title, params.get("milestone"))).join("")}</select></label><label>排序<select name="sort">${[
    ["newest", i18nText("最新创建")],
    ["oldest", i18nText("最早创建")],
    ["updated", i18nText("最近更新")],
  ]
    .map(([v, l]) => option(v, l, params.get("sort") || "newest"))
    .join(
      "",
    )}</select></label></div><details><summary>标签（同时匹配）</summary>${labelChecks("filter-label", (params.get("labels") || "").split(","))}</details><div><button class="btn primary" type="submit">筛选</button> <a data-link class="btn" href="${base}/issues${isBoard ? "?view=board&board=" + boardId : ""}">清除筛选</a></div></form>`;
  const create =
    h.user && !r.archived_at
      ? i18nHTML`<details class="panel"><summary class="panelhead">＋ 新建 Issue</summary><form class="form" id="new-issue">${field(i18nText("标题"), "title")}${textarea(i18nText("描述"), "body")}<button class="btn primary" type="submit">创建 Issue</button></form></details>`
      : "";
  const query = new URLSearchParams(params);
  query.delete("cursor");
  query.set("view", isBoard ? "list" : "board");
  const header = `<div class="titlebar"><h2>Issues ${isBoard ? i18nText("看板") : ""}</h2><a data-link class="btn" href="${base}/issues?${query}">${isBoard ? i18nText("列表视图") : i18nText("看板视图")}</a></div>`;
  const bulk =
    writable(r) && !isBoard
      ? i18nHTML`<details class="panel"><summary class="panelhead">批量更新本页勾选的 Issue（最多 50 个）</summary><form id="issue-bulk" class="form"><label>状态<select name="state">${option("", i18nText("保持不变"))}${option("open", i18nText("重新打开"))}${option("closed", i18nText("关闭"))}</select></label>${field(i18nText("负责人（留空保持不变，none 清空）"), "assignee")}<label>里程碑<select name="milestone_id">${option("", i18nText("保持不变"))}${option("none", i18nText("清空"))}${planning.milestones.map((m) => option(m.id, m.title)).join("")}</select></label><details><summary>添加标签</summary>${labelChecks("add")}</details><details><summary>移除标签</summary>${labelChecks("remove")}</details><button class="btn" type="submit">更新所选 Issue</button><p class="muted">如果任一 Issue 已被修改，整批操作会停止，请刷新后重新选择。</p></form></details>`
      : "";
  let body;
  const columns = isBoard
    ? [
        { id: "open", name: i18nText("待处理") },
        ...data.labels,
        { id: "closed", name: i18nText("已关闭") },
      ]
    : [];
  if (isBoard) {
    body = i18nHTML`<div class="panel form"><label>看板<select id="choose-board">${boards.boards.map((b) => option(b.id, b.name, boardId)).join("")}</select></label>${
      maintain(r)
        ? i18nHTML`<details><summary>${boardId === "default" ? i18nText("创建标签看板") : i18nText("编辑或创建看板")}</summary><form class="form" id="board-settings">${field(i18nText("看板名称"), "name", "text", boardId === "default" ? "" : data.name)}<div>${labelChecks(
            "column",
            (data.labels || []).map((l) => l.id),
          )}</div><button class="btn" type="submit">${boardId === "default" ? i18nText("创建") : i18nText("保存此看板")}</button>${boardId !== "default" ? i18nText('<button class="btn" type="button" id="new-board">另建看板</button><button class="btn danger" type="button" id="delete-board">删除此看板视图</button>') : ""}<p class="muted">最多 12 个标签列；删除视图保留所有 Issue。关闭卡片会保留标签，移至待处理会移除本看板的标签。</p></form></details>`
        : ""
    }</div><div class="issue-board">${columns.map((c) => i18nHTML`<section class="board-column" data-drop-column="${esc(c.id)}"><h3>${esc(c.name)} <span data-count="${esc(c.id)}"></span></h3><div data-cards="${esc(c.id)}" class="board-cards"><p class="muted">读取中…</p></div><button class="btn small" data-more="${esc(c.id)}" hidden>加载更多</button></section>`).join("")}</div>`;
  } else {
    const next = new URLSearchParams(params);
    if (data.next_cursor) next.set("cursor", data.next_cursor);
    body = i18nHTML`${bulk}<section class="panel"><div class="panelhead"><strong>${data.total} 个匹配 Issue · ${data.open} 个开放</strong>${writable(r) ? i18nText('<label><input type="checkbox" id="select-all-issues"> 选择本页</label>') : ""}</div>${data.issues.map((i) => issueCard(i, base, esc, writable(r))).join("") || i18nText('<p class="detail-body muted">没有符合筛选的 Issue。</p>')}${data.next_cursor ? i18nHTML`<a data-link class="btn" href="${base}/issues?${next}">下一页 →</a>` : ""}</section>`;
  }
  repoLayout(
    r,
    "issues",
    header + `<div class="stack">${create}${filter}${body}</div>`,
  );
  bindForm("#issue-filters", async (b) => {
    const q = new URLSearchParams();
    for (const k of ["q", "state", "author", "assignee", "milestone", "sort"])
      if (b[k]) q.set(k, b[k]);
    const labels = Object.keys(b)
      .filter((k) => k.startsWith("filter-label:"))
      .map((k) => k.slice(13));
    if (labels.length) q.set("labels", labels.join(","));
    if (isBoard) {
      q.set("view", "board");
      q.set("board", boardId);
    }
    go(base + "/issues?" + q);
  });
  bindForm("#new-issue", async (b) => {
    const issue = await api(ap + "/issues", { method: "POST", body: b });
    go(base + "/issues/" + issue.id);
  });
  bindForm("#issue-bulk", async (b) => {
    const issues = [
      ...document.querySelectorAll("[data-select-issue]:checked"),
    ].map((e) => ({
      id: Number(e.dataset.selectIssue),
      revision: Number(e.dataset.revision),
    }));
    if (!issues.length || issues.length > 50)
      throw Error(i18nText("请选择 1–50 个 Issue"));
    const changes = {};
    if (b.state) changes.state = b.state;
    if (b.assignee)
      changes.assignee = b.assignee === "none" ? null : b.assignee;
    if (b.milestone_id)
      changes.milestone_id = b.milestone_id === "none" ? null : b.milestone_id;
    for (const [prefix, key] of [
      ["add:", "add_labels"],
      ["remove:", "remove_labels"],
    ]) {
      const labels = Object.keys(b)
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length));
      if (labels.length) changes[key] = labels;
    }
    await api(ap + "/issues/bulk", {
      method: "POST",
      body: { issues, changes },
    });
    render();
  });
  document
    .querySelector("#select-all-issues")
    ?.addEventListener("change", (e) => {
      for (const checkbox of document.querySelectorAll("[data-select-issue]"))
        checkbox.checked = e.target.checked;
    });
  if (!isBoard) return;
  document.querySelector("#choose-board").addEventListener("change", (e) => {
    const q = new URLSearchParams(params);
    q.set("board", e.target.value);
    q.delete("cursor");
    go(base + "/issues?" + q);
  });
  bindForm("#board-settings", async (b) => {
    const body = {
      name: b.name,
      labels: Object.keys(b)
        .filter((k) => k.startsWith("column:"))
        .map((k) => k.slice(7)),
      revision: data.revision,
    };
    const result = await api(
      ap + "/issue-boards" + (boardId === "default" ? "" : "/" + boardId),
      { method: boardId === "default" ? "POST" : "PUT", body },
    );
    go(base + "/issues?view=board&board=" + (result.id || boardId));
  });
  document
    .querySelector("#new-board")
    ?.addEventListener("click", () =>
      go(base + "/issues?view=board&board=default"),
    );
  document
    .querySelector("#delete-board")
    ?.addEventListener("click", async () => {
      try {
        await api(ap + "/issue-boards/" + boardId, { method: "DELETE" });
        go(base + "/issues?view=board");
      } catch (e) {
        notice(e.message);
      }
    });
  let dragging = null,
    busy = false;
  async function move(item, to) {
    if (busy) return;
    busy = true;
    try {
      await api(ap + "/issue-boards/" + boardId + "/move", {
        method: "POST",
        body: {
          issue: { id: item.id, revision: item.revision },
          from: item.from,
          to,
          board_revision: data.revision,
        },
      });
      render();
    } catch (e) {
      notice(e.message);
    } finally {
      busy = false;
    }
  }
  function bindCards(root) {
    for (const card of root.querySelectorAll(
      '[draggable="true"]:not([data-bound])',
    )) {
      card.dataset.bound = "true";
      card.addEventListener("dragend", () => {
        dragging = null;
      });
      card.addEventListener("dragstart", (e) => {
        dragging = {
          id: Number(card.dataset.issueId),
          revision: Number(card.dataset.revision),
          from: card.dataset.column,
        };
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(dragging.id));
      });
    }
    for (const select of root.querySelectorAll(
      "[data-move-issue]:not([data-bound])",
    )) {
      select.dataset.bound = "true";
      select.addEventListener("change", () => {
        if (select.value)
          move(
            {
              id: Number(select.dataset.moveIssue),
              revision: Number(select.dataset.revision),
              from: select.dataset.from,
            },
            select.value,
          );
      });
    }
  }
  for (const column of document.querySelectorAll("[data-drop-column]")) {
    column.addEventListener("dragover", (e) => {
      if (writable(r)) e.preventDefault();
    });
    column.addEventListener("drop", (e) => {
      e.preventDefault();
      if (dragging && writable(r)) {
        move(dragging, column.dataset.dropColumn);
        dragging = null;
      }
    });
  }
  const queues = columns.map((c) => c);
  async function load(column, cursor) {
    const q = new URLSearchParams(params);
    q.delete("cursor");
    q.set("column", column.id);
    q.set("limit", "20");
    if (cursor) q.set("cursor", cursor);
    const page = await api(ap + "/issue-boards/" + boardId + "/cards?" + q);
    if (!h.current()) return;
    const root = document.querySelector(`[data-cards="${column.id}"]`);
    if (!cursor) root.innerHTML = "";
    const more = document.querySelector(`[data-more="${column.id}"]`);
    root.insertAdjacentHTML(
      "beforeend",
      page.issues
        .map((i) =>
          issueCard(i, base, esc, false, {
            column: column.id,
            columns,
            writable: writable(r),
          }),
        )
        .join(""),
    );
    if (!root.children.length)
      root.innerHTML = i18nText('<p class="muted">暂无 Issue</p>');
    document.querySelector(`[data-count="${column.id}"]`).textContent =
      page.total;
    more.hidden = !page.next_cursor;
    more.onclick = async () => {
      more.disabled = true;
      try {
        await load(column, page.next_cursor);
      } catch (e) {
        notice(e.message);
      } finally {
        more.disabled = false;
      }
    };
    bindCards(root);
  }
  // Bound concurrent database-backed column requests; each column paginates independently.
  await Promise.all(
    Array.from({ length: Math.min(3, queues.length) }, async () => {
      while (queues.length && h.current()) {
        const c = queues.shift();
        try {
          await load(c);
        } catch (e) {
          if (h.current())
            document.querySelector(`[data-cards="${c.id}"]`).textContent =
              e.message;
        }
      }
    }),
  );
}
