import {
  text as i18nText,
  html as i18nHTML,
  getLocale,
} from "./i18n.js?v=aca1321acd070c64";
const scopeNames = {
  read_repository: [
    i18nText("读取代码"),
    i18nText("通过 HTTPS clone/fetch 和下载 LFS；不能推送。"),
  ],
  read_package_registry: [
    i18nText("读取软件包"),
    i18nText("查看和下载此范围的软件包。"),
  ],
  write_package_registry: [
    i18nText("发布软件包"),
    i18nText("上传软件包和修改分发标签。"),
  ],
  delete_package_registry: [
    i18nText("撤回软件包"),
    i18nText("删除版本；npm unpublish 还需读取软件包权限。"),
  ],
};
export async function deployTokensPage(h, { r, base, ap, workspace }) {
  const { api, esc, current, layout, repoLayout, notice } = h;
  const endpoint = workspace
    ? `/workspaces/${encodeURIComponent(workspace)}/deploy-tokens`
    : ap + "/deploy-tokens";
  const offset = Math.max(
      0,
      Number(new URLSearchParams(location.search).get("offset")) || 0,
    ),
    [data, space] = await Promise.all([
      api(endpoint + "?offset=" + offset),
      workspace ? api("/workspaces/" + encodeURIComponent(workspace)) : null,
    ]);
  if (!current()) return;
  const pagePath = workspace
    ? `/spaces/${encodeURIComponent(workspace)}/deploy-tokens`
    : base + "/deploy-tokens";
  let tokens = data.tokens;
  const when = (n) =>
    n ? new Date(n).toLocaleString(getLocale()) : i18nText("尚未使用");
  const status = (t) =>
    t.revoked_at !== null
      ? i18nText("已撤销")
      : t.expires_at <= Date.now()
        ? i18nText("已到期")
        : i18nText("有效");
  const content = i18nHTML`<section class="panel" aria-label="部署令牌"><div class="panelhead"><strong>${workspace ? esc(space.name) + i18nText(" · 空间") : i18nText("项目")}部署令牌</strong><span>最多 ${data.limit} 个有效令牌</span></div><div class="detail-body"><p>给部署和构建工具授予指定范围的权限。令牌属于${workspace ? i18nText("当前空间，覆盖空间中的所有项目和今后创建的项目") : i18nText("当前项目")}，不会因创建者退出团队而自动失效。空间所有者或项目维护者可管理；请在交接时检查并撤销不再需要的令牌。</p><p class="muted">代码只读。发布与撤回权限独立选择。归档项目可读取、不可发布；项目跨空间转移会撤销其项目令牌，原空间令牌也不再覆盖该项目。令牌不能访问账户、成员、Issues、CI 配置或管理员 API。</p><div id="deploy-secret" role="status"></div><div id="deploy-token-rows"></div><div class="inline">${offset ? i18nHTML`<a data-link class="btn" href="${pagePath}?offset=${Math.max(0, offset - 50)}">上一页</a>` : ""}${data.next_offset !== null ? i18nHTML`<a data-link class="btn" href="${pagePath}?offset=${data.next_offset}">下一页</a>` : ""}</div></div></section><section class="panel"><form class="form" id="deploy-token-create"><h2>创建部署令牌</h2><label>名称<input name="name" required maxlength="80" placeholder="production-build" /></label><label>认证用户名（可选）<input name="username" maxlength="80" placeholder="自动生成" pattern="[a-zA-Z0-9][a-zA-Z0-9._+-]*" /></label><label>有效天数<input name="days" type="number" value="90" min="1" max="365" required /></label><fieldset><legend>权限范围</legend>${Object.entries(
    scopeNames,
  )
    .map(
      ([key, [name, hint]]) =>
        `<label class="check"><input type="checkbox" name="scopes" value="${key}" ${key === "read_repository" ? "checked" : ""} /><span>${name}<br /><span class="hint">${hint}</span></span></label>`,
    )
    .join(
      "",
    )}</fieldset><label>动态验证码或恢复码（启用 MFA 时填写）<input name="otp" autocomplete="one-time-code" maxlength="64" /></label><button class="btn primary" type="submit">创建令牌</button><p id="deploy-create-status" role="status"></p></form></section><section class="panel"><div class="detail-body"><h2>使用方式</h2><p>Git HTTPS 使用令牌的用户名和密码，建议通过 Git 凭据管理器或 GIT_ASKPASS 提供。npm 使用 Bearer 令牌，在 .npmrc 中引用环境变量。原始令牌只在创建和轮换时显示一次。</p><pre>${esc(workspace ? `git clone ${location.origin}/${workspace}/PROJECT.git` : `git clone ${location.origin}${base}.git`)}</pre><pre>${esc(`${location.origin.replace(/^https?:/, "")}/api${workspace ? "/repos/" + workspace + "/PROJECT" : ap}/packages/npm/:_authToken=\${ONESTORAGE_DEPLOY_TOKEN}`)}</pre></div></section>`;
  if (workspace)
    layout(
      `<p><a data-link href="/spaces/${encodeURIComponent(workspace)}">← ${esc(space.name)}</a></p>${content}`,
      i18nText("空间部署令牌"),
    );
  else
    repoLayout(
      r,
      "settings",
      i18nHTML`<p><a data-link href="${base}/settings">← 项目设置</a></p>${content}`,
    );
  const showSecret = (result) => {
    const box = document.querySelector("#deploy-secret");
    box.innerHTML = i18nHTML`<div class="info"><strong>请现在保存，新令牌只显示这一次。</strong><p>用户名：<code>${esc(result.username)}</code></p><label>部署令牌<input id="deploy-secret-value" readonly type="password" autocomplete="off" value="${esc(result.token)}" /></label><div class="actionbar"><button class="btn small" id="deploy-secret-show" type="button">显示</button><button class="btn small" id="deploy-secret-copy" type="button">复制令牌</button><button class="btn small" id="deploy-secret-dismiss" type="button">已保存，清除显示</button></div></div>`;
    document.querySelector("#deploy-secret-show").onclick = (e) => {
      const input = document.querySelector("#deploy-secret-value"),
        showing = input.type === "password";
      input.type = showing ? "text" : "password";
      e.currentTarget.textContent = showing
        ? i18nText("隐藏")
        : i18nText("显示");
    };
    document.querySelector("#deploy-secret-copy").onclick = async () => {
      try {
        await navigator.clipboard.writeText(
          document.querySelector("#deploy-secret-value").value,
        );
        notice(i18nText("令牌已复制"));
      } catch {
        notice(i18nText("请手动复制令牌"));
      }
    };
    document.querySelector("#deploy-secret-dismiss").onclick = () =>
      box.replaceChildren();
  };
  const redraw = () => {
    document.querySelector("#deploy-token-rows").innerHTML =
      tokens
        .map(
          (t) =>
            i18nHTML`<article class="token-row" data-deploy-token="${t.id}"><div><strong>${esc(t.name)}</strong> <span class="pill">${status(t)}</span><p><code>${esc(t.username)}</code></p><p>${t.scopes.map((s) => esc(scopeNames[s]?.[0] || s)).join(" · ")}</p><p class="hint">到期 ${esc(when(t.expires_at))} · 最近认证 ${esc(when(t.last_used_at))} · 版本 ${t.revision}</p>${t.revoked_at === null ? i18nHTML`<details><summary>轮换令牌</summary><form class="form" data-deploy-rotate="${t.id}"><p class="hint">生成新令牌并立即使旧令牌失效。轮换已到期令牌会恢复它。</p><label>新有效天数<input name="days" type="number" value="90" min="1" max="365" required /></label><label>动态验证码或恢复码<input name="otp" autocomplete="one-time-code" maxlength="64" /></label><button class="btn" type="submit">确认轮换</button></form></details><button class="btn small danger" data-deploy-revoke="${t.id}" type="button">撤销令牌</button>` : ""}</div></article>`,
        )
        .join("") || i18nText('<p class="empty">暂无部署令牌</p>');
    for (const form of document.querySelectorAll("[data-deploy-rotate]"))
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const t = tokens.find((t) => t.id === form.dataset.deployRotate),
          button = form.querySelector("button");
        if (!confirm(i18nText("轮换后旧令牌立即失效，继续轮换？"))) return;
        button.disabled = true;
        try {
          const input = new FormData(form),
            result = await api(endpoint + "/" + t.id + "/rotate", {
              method: "POST",
              body: {
                revision: t.revision,
                days: Number(input.get("days")),
                otp: input.get("otp"),
              },
            });
          if (!current()) return;
          tokens = tokens.map((x) =>
            x.id === t.id ? { ...result, token: undefined } : x,
          );
          redraw();
          showSecret(result);
        } catch (err) {
          if (current()) {
            notice(err.message);
            button.disabled = false;
          }
        }
      });
    for (const button of document.querySelectorAll("[data-deploy-revoke]"))
      button.addEventListener("click", async () => {
        const t = tokens.find((t) => t.id === button.dataset.deployRevoke);
        if (
          !confirm(
            i18nHTML`撤销部署令牌 ${t.name}？使用它的自动化将无法继续认证。`,
          )
        )
          return;
        button.disabled = true;
        try {
          const result = await api(endpoint + "/" + t.id, {
            method: "DELETE",
            body: { revision: t.revision },
          });
          if (!current()) return;
          tokens = tokens.map((x) => (x.id === t.id ? result : x));
          document.querySelector("#deploy-secret").replaceChildren();
          redraw();
        } catch (err) {
          if (current()) {
            notice(err.message);
            button.disabled = false;
          }
        }
      });
  };
  redraw();
  document
    .querySelector("#deploy-token-create")
    .addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.currentTarget,
        input = new FormData(form),
        button = form.querySelector("button"),
        status = document.querySelector("#deploy-create-status");
      button.disabled = true;
      status.textContent = "";
      try {
        const scopes = input.getAll("scopes");
        if (!scopes.length) throw Error(i18nText("至少选择一项权限"));
        const result = await api(endpoint, {
          method: "POST",
          body: {
            name: input.get("name"),
            username: input.get("username") || undefined,
            days: Number(input.get("days")),
            scopes,
            otp: input.get("otp"),
          },
        });
        if (!current()) return;
        tokens = [{ ...result, token: undefined }, ...tokens].slice(0, 50);
        redraw();
        showSecret(result);
        form.reset();
      } catch (err) {
        if (current()) status.textContent = err.message;
      } finally {
        if (current()) button.disabled = false;
      }
    });
}
