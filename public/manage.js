const roleNames = {
  reader: "只读",
  developer: "开发者",
  maintainer: "维护者",
  owner: "所有者",
};
const statuses = {
  queued: "排队中",
  running: "运行中",
  succeeded: "成功",
  failed: "失败",
  canceled: "已取消",
};
const button = (label, action, id = "", danger = false) =>
  `<button type="button" class="btn small ${danger ? "danger" : ""}" data-action="${action}" data-id="${id}">${label}</button>`;
function actions(h, callback) {
  document.querySelectorAll("[data-action]").forEach(
    (b) =>
      (b.onclick = async () => {
        b.disabled = true;
        try {
          await callback(b.dataset.action, b.dataset.id, b);
        } catch (e) {
          h.notice(e.message);
        } finally {
          b.disabled = false;
        }
      }),
  );
}
const roleSelect = (owner = false) =>
  `<div class="field"><label>角色</label><select name="role">${Object.entries(
    roleNames,
  )
    .filter(([k]) => owner || k !== "owner")
    .map(([k, v]) => `<option value="${k}">${v}</option>`)
    .join("")}</select></div>`;
export async function spacesPage(h, slug) {
  const { api, esc, field, textarea, layout, bindForm, go, render } = h;
  if (!slug) {
    const { workspaces } = await api("/workspaces");
    if (!h.current()) return;
    layout(
      `<div class="titlebar"><div><h1>工作空间</h1><p class="muted">按团队组织项目、分配权限，在空间之间切换。</p></div></div><div class="panel">${workspaces.map((w) => `<article class="repo-row"><div class="repo-info"><a data-link href="/?namespace=${esc(w.slug)}" class="repo-name">${esc(w.name)}</a><p>${esc(w.slug)} · ${roleNames[w.role]}</p></div>${!w.personal ? `<a data-link class="btn small" href="/spaces/${esc(w.slug)}">管理空间</a>` : '<span class="pill">个人</span>'}</article>`).join("")}</div><div class="panel"><form class="form" id="create-space"><h2>创建团队空间</h2>${field("空间标识", "slug", "text", "", "用于 Git URL，创建后不可修改。")}${field("空间名称", "name")}${textarea("描述", "description")}<button class="btn primary" type="submit">创建空间</button></form></div>`,
      "工作空间",
      "spaces",
    );
    bindForm("#create-space", async (b) => {
      const w = await api("/workspaces", { method: "POST", body: b });
      await h.reloadSpaces();
      go("/spaces/" + w.slug);
    });
    return;
  }
  const ap = "/workspaces/" + encodeURIComponent(slug),
    [w, { members }] = await Promise.all([api(ap), api(ap + "/members")]);
  if (!h.current()) return;
  const owner = w.role === "owner",
    maintain = ["owner", "maintainer"].includes(w.role);
  layout(
    `<div class="titlebar"><div><h1>${esc(w.name)}</h1><p class="muted">${esc(w.slug)} · ${esc(w.description)}</p></div><a data-link href="/?namespace=${esc(w.slug)}" class="btn">空间项目 →</a></div><div class="panel"><div class="panelhead"><strong>空间成员</strong><span>权限继承到空间中的所有仓库</span></div>${members.map((m) => `<div class="token-row"><strong>${esc(m.username)}${m.disabled ? " · 已停用" : ""}</strong><div class="actionbar"><span class="pill">${roleNames[m.role]}</span>${owner ? button("移除", "remove", esc(m.username), true) : ""}</div></div>`).join("")}</div>${owner ? `<div class="panel"><form class="form" id="space-member"><h2>添加或更新成员</h2>${field("用户名", "username")}${roleSelect(true)}<button class="btn primary" type="submit">保存权限</button></form></div>` : ""}${maintain ? `<div class="panel"><form class="form" id="space-settings"><h2>空间设置</h2>${field("空间名称", "name", "text", w.name)}${textarea("描述", "description", w.description)}<button class="btn" type="submit">保存空间</button></form></div>` : ""}`,
    "空间管理",
    "spaces",
  );
  bindForm("#space-member", async (b) => {
    await api(ap + "/members", { method: "PUT", body: b });
    render();
  });
  bindForm("#space-settings", async (b) => {
    await api(ap, { method: "PATCH", body: b });
    await h.reloadSpaces();
    render();
  });
  actions(h, async (a, id) => {
    if (a === "remove") {
      await api(ap + "/members/" + encodeURIComponent(id), {
        method: "DELETE",
      });
      await h.reloadSpaces();
      render();
    }
  });
}
export async function adminConsole(h, user) {
  const { api, layout, esc, field, bindForm, render } = h;
  const tab = new URLSearchParams(location.search).get("tab") || "users";
  const [overview, data] = await Promise.all([
    api("/admin/overview"),
    api(
      "/admin/" +
        (["users", "workspaces", "repositories", "audit"].includes(tab)
          ? tab
          : "users"),
    ),
  ]);
  if (!h.current()) return;
  const tabs = ["users", "workspaces", "repositories", "audit"],
    labels = ["用户", "空间", "仓库", "审计"];
  let content = "";
  if (tab === "users")
    content = `<div class="panel">${data.users.map((u) => `<div class="token-row"><div><strong>${esc(u.username)}</strong><p class="muted">${u.admin ? "管理员" : "普通用户"} · ${u.disabled ? "已停用" : "正常"}</p></div><div class="actionbar">${u.id !== user.id ? button(u.admin ? "设为普通用户" : "设为管理员", u.admin ? "demote" : "promote", u.id) + button(u.disabled ? "启用" : "停用", u.disabled ? "enable" : "disable", u.id, !u.disabled) : '<span class="pill">当前账号</span>'}${button("撤销会话", "revoke", u.id)}${button("重设密码", "password", u.id)}</div></div>`).join("")}</div><div class="panel"><form class="form" id="new-user"><h2>创建用户</h2>${field("用户名", "username")}${field("初始密码", "password", "password")}<button class="btn primary" type="submit">创建账号</button></form></div><div id="admin-password"></div>`;
  else if (tab === "workspaces")
    content = `<div class="panel">${data.workspaces.map((w) => `<div class="token-row"><div><strong>${esc(w.name)}</strong><p class="muted">${esc(w.slug)} · ${w.members} 位成员</p></div>${button("恢复所有者", "recover", w.id)}</div>`).join("") || '<div class="empty">尚无团队空间</div>'}</div><div id="recover-space"></div>`;
  else if (tab === "repositories")
    content = `<div class="panel">${data.repositories.map((r) => `<div class="token-row"><strong>${esc(r.namespace)} / ${esc(r.name)}</strong><div class="actionbar"><span class="pill">${esc(r.visibility)}</span>${button("管理", "edit-repo", r.id)}<a data-link class="btn small" href="/${esc(r.namespace)}/${encodeURIComponent(r.name)}">打开</a></div></div>`).join("") || '<div class="empty">尚无仓库</div>'}</div><p class="muted">后台展示仓库目录；读取私有代码仍需空间或仓库权限。</p><div id="admin-repo"></div>`;
  else
    content = `<div class="panel audit-list">${data.events.map((e) => `<article><div class="actionbar"><strong>${esc(e.action)}</strong><span class="muted">${esc(e.actor || "system")} · ${esc(e.created_at)}</span></div><pre>${esc(e.detail)}</pre></article>`).join("") || '<div class="empty">暂无审计记录</div>'}</div>`;
  layout(
    `<div class="titlebar"><div><h1>管理员后台</h1><p class="muted">账号、团队与实例运行情况。</p></div></div><div class="stats">${[
      ["用户", overview.users],
      ["团队空间", overview.workspaces],
      ["仓库", overview.repositories],
      ["活动流水线", overview.active_runs],
    ]
      .map(
        ([k, v]) =>
          `<div class="stat"><div class="muted">${k}</div><div class="number">${v}</div></div>`,
      )
      .join(
        "",
      )}</div><nav class="tabs">${tabs.map((t, i) => `<a data-link class="tab ${tab === t ? "active" : ""}" href="/admin/users?tab=${t}">${labels[i]}</a>`).join("")}</nav>${content}`,
    "管理员后台",
    "admin",
  );
  bindForm("#new-user", async (b) => {
    await api("/users", { method: "POST", body: b });
    render();
  });
  actions(h, async (a, id) => {
    if (a === "edit-repo") {
      const r = data.repositories.find((r) => r.id === id);
      const name = r.namespace + "/" + r.name;
      document.querySelector("#admin-repo").innerHTML =
        `<div class="panel"><form class="form" id="admin-repo-settings"><h2>${esc(name)}</h2>${h.textarea("描述", "description", r.description)}<div class="field"><label>可见性</label><select name="visibility"><option value="private" ${r.visibility === "private" ? "selected" : ""}>私有</option><option value="public" ${r.visibility === "public" ? "selected" : ""}>公开</option></select></div><button class="btn primary" type="submit">保存</button></form><form class="form" id="admin-repo-delete"><h2>删除仓库</h2>${field("输入完整仓库名确认删除", "confirm", "text", "", name)}<button class="btn danger" type="submit">永久删除仓库</button></form></div>`;
      bindForm("#admin-repo-settings", async (b) => {
        await api("/admin/repositories/" + id, { method: "PATCH", body: b });
        render();
      });
      bindForm("#admin-repo-delete", async (b) => {
        if (b.confirm !== name) throw Error("仓库名不匹配");
        await api("/admin/repositories/" + id, { method: "DELETE" });
        render();
      });
      return;
    }
    if (a === "password") {
      document.querySelector("#admin-password").innerHTML =
        `<div class="panel"><form class="form" id="reset-password"><h2>重设用户密码</h2>${field("新密码", "password", "password")}<button class="btn danger" type="submit">保存并撤销全部会话</button></form></div>`;
      bindForm("#reset-password", async (b) => {
        await api("/admin/users/" + id, { method: "PATCH", body: b });
        render();
      });
      return;
    }
    if (a === "recover") {
      document.querySelector("#recover-space").innerHTML =
        `<div class="panel"><form class="form" id="recover-owner"><h2>添加空间所有者</h2>${field("用户名", "username")}<button class="btn primary" type="submit">恢复所有权</button></form></div>`;
      bindForm("#recover-owner", async (b) => {
        await api("/admin/workspaces/" + id + "/owner", {
          method: "PUT",
          body: b,
        });
        render();
      });
      return;
    }
    const b = {
      promote: { admin: true },
      demote: { admin: false },
      enable: { disabled: false },
      disable: { disabled: true },
      revoke: { revoke_sessions: true },
    }[a];
    if (b) {
      await api("/admin/users/" + id, { method: "PATCH", body: b });
      render();
    }
  });
}
export async function ciPage(r, base, ap, h, runId) {
  const { api, repoLayout, esc, bindForm, field, textarea, render, go } = h,
    root = ap + "/ci",
    maintain = !r.archived_at && ["owner", "maintainer"].includes(r.role);
  if (runId) {
    const run = await api(root + "/runs/" + runId);
    if (!h.current()) return;
    repoLayout(
      r,
      "ci",
      `<div class="toolbar"><a data-link class="btn" href="${base}/ci">← 流水线</a><span class="pill ci-${run.status}">${statuses[run.status]}</span>${button("刷新", "refresh")}${maintain ? (["queued", "running"].includes(run.status) ? button("取消运行", "cancel", run.id, true) : button("重新运行", "retry", run.id)) : ""}</div><div class="panel"><div class="panelhead"><strong>${esc(run.config.name)}</strong><code>${run.sha.slice(0, 12)}</code></div><div class="detail-body"><p>${esc(run.ref)} · ${esc(run.trigger)} · ${esc(run.created_at)}</p>${run.error ? `<p class="error">${esc(run.error)}</p>` : ""}<pre class="ci-log" aria-label="流水线日志">${esc(run.logs.map((l) => l.content).join("") || "等待执行器领取任务…")}</pre></div></div><div class="panel"><div class="panelhead"><strong>构建产物</strong></div>${run.artifacts.map((a) => `<div class="token-row"><a href="/api${root}/runs/${run.id}/artifacts/${a.id}" download>${esc(a.name)}</a><span>${a.size} bytes</span></div>`).join("") || '<div class="empty">暂无产物</div>'}</div>`,
    );
    actions(h, async (a) => {
      if (a === "refresh") return render();
      const result = await api(root + "/runs/" + run.id + "/" + a, {
        method: "POST",
        body: {},
      });
      if (a === "retry") go(base + "/ci/" + result.id);
      else render();
    });
    if (["queued", "running"].includes(run.status))
      setTimeout(() => {
        if (h.current()) render();
      }, 5000);
    return;
  }
  const [saved, { runs }, runnerData] = await Promise.all([
    api(root + "/config"),
    api(root + "/runs"),
    maintain ? api(root + "/runners") : Promise.resolve({ runners: [] }),
  ]);
  if (!h.current()) return;
  const sample = {
    name: "Build and deploy",
    runner: "external",
    branches: [r.default_branch],
    timeout_seconds: 900,
    steps: [
      { type: "run", name: "Install", command: "npm ci" },
      { type: "run", name: "Test", command: "npm test" },
      {
        type: "run",
        name: "Deploy to Cloudflare",
        command: "npx wrangler deploy",
      },
    ],
    artifacts: [],
  };
  const cloudSample = {
    name: "Cloudflare JavaScript / WASM",
    runner: "worker",
    branches: [r.default_branch],
    timeout_seconds: 90,
    steps: [
      {
        type: "javascript",
        entry: "ci.js",
        files: ["ci.js", "index.js"],
        cpu_ms: 1000,
      },
    ],
    deploy: {
      kind: "worker",
      entry: "index.js",
      files: ["index.js"],
      environment: "production",
    },
  };
  const config = saved.config || cloudSample;
  repoLayout(
    r,
    "ci",
    `<div class="titlebar"><div><h2>CI/CD</h2><p class="muted">推送自动触发，按提交构建，查看日志与部署结果。</p></div>${button("刷新", "refresh")}</div>${maintain ? `<form class="toolbar" id="run-pipeline">${field("分支", "ref", "text", r.default_branch)}<button class="btn primary" type="submit">运行流水线</button></form>` : ""}<div class="panel"><div class="panelhead"><strong>最近运行</strong><span>${saved.enabled ? "自动触发已启用" : "自动触发已关闭"}</span></div>${runs.map((run) => `<div class="token-row"><div><a data-link href="${base}/ci/${run.id}"><strong>${esc(run.config.name)}</strong></a><p class="muted">${esc(run.ref)} · ${run.sha.slice(0, 8)} · ${esc(run.created_at)}</p></div><span class="pill ci-${run.status}">${statuses[run.status]}</span></div>`).join("") || '<div class="empty">配置流水线后，推送代码或手动运行。</div>'}</div>${maintain ? `<div class="panel"><form class="form" id="pipeline-config"><h2>流水线配置</h2><p class="muted">Cloudflare 模板在隔离 Worker 中执行仓库 ci.js，保存产物和应用版本。CI 脚本导出异步函数，失败时抛出异常；发布后在「应用发布」中激活或回滚。</p><div class="actionbar">${button("Cloudflare 云端执行模板", "template-cloud")}${button("外部 Runner 模板", "template-external")}${button("Worker 检查模板", "template-worker")}</div>${textarea("JSON 配置", "config", JSON.stringify(config, null, 2), "code-input")}<label class="check"><input type="checkbox" name="enabled" ${saved.enabled ? "checked" : ""}> 推送自动触发</label><button class="btn primary" type="submit">保存配置</button></form></div><div class="panel"><div class="panelhead"><strong>仓库 Runner</strong></div>${runnerData.runners.map((r) => `<div class="token-row"><div><strong>${esc(r.name)}</strong><p class="muted">${r.last_seen ? "最近在线 " + new Date(r.last_seen).toLocaleString() : "尚未连接"}</p></div>${button("撤销", "revoke-runner", r.id, true)}</div>`).join("")}<form class="form" id="create-runner">${field("Runner 名称", "name")}<button class="btn" type="submit">注册 Runner</button></form><div id="runner-token"></div><div class="detail-body"><p>在专用主机下载源码、安装依赖后运行：</p><pre>ONESTORAGE_ORIGIN=${esc(location.origin)} \\\nONESTORAGE_RUNNER_TOKEN_FILE=/secure/runner-token \\\nONESTORAGE_JOB_ENV=CLOUDFLARE_API_TOKEN,CLOUDFLARE_ACCOUNT_ID \\\nnode scripts/runner.mjs</pre><p class="muted">令牌文件权限设为 600。仅连接你信任代码的仓库；每个 Runner 只领取本仓库任务。</p></div></div>` : ""}`,
  );
  bindForm("#run-pipeline", async (b) => {
    const run = await api(root + "/runs", { method: "POST", body: b });
    go(base + "/ci/" + run.id);
  });
  bindForm("#pipeline-config", async (b) => {
    await api(root + "/config", {
      method: "PUT",
      body: { config: JSON.parse(b.config), enabled: b.enabled === "on" },
    });
    render();
  });
  bindForm("#create-runner", async (b) => {
    const runner = await api(root + "/runners", { method: "POST", body: b });
    document.querySelector("#runner-token").innerHTML =
      `<div class="detail-body"><strong>令牌仅显示这一次，请保存到 Runner 的令牌文件</strong><pre>${esc(runner.token)}</pre></div>`;
  });
  actions(h, async (a, id) => {
    if (a === "refresh") return render();
    if (a === "revoke-runner") {
      await api(root + "/runners/" + id, { method: "DELETE" });
      return render();
    }
    if (a.startsWith("template-")) {
      document.querySelector("#pipeline-config textarea").value =
        JSON.stringify(
          a === "template-cloud"
            ? cloudSample
            : a === "template-worker"
              ? {
                  name: "Repository checks",
                  runner: "worker",
                  branches: [r.default_branch],
                  steps: [
                    { type: "file", path: "package.json", format: "json" },
                  ],
                  artifacts: [],
                }
              : sample,
          null,
          2,
        );
    }
  });
}
