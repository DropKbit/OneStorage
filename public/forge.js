import {
  text as i18nText,
  html as i18nHTML,
  getLocale,
} from "./i18n.js?v=421fdfd4be286a79";
export async function keyPage(h) {
  const { api, layout, esc, field, textarea, bindForm, notice, render } = h;
  const [{ keys: apiKeys }, { keys: signing }, github] = await Promise.all([
    api("/api-keys"),
    api("/signing-keys"),
    api("/integrations/github"),
  ]);
  if (!h.current()) return;
  const list = (keys, type) =>
    keys
      .map(
        (k) =>
          i18nHTML`<div class="token-row"><div><strong>${esc(k.name)}</strong><p class="muted">${esc(k.algorithm || k.fingerprint)}</p></div><button class="btn small danger" data-key="${esc(type + "/" + k.id)}">撤销</button></div>`,
      )
      .join("");
  layout(
    i18nHTML`<div class="titlebar"><div><h1>密钥与连接</h1><p class="muted">为自动化签发短期权限，连接上游代码仓库。</p></div></div><div class="forge-grid"><section class="panel"><div class="panelhead"><strong>JWT API 公钥</strong></div>${list(apiKeys, "api-keys")}<form id="api-key" class="form"><p class="muted">客户端保留私钥；OneStorage 仅保存公钥。撤销后，现有 JWT 立即失效。</p>${field(i18nText("名称"), "name")}${textarea(i18nText("SPKI 公钥 PEM"), "public_key")}<div class="field"><label>签名算法</label><select name="algorithm"><option>ES256</option><option>ES384</option><option>ES512</option><option>RS256</option></select></div><button type="submit" class="btn primary">注册公钥</button></form></section><section class="panel"><div class="panelhead"><strong>提交签名公钥</strong></div>${list(signing, "signing-keys")}<form id="signing-key" class="form"><p class="muted">用于 verify-sig 引用策略，支持 SSH 与 OpenPGP。</p>${field(i18nText("名称"), "signing-name")}${textarea(i18nText("SSH / OpenPGP 公钥"), "signing-public-key")}<button type="submit" class="btn primary">注册签名公钥</button></form></section></div><section class="panel"><form id="github-app" class="form"><h2>GitHub App</h2><p class="muted">${github.configured ? i18nText("已配置 · App ") + esc(github.app_id) : i18nText("尚未连接")}。安装令牌按仓库申请，私钥和 Webhook 密钥加密存储。</p>${github.webhook_url ? `<code>${esc(github.webhook_url)}</code>` : ""}${field("App ID", "app_id", "text", github.app_id || "")}${field("Installation ID", "installation_id", "text", github.installation_id || "")}${textarea(i18nText("App 私钥 PEM"), "private_key")}${field(i18nText("Webhook 密钥"), "webhook_secret", "password")}<div class="inline"><button type="submit" class="btn primary">保存连接</button>${github.configured ? i18nText('<button type="button" class="btn danger" id="disconnect-github">断开连接</button>') : ""}</div></form></section><section class="panel"><div class="form"><h2>Agent 接入</h2><p>MCP 地址：<code>${esc(location.origin + "/mcp")}</code></p><p class="muted">使用 Bearer PAT 或短期 JWT。工具调用沿用仓库权限和引用策略。</p><a href="/llms.txt" target="_blank">机器可读说明 ↗</a></div></section>`,
    i18nText("密钥与连接"),
    "keys",
  );
  bindForm("#api-key", async (d) => {
    await api("/api-keys", { method: "POST", body: d });
    render();
  });
  bindForm("#signing-key", async (d) => {
    await api("/signing-keys", {
      method: "POST",
      body: { name: d["signing-name"], public_key: d["signing-public-key"] },
    });
    render();
  });
  const githubSecret = document.querySelector(
    '#github-app [name="webhook_secret"]',
  );
  githubSecret.minLength = 16;
  githubSecret.maxLength = 1000;
  githubSecret.autocomplete = "new-password";
  bindForm("#github-app", async (d) => {
    await api("/integrations/github", { method: "PUT", body: d });
    notice(i18nText("GitHub App 连接已保存"));
    render();
  });
  document.querySelectorAll("[data-key]").forEach(
    (b) =>
      (b.onclick = async () => {
        try {
          await api("/" + b.dataset.key, { method: "DELETE" });
          render();
        } catch (e) {
          notice(e.message);
        }
      }),
  );
  document
    .querySelector("#disconnect-github")
    ?.addEventListener("click", async () => {
      try {
        await api("/integrations/github", { method: "DELETE" });
        render();
      } catch (e) {
        notice(e.message);
      }
    });
}
export async function forgePage(r, base, ap, h) {
  const { api, repoLayout, esc, field, textarea, bindForm, notice, go } = h;
  const ephemeral =
      new URLSearchParams(location.search).get("ephemeral") === "true",
    suffix = "?ephemeral=" + ephemeral;
  const [branches, tags] = await Promise.all([
    api(ap + "/branches" + suffix),
    api(ap + "/tags" + suffix),
  ]);
  if (!h.current()) return;
  const write = ["owner", "maintainer", "developer"].includes(r.role);
  const check = (name, label, checked = false) =>
    `<label class="check"><input type="checkbox" name="${name}" ${checked ? "checked" : ""}> ${label}</label>`;
  repoLayout(
    r,
    "forge",
    i18nHTML`<div class="panel"><div class="panelhead"><strong>${ephemeral ? i18nText("临时命名空间") : i18nText("主命名空间")}</strong><a class="btn small" data-link href="${esc(base + "/forge?ephemeral=" + !ephemeral)}">切换到${ephemeral ? i18nText("主") : i18nText("临时")}命名空间</a></div><div class="form"><code>${esc(r.clone_url.replace(".git", ephemeral ? "+ephemeral.git" : ".git"))}</code><p class="muted">${ephemeral ? i18nText("临时引用与主分支隔离；合并时选择临时来源即可保留成果。") : i18nText("Git push、API 编辑和合并使用统一的引用策略。")}</p></div></div><div class="forge-grid"><section class="panel"><div class="panelhead"><strong>分支 · ${branches.branches.length}</strong></div>${branches.branches.map((b) => `<div class="token-row"><div><strong>${esc(b.name)}</strong><p><code>${esc(b.sha.slice(0, 12))}</code></p></div>${write ? i18nHTML`<button class="btn small danger" data-branch="${esc(b.name)}" data-sha="${esc(b.sha)}">删除</button>` : ""}</div>`).join("")}${write ? i18nHTML`<form id="create-branch" class="form">${field(i18nText("新分支"), "target_branch")}${field(i18nText("起点分支、标签或 SHA"), "base_ref", "text", r.default_branch)}${check("base_is_ephemeral", i18nText("起点来自临时命名空间"), ephemeral)}<button class="btn primary" type="submit">创建分支</button></form>` : ""}</section><section class="panel"><div class="panelhead"><strong>标签 · ${tags.tags.length}</strong></div>${tags.tags.map((t) => `<div class="token-row"><strong>${esc(t.name)}</strong><code>${esc(t.sha.slice(0, 12))}</code>${write ? i18nHTML`<button class="btn small danger" data-tag="${esc(t.name)}">删除</button>` : ""}</div>`).join("")}${write ? i18nHTML`<form id="create-tag" class="form">${field(i18nText("标签名"), "tag-name")}${field(i18nText("起点"), "tag-ref", "text", r.default_branch)}<button class="btn primary" type="submit">创建标签</button></form>` : ""}</section></div><section class="panel"><form id="merge-preview" class="form"><h2>合并预览</h2><div class="forge-grid">${field(i18nText("来源分支 / SHA"), "source_ref")}${field(i18nText("目标分支"), "target_branch", "text", r.default_branch)}</div>${check("source_is_ephemeral", i18nText("来源为临时分支"), ephemeral)}${check("target_is_ephemeral", i18nText("目标为临时分支"))}<div class="field"><label>策略</label><select name="strategy"><option value="ff_prefer">优先快进，否则三方合并</option><option value="ff_only">仅快进</option><option value="merge">创建合并提交</option></select></div>${check("squash", i18nText("压缩为单个提交"))}<button class="btn" type="submit">预览变化</button><div id="merge-result"></div></form></section><div class="forge-grid"><section class="panel"><form class="form" id="note"><h2>Git Notes</h2>${field(i18nText("提交 SHA"), "sha")}${field(i18nText("Notes 引用"), "notes_ref", "text", "refs/notes/commits")}${textarea(i18nText("附注"), "note")}<div class="field"><label>操作</label><select name="operation"><option value="read">读取</option>${write ? i18nText('<option value="create">创建</option><option value="append">追加</option><option value="delete">删除</option>') : ""}</select></div><button class="btn" type="submit">执行</button><pre id="note-result" class="forge-output"></pre></form></section><section class="panel"><form id="download" class="form"><h2>文件与归档</h2>${field(i18nText("版本"), "ref", "text", r.default_branch)}<div class="field"><label>文件路径（留空下载归档）</label><input name="path"></div><button class="btn" type="submit">下载</button></form><form id="blame" class="form"><h2>逐行历史</h2>${field(i18nText("文件路径"), "path")}${field(i18nText("版本"), "ref", "text", r.default_branch)}<div class="field"><label>行范围（可选，例如 10,+5）</label><input name="range"></div><button class="btn" type="submit">查看 Blame</button><pre class="forge-output" id="blame-result"></pre></form></section></div>`,
  );
  const refresh = () => go(base + "/forge?ephemeral=" + ephemeral);
  if (write) {
    bindForm("#create-branch", async (d) => {
      await api(ap + "/branches/create", {
        method: "POST",
        body: { ...d, base_is_ephemeral: !!d.base_is_ephemeral, ephemeral },
      });
      refresh();
    });
    bindForm("#create-tag", async (d) => {
      await api(ap + "/tags", {
        method: "POST",
        body: { name: d["tag-name"], ref: d["tag-ref"], ephemeral },
      });
      refresh();
    });
    for (const b of document.querySelectorAll("[data-branch]"))
      b.onclick = async () => {
        try {
          if (!confirm(i18nText("删除分支 ") + b.dataset.branch + "？")) return;
          await api(ap + "/branches", {
            method: "DELETE",
            body: {
              branch: b.dataset.branch,
              expected_sha: b.dataset.sha,
              ephemeral,
            },
          });
          refresh();
        } catch (e) {
          notice(e.message);
        }
      };
    for (const b of document.querySelectorAll("[data-tag]"))
      b.onclick = async () => {
        try {
          await api(
            ap + "/tags/" + encodeURIComponent(b.dataset.tag) + suffix,
            { method: "DELETE" },
          );
          refresh();
        } catch (e) {
          notice(e.message);
        }
      };
  }
  bindForm("#merge-preview", async (d) => {
    const options = {
      source_ref: d.source_ref,
      target_branch: d.target_branch,
      source_is_ephemeral: !!d.source_is_ephemeral,
      target_is_ephemeral: !!d.target_is_ephemeral,
      include_content: true,
    };
    const preview = await api(
      ap + "/merge/preview?" + new URLSearchParams(options),
    );
    document.querySelector("#merge-result").innerHTML =
      i18nHTML`<div class="token-display"><strong>${preview.status === "clean" ? i18nText("可以合并") : i18nText("存在冲突")} · ${esc(preview.result)}</strong><p>目标：<code>${esc(preview.target_tip_sha)}</code></p>${preview.conflict_paths.length ? `<pre>${esc(preview.conflict_paths.join("\n"))}</pre>` : ""}${write && preview.status === "clean" ? i18nText('<button class="btn primary" type="button" id="apply-merge">合并此版本</button>') : ""}</div>`;
    document
      .querySelector("#apply-merge")
      ?.addEventListener("click", async (e) => {
        e.currentTarget.disabled = true;
        try {
          await api(ap + "/merge", {
            method: "POST",
            body: {
              ...options,
              source_ref: preview.source_tip_sha,
              expected_target_sha: preview.target_tip_sha,
              strategy: d.strategy,
              squash: !!d.squash,
              commit_message:
                "Merge " + d.source_ref + " into " + d.target_branch,
            },
          });
          notice(i18nText("合并完成"));
          refresh();
        } catch (error) {
          notice(error.message);
        }
      });
  });
  bindForm("#note", async (d) => {
    let result;
    if (d.operation === "read")
      result = await api(
        ap +
          "/notes?" +
          new URLSearchParams({
            sha: d.sha,
            notes_ref: d.notes_ref,
            ephemeral,
          }),
      );
    else
      result = await api(ap + "/notes", {
        method: d.operation === "delete" ? "DELETE" : "POST",
        body: {
          ...d,
          operation: d.operation === "delete" ? undefined : d.operation,
          ephemeral,
        },
      });
    document.querySelector("#note-result").textContent =
      result.note ?? JSON.stringify(result, null, 2);
  });
  bindForm("#download", async (d) => {
    const response = await fetch(
      "/api" +
        ap +
        (d.path
          ? "/file?" + new URLSearchParams({ ...d, ephemeral })
          : "/archive?ephemeral=" + ephemeral),
      d.path
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ref: d.ref }),
          },
    );
    if (!response.ok) throw Error((await response.json()).error);
    const url = URL.createObjectURL(await response.blob()),
      a = document.createElement("a");
    a.href = url;
    a.download = d.path?.split("/").at(-1) || r.name + ".tar.gz";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  });
  bindForm("#blame", async (d) => {
    const result = await api(
      ap + "/blame?" + new URLSearchParams({ ...d, ephemeral }),
    );
    document.querySelector("#blame-result").textContent = result.lines
      .map((l) => `${l.line}  ${l.sha.slice(0, 8)}  ${l.author}  ${l.content}`)
      .join("\n");
  });
}
export async function upstreamPage(r, base, ap, h) {
  const { api, repoLayout, field, esc, bindForm, notice, go, render } = h;
  const status = await api(ap + "/sync-status");
  if (!h.current()) return;
  const upstream = status.upstream || {};
  repoLayout(
    r,
    "upstream",
    i18nHTML`<div class="forge-grid"><section class="panel"><form id="upstream-config" class="form"><h2>连接上游</h2><p class="muted">双向同步时，普通分支写入先由上游确认。公开仓库导入需手动拉取，临时分支留在 OneStorage。</p><div class="field"><label>提供方</label><select name="provider">${["github", "gitlab", "bitbucket", "gitea", "forgejo", "codeberg", "sourcehut"].map((p) => `<option ${upstream.provider === p ? "selected" : ""}>${p}</option>`).join("")}</select></div>${field(i18nText("上游所有者 / 组"), "owner", "text", upstream.owner || "")}${field(i18nText("上游仓库"), "name", "text", upstream.name || "")}<div class="field"><label>自托管域名（可选，须已获管理员允许）</label><input name="upstream_host" value="${esc(upstream.upstream_host || "")}"></div><div class="field"><label>GitHub 模式</label><select name="mode"><option value="public" ${upstream.mode === "public" ? "selected" : ""}>公开仓库导入</option><option value="app" ${upstream.mode === "app" ? "selected" : ""}>GitHub App 双向同步</option></select></div><button type="submit" class="btn primary">保存上游</button></form></section><section class="panel"><div class="form"><h2>同步状态</h2><span class="pill">${esc(status.status)}</span><p>${esc(status.error || "")}</p><p class="muted">最近成功：${esc(status.synced_at || i18nText("尚未同步"))}</p><button class="btn primary" id="pull-upstream" ${upstream.provider ? "" : "disabled"}>拉取上游</button><button class="btn" id="refresh-sync">刷新</button></div>${status.jobs.map((j) => i18nHTML`<div class="token-row"><code>${esc(j.id.slice(0, 8))}</code><span>${esc(j.status)}</span><span class="muted">${j.attempts} 次尝试</span></div>`).join("")}<form id="git-credential" class="form"><h3>HTTPS 上游凭据</h3><p class="muted">用于 GitLab、Gitea 等。GitHub App 在「密钥与连接」中配置。</p>${field(i18nText("用户名"), "username", "text", "oauth2")}${field(i18nText("密码 / Token"), "password", "password")}<button class="btn" type="submit">保存凭据</button></form></section></div><section class="panel"><form class="form" id="fork"><h2>创建独立 Fork</h2>${field(i18nText("新仓库名称"), "name", "text", r.name + "-fork")}${field(i18nText("起点分支 / SHA"), "ref", "text", r.default_branch)}<button class="btn" type="submit">创建副本</button></form><form class="form" id="delete-repo"><h2>删除仓库</h2><p class="muted">引用、Git 数据、LFS 和协作记录将被清理。输入项目名称确认。</p>${field(i18nText("仓库名称"), "confirmation")}<button class="btn danger" type="submit">删除仓库</button></form></section>`,
  );
  bindForm("#upstream-config", async (d) => {
    if (!d.upstream_host) delete d.upstream_host;
    await api(ap + "/upstream", { method: "PUT", body: d });
    notice(i18nText("上游已配置，点击拉取开始同步"));
    render();
  });
  const upstreamPassword = document.querySelector(
    '#git-credential [name="password"]',
  );
  upstreamPassword.minLength = 1;
  upstreamPassword.maxLength = 10000;
  upstreamPassword.autocomplete = "new-password";
  bindForm("#git-credential", async (d) => {
    const current = await api(ap + "/git-credentials");
    await api(ap + "/git-credentials", {
      method: current.credentials.length ? "PUT" : "POST",
      body: d,
    });
    notice(i18nText("凭据已加密保存"));
  });
  document.querySelector("#pull-upstream").onclick = async () => {
    try {
      await api(ap + "/pull-upstream", { method: "POST", body: {} });
      notice(i18nText("已加入同步队列"));
      render();
    } catch (e) {
      notice(e.message);
    }
  };
  document.querySelector("#refresh-sync").onclick = render;
  bindForm("#fork", async (d) => {
    const created = await api("/repos", {
      method: "POST",
      body: { name: d.name, base_repo: { id: r.id, ref: d.ref } },
    });
    go("/" + created.namespace + "/" + encodeURIComponent(created.name));
  });
  bindForm("#delete-repo", async (d) => {
    if (d.confirmation !== r.name) throw Error(i18nText("仓库名称不匹配"));
    await api(ap, { method: "DELETE" });
    go("/");
  });
}
