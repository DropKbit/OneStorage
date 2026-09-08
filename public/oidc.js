import {
  text as i18nText,
  html as i18nHTML,
  getLocale,
} from "./i18n.js?v=b03346d448c25b98";
export async function completeLogin(h) {
  const { api, layout, esc, bindForm } = h;
  const pending = await api("/auth/oidc/pending");
  if (!h.current()) return;
  layout(
    i18nHTML`<section class="panel"><form class="form" id="oidc-complete"><h1>${pending.stage === "mfa" ? i18nText("验证你的身份") : i18nText("完成账户创建")}</h1><p>已通过 ${esc(pending.provider)} 验证。</p>${pending.stage === "mfa" ? i18nText('<label>验证码或恢复码<input name="otp" autocomplete="one-time-code" maxlength="64" required></label>') : i18nText('<label>OneStorage 用户名<input name="username" pattern="[a-z0-9][a-z0-9_-]{0,47}" maxlength="48" required></label><p class="hint">新账户使用统一登录，稍后可在账户安全中设置本地密码。已有账户请先用原方式登录，再关联身份。</p>')}<button type="submit" class="btn primary">继续</button><a data-link href="/login">重新登录</a></form></section>`,
    i18nText("统一登录"),
    "",
  );
  bindForm("#oidc-complete", async (b) => {
    await api("/auth/oidc/complete", { method: "POST", body: b });
    location.assign("/");
  });
}
export function identityPanel(h, data) {
  const { esc } = h;
  const proof = data.has_password
    ? i18nText(
        '<label>当前密码<input name="password" type="password" autocomplete="current-password" required maxlength="128"></label>',
      )
    : i18nText(
        '<p class="hint">敏感操作需要最近五分钟内完成统一登录验证。超过时限请使用下面的「重新验证」。</p><input type="hidden" name="password" value="">',
      );
  const otp = i18nText(
    '<label>验证码或恢复码（已启用双因素时）<input name="otp" autocomplete="one-time-code" maxlength="64"></label>',
  );
  return i18nHTML`<section class="panel"><div class="form"><h2>统一登录</h2>${data.identities.map((i) => i18nHTML`<div class="token-row"><span>${esc(i.name)} · ${i.enabled ? i18nText("可用") : i18nText("已停用")}</span><div class="actionbar">${i.enabled ? i18nHTML`<button class="btn" type="button" data-oidc-reauth="${i.provider_id}">重新验证</button>` : ""}<button class="btn danger" type="button" data-oidc-unlink="${i.id}">解除关联</button></div></div>`).join("") || i18nText('<p class="muted">尚未关联身份。</p>')}${proof}${otp}<div class="actionbar">${data.providers
    .filter((p) => !data.identities.some((i) => i.provider_id === p.id))
    .map(
      (p) =>
        i18nHTML`<button class="btn" type="button" data-oidc-link="${p.id}">关联 ${esc(p.name)}</button>`,
    )
    .join(
      "",
    )}</div><p class="hint">关联会验证当前账户和外部身份，不会按邮箱自动合并。解除关联会撤销相应会话和访问令牌；必须保留一种可用登录方式。</p></div></section><section class="panel"><form class="form" id="oidc-password"><h2>${data.has_password ? i18nText("修改本地密码") : i18nText("设置本地密码")}</h2>${proof}${otp}<label>新密码<input name="new_password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label><button class="btn" type="submit">保存并退出全部会话</button></form></section>`;
}
export function bindIdentity(h) {
  const { api, bindForm, notice } = h;
  document
    .querySelectorAll("[data-oidc-link],[data-oidc-unlink],[data-oidc-reauth]")
    .forEach(
      (b) =>
        (b.onclick = async () => {
          b.disabled = true;
          try {
            const form = b.closest(".form"),
              proof = {
                password: form.querySelector("[name=password]")?.value || "",
                otp: form.querySelector("[name=otp]")?.value || "",
              };
            if (b.dataset.oidcUnlink) {
              await api(
                "/account/identities/" + b.dataset.oidcUnlink + "/unlink",
                { method: "POST", body: proof },
              );
              location.assign("/settings/account");
            } else {
              const id = b.dataset.oidcLink || b.dataset.oidcReauth;
              const result = await api("/auth/oidc/" + id + "/start", {
                method: "POST",
                body: {
                  ...proof,
                  mode: b.dataset.oidcLink ? "link" : "reauth",
                },
              });
              location.assign(result.url);
            }
          } catch (e) {
            notice(e.message);
          } finally {
            b.disabled = false;
          }
        }),
    );
  bindForm("#oidc-password", async (b) => {
    await api("/password", {
      method: "POST",
      body: {
        current_password: b.password || "",
        new_password: b.new_password,
        otp: b.otp || "",
      },
    });
    location.assign("/login");
  });
}
export async function providerAdmin(h) {
  const { api, layout, esc, bindForm, render } = h;
  const data = await api("/admin/identity-providers");
  if (!h.current()) return;
  layout(
    i18nHTML`<div class="titlebar"><div><h1>统一登录管理</h1><p>配置可信 OIDC、GitHub 或 GitLab 提供方。配置变更会撤销该提供方的会话、派生令牌和待完成登录。</p></div><a data-link class="btn" href="/admin/users">返回用户管理</a></div><section class="panel"><div class="detail-body"><p>回调地址：<code>${esc(data.callback)}</code></p>${data.providers.map((p) => i18nHTML`<div class="token-row"><div><strong>${esc(p.name)}</strong><p>${esc(p.protocol || "oidc")} · ${esc(p.issuer)} · ${p.enabled ? i18nText("已启用") : i18nText("已停用")} · 注册${p.registration ? i18nText("开放") : i18nText("关闭")}</p></div><div class="actionbar"><button class="btn" data-provider-edit="${p.id}">编辑</button><button class="btn danger" data-provider-delete="${p.id}">删除</button></div></div>`).join("") || i18nText("<p>尚未配置提供方。</p>")}</div></section><section class="panel"><form class="form" id="oidc-provider"><h2 id="provider-title">添加提供方</h2><input type="hidden" name="id"><input type="hidden" name="revision"><label>显示名称<input name="name" maxlength="80" required></label><label>登录协议<select name="protocol"><option value="oidc">OpenID Connect</option><option value="github">GitHub OAuth</option><option value="gitlab">GitLab OAuth</option></select></label><label>Issuer / Git 服务地址<input name="issuer" type="url" required placeholder="https://accounts.google.com"></label><label>Client ID<input name="client_id" maxlength="512" required></label><label>客户端认证<select name="auth_method"><option value="client_secret_basic">client_secret_basic</option><option value="client_secret_post">client_secret_post</option><option value="none">Public client / PKCE</option></select></label><label>Client secret<input name="client_secret" type="password" maxlength="4096" autocomplete="new-password" placeholder="仅写入；编辑时留空保留"></label><label>允许的提供方主机（逗号分隔）<input name="allowed_hosts" required placeholder="accounts.google.com,oauth2.googleapis.com,www.googleapis.com"></label><label>允许的已验证邮箱域名（可选，逗号分隔）<input name="email_domains"></label><label class="check"><input type="checkbox" name="enabled">启用登录</label><label class="check"><input type="checkbox" name="registration">允许创建普通用户</label><p class="hint">只允许信任的 HTTPS 主机，不跟随重定向。协议、Issuer 和 Client ID 创建后固定。GitHub 仅支持 github.com；GitLab 支持可信 HTTPS 自托管服务。OAuth 使用 PKCE，GitHub 邮箱限制检查已验证邮箱，GitLab 检查已确认账户的主邮箱。新用户不会自动获得管理员或空间权限；关闭注册后仍可关联已有账户。</p><div class="actionbar"><button class="btn primary" type="submit">保存提供方</button><button class="btn" type="reset">新建</button></div></form></section>`,
    i18nText("统一登录"),
    "admin",
  );
  const form = document.querySelector("#oidc-provider");
  form.elements.protocol.addEventListener("change", () => {
    const p = form.elements.protocol.value;
    form.elements.auth_method.value =
      p === "oidc" ? "client_secret_basic" : "client_secret_post";
    if (p === "github") {
      form.elements.issuer.value = "https://github.com";
      form.elements.allowed_hosts.value = "github.com,api.github.com";
    } else if (p === "gitlab") {
      form.elements.issuer.value = "https://gitlab.com";
      form.elements.allowed_hosts.value = "gitlab.com";
    }
  });
  form.addEventListener("reset", () => {
    form.elements.protocol.disabled = false;
    form.elements.issuer.readOnly = false;
    form.elements.client_id.readOnly = false;
    document.querySelector("#provider-title").textContent =
      i18nText("添加提供方");
  });
  document.querySelectorAll("[data-provider-edit]").forEach(
    (b) =>
      (b.onclick = () => {
        const p = data.providers.find((p) => p.id === b.dataset.providerEdit);
        form.reset();
        for (const k of [
          "id",
          "name",
          "protocol",
          "issuer",
          "client_id",
          "auth_method",
          "revision",
        ])
          form.elements[k].value = p[k] || (k === "protocol" ? "oidc" : "");
        for (const k of ["allowed_hosts", "email_domains"])
          form.elements[k].value = p[k].join(",");
        for (const k of ["enabled", "registration"])
          form.elements[k].checked = p[k];
        form.elements.protocol.disabled = true;
        form.elements.issuer.readOnly = true;
        form.elements.client_id.readOnly = true;
        document.querySelector("#provider-title").textContent =
          i18nText("编辑提供方");
        form.scrollIntoView({ block: "start" });
      }),
  );
  document.querySelectorAll("[data-provider-delete]").forEach(
    (b) =>
      (b.onclick = async () => {
        try {
          await api("/admin/identity-providers/" + b.dataset.providerDelete, {
            method: "DELETE",
          });
          render();
        } catch (e) {
          h.notice(e.message);
        }
      }),
  );
  bindForm("#oidc-provider", async (b) => {
    const { id, revision, ...body } = b;
    body.protocol = form.elements.protocol.value;
    for (const k of ["allowed_hosts", "email_domains"])
      body[k] = String(body[k] || "")
        .split(",")
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean);
    for (const k of ["enabled", "registration"])
      body[k] = form.elements[k].checked;
    if (!body.client_secret) delete body.client_secret;
    if (id) body.revision = Number(revision);
    await api("/admin/identity-providers" + (id ? "/" + id : ""), {
      method: id ? "PUT" : "POST",
      body,
    });
    render();
  });
}
