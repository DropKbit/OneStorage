import { identityPanel, bindIdentity } from "./oidc.js?v=d111df485dceede5";
let hasPassword = true;
const passwordInput = () =>
  hasPassword
    ? '<div class="field"><label>当前密码<input name="password" type="password" required minlength="12" maxlength="128" autocomplete="current-password"></label></div>'
    : '<input type="hidden" name="password" value=""><p class="hint">使用最近五分钟内的统一登录验证。</p>';
const otpInput = (label = "验证码或恢复码") =>
  `<div class="field"><label>${label}<input name="otp" maxlength="64" autocomplete="one-time-code" required></label></div>`;
function bindActions(h, fn) {
  document.querySelectorAll("[data-session]").forEach(
    (b) =>
      (b.onclick = async () => {
        b.disabled = true;
        try {
          await fn(b.dataset.session);
        } catch (e) {
          h.notice(e.message);
        } finally {
          b.disabled = false;
        }
      }),
  );
}
export async function securityPage(h) {
  const { api, layout, esc, field, bindForm, render } = h,
    [security, { sessions }, identities, recovery] = await Promise.all([
      api("/account/security"),
      api("/account/sessions"),
      api("/account/identities"),
      api("/account/password-recovery"),
    ]);
  if (!h.current()) return;
  hasPassword = identities.has_password;
  layout(
    `<div class="titlebar"><div><h1>账户安全</h1><p>保护登录凭据，查看和撤销浏览器会话。</p></div><span class="pill">${security.enabled ? "双重验证已启用" : "尚未启用双重验证"}</span></div><section class="panel"><div class="form"><h2>身份验证器</h2><p>支持使用六位 TOTP 验证码的身份验证器。Git HTTPS 和 API 继续使用访问令牌。</p>${security.enabled ? `<p>剩余 ${security.recovery_codes_remaining} 个一次性恢复码。</p><form id="rotate-recovery">${passwordInput()}${otpInput()}<button class="btn" type="submit">重新生成恢复码</button></form><details><summary>关闭双重验证</summary><form id="disable-mfa">${passwordInput()}${otpInput()}<button type="submit" class="btn danger">关闭双重验证</button></form></details>` : `<form id="setup-mfa">${passwordInput()}<button class="btn primary" type="submit">设置身份验证器</button></form>`}<div id="enrollment"></div><div id="recovery-result" role="status"></div></div></section><section class="panel"><div class="panelhead"><h2>浏览器会话</h2></div>${sessions.map((s) => `<div class="token-row"><div><strong>${s.current ? "当前会话" : "其他会话"}</strong><p>${esc(s.created_at)} · 到期 ${new Date(s.expires_at).toLocaleString()}</p></div><button class="btn small" type="button" data-session="${s.id}">${s.current ? "退出当前会话" : "撤销"}</button></div>`).join("")}</section>`,
    "账户安全",
    "account",
  );
  document
    .querySelector(".content")
    .insertAdjacentHTML("beforeend", identityPanel(h, identities));
  bindIdentity(h);
  document
    .querySelector(".content")
    .insertAdjacentHTML(
      "beforeend",
      passwordRecoveryPanel(h, recovery, security.enabled),
    );
  bindPasswordRecovery(h, recovery);
  const showRecovery = (codes) => {
    document.querySelector("#recovery-result").innerHTML =
      `<h3>请保存恢复码</h3><p>每个恢复码只能使用一次，页面关闭后不再显示。保存到离线或安全位置。</p><pre>${esc(codes.join("\n"))}</pre><button type="button" id="finish-security" class="btn primary">我已保存</button>`;
    document.querySelector("#finish-security").onclick = render;
  };
  bindForm("#setup-mfa", async (b) => {
    const setup = await api("/account/mfa/setup", { method: "POST", body: b });
    if (!h.current()) return;
    document.querySelector("#setup-mfa").reset();
    const { authenticatorQR } = await h.qr();
    if (!h.current()) return;
    document.querySelector("#enrollment").innerHTML =
      `<h3>扫描二维码或手动输入密钥</h3><img class="authenticator-qr" alt="身份验证器设置二维码" src="${authenticatorQR(setup.uri)}"><pre>${esc(setup.secret)}</pre><p>密钥仅在本次设置中显示，设置在十分钟后过期。输入验证器显示的验证码完成启用。</p><form id="enable-mfa">${otpInput("六位验证码")}<button type="submit" class="btn primary">启用双重验证</button></form>`;
    bindForm("#enable-mfa", async (b) => {
      const result = await api("/account/mfa/enable", {
        method: "POST",
        body: { otp: b.otp, version: setup.version },
      });
      if (!h.current()) return;
      document.querySelector("#enrollment").replaceChildren();
      document.querySelector("#setup-mfa").remove();
      showRecovery(result.recovery_codes);
    });
  });
  bindForm("#rotate-recovery", async (b) => {
    const r = await api("/account/mfa/recovery", { method: "POST", body: b });
    if (h.current()) {
      document.querySelector("#rotate-recovery").reset();
      showRecovery(r.recovery_codes);
    }
  });
  bindForm("#disable-mfa", async (b) => {
    await api("/account/mfa/disable", { method: "POST", body: b });
    render();
  });
  bindActions(h, async (id) => {
    await api("/account/sessions/" + id, { method: "DELETE" });
    if (sessions.find((x) => x.id === id).current) location.assign("/login");
    else render();
  });
}
function passwordRecoveryPanel(h, recovery, mfa) {
  const labels = {
    "account.password_recovery.issue": "生成或轮换密码恢复密钥",
    "account.password_recovery.revoke": "撤销密码恢复密钥",
    "account.password_recovery.use": "使用密钥重设密码并撤销旧凭据",
  };
  const factor = mfa ? otpInput() : "";
  return `<section class="panel"><div class="form"><h2>忘记密码时恢复账户</h2><p>预先生成并离线保存一次性密码恢复密钥。启用双重验证后，找回密码仍需验证码或 MFA 恢复码。请将它们与密码分开保管。</p><p id="password-key-status">${recovery.enabled ? `密钥已启用，到期时间：${h.esc(new Date(recovery.expires_at).toLocaleString())}。` : recovery.version ? "密钥已过期，请重新生成。" : "尚未保存有效的密码恢复密钥。"}</p><p class="hint">密钥有效期一年；修改密码、启停双重验证或停用账户会使它失效。密钥找回会撤销所有浏览器会话、个人访问令牌和 JWT 委托密钥。</p>${recovery.has_password ? `<form id="issue-password-recovery">${passwordInput()}${factor}<button type="submit" class="btn primary">${recovery.version ? "替换密码恢复密钥" : "生成密码恢复密钥"}</button></form>${recovery.version ? `<details><summary>撤销密码恢复密钥</summary><form id="revoke-password-recovery">${passwordInput()}${factor}<button type="submit" class="btn danger">撤销密钥</button></form></details>` : ""}` : "<p>当前使用统一登录。请先在“修改密码”中设置本地密码，再启用密码找回。</p>"}<div id="password-recovery-result" role="status"></div>${recovery.history.length ? `<details><summary>近期密码恢复操作</summary>${recovery.history.map((e) => `<p>${h.esc(labels[e.action] || e.action)} · ${h.esc(e.created_at)} UTC</p>`).join("")}</details>` : ""}</div></section>`;
}
function bindPasswordRecovery(h, recovery) {
  h.bindForm("#issue-password-recovery", async (b) => {
    const issued = await h.api("/account/password-recovery", {
      method: "PUT",
      body: { ...b, version: recovery.version },
    });
    if (!h.current()) return;
    document.querySelector("#password-key-status").textContent =
      "新的密码恢复密钥已启用，请立即安全保存。";
    document.querySelector("#issue-password-recovery").remove();
    document
      .querySelector("#revoke-password-recovery")
      ?.closest("details")
      .remove();
    document.querySelector("#password-recovery-result").innerHTML =
      `<h3>现在保存密码恢复密钥</h3><p>离开页面后无法再次查看。旧密钥已失效。</p><pre class="recovery-key">${h.esc(issued.key)}</pre><p>到期：${h.esc(new Date(issued.expires_at).toLocaleString())}</p><button type="button" class="btn" id="download-password-key">下载恢复密钥</button> <button type="button" class="btn primary" id="saved-password-key">我已安全保存</button>`;
    document.querySelector("#saved-password-key").onclick = h.render;
    document.querySelector("#download-password-key").onclick = () => {
      const content = `OneStorage 密码恢复密钥\n站点：${location.origin}\n用户：${h.user.username}\n到期：${new Date(issued.expires_at).toISOString()}\n\n${issued.key}\n\n在 ${location.origin}/login/recover 使用。启用 MFA 时仍需第二因子。请离线保存。\n`;
      const url = URL.createObjectURL(
          new Blob([content], { type: "text/plain;charset=utf-8" }),
        ),
        a = document.createElement("a");
      a.href = url;
      a.download = "onestorage-password-recovery.txt";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
  });
  h.bindForm("#revoke-password-recovery", async (b) => {
    await h.api("/account/password-recovery", {
      method: "DELETE",
      body: { ...b, version: recovery.version },
    });
    if (h.current()) h.render();
  });
}
export function recoverPasswordPage(h) {
  h.layout(
    `<div class="titlebar"><h1>找回密码</h1></div><section class="panel form"><p>输入此前保存在安全位置的一次性密码恢复密钥。已启用双重验证的账户，还需提供验证码或 MFA 恢复码。</p><form id="recover-password"><div class="field"><label>用户名<input name="username" required maxlength="48" autocomplete="username"></label></div><div class="field"><label>密码恢复密钥<input name="key" type="password" required maxlength="100" autocomplete="off" spellcheck="false" placeholder="osr_…"></label></div><div class="field"><label>新密码<input name="new_password" type="password" required minlength="12" maxlength="128" autocomplete="new-password"></label></div><div class="field"><label>确认新密码<input name="confirm_password" type="password" required minlength="12" maxlength="128" autocomplete="new-password"></label></div><div class="field"><label>双重验证（已启用时填写）<input name="otp" maxlength="64" autocomplete="one-time-code" placeholder="验证码或 MFA 恢复码"></label></div><p class="hint">完成后旧会话、个人令牌和 JWT 委托密钥全部撤销。项目和双重验证保留。</p><button type="submit" class="btn primary">重设密码</button></form><div id="password-reset-result" role="status"></div><p><a data-link href="/login">返回登录</a></p><details><summary>没有保存恢复密钥？</summary><p>可使用已关联的统一登录进入账户后修改密码，或联系部署管理员核验身份。MFA 恢复码仅替代第二因子，不能单独重设密码。</p></details></section>`,
    "找回密码",
  );
  h.bindForm("#recover-password", async (b) => {
    if (b.new_password !== b.confirm_password)
      throw Error("两次输入的新密码不一致");
    const { confirm_password, ...body } = b;
    await h.api("/recover-password", { method: "POST", body });
    if (!h.current()) return;
    document.querySelector("#recover-password").remove();
    document.querySelector("#password-reset-result").innerHTML =
      '<h2>密码已重设</h2><p>请使用新密码重新登录，并生成新的密码恢复密钥。</p><a class="btn primary" href="/login">前往登录</a>';
  });
}
export async function profileSettings(h) {
  const { api, layout, esc, textarea, bindForm, render } = h,
    p = await api("/profile");
  if (!h.current()) return;
  const optional = (label, name) =>
    `<div class="field"><label>${label}<input name="${name}" value="${esc(p[name] || "")}"></label></div>`;
  layout(
    `<div class="titlebar"><h1>个人资料</h1><a class="btn" data-link href="/profile?user=${esc(p.username)}">查看资料页</a></div><form class="panel form" id="profile-form"><p>以下信息会出现在公开资料页。用户名用于 Git 地址，保持不变。</p>${optional("显示名称", "display_name")}${textarea("简介（支持 Markdown）", "bio", p.bio || "")}${optional("所在地", "location")}${optional("个人网站", "website")}<button class="btn primary" type="submit">保存资料</button></form>`,
    "个人资料",
    "profile",
  );
  bindForm("#profile-form", async (b) => {
    await api("/profile", { method: "PUT", body: b });
    h.notice("资料已保存");
    render();
  });
}
export async function profilePage(h, name) {
  const { api, layout, esc } = h,
    q = new URLSearchParams(location.search),
    d = await api(
      "/profiles/" +
        encodeURIComponent(name) +
        (q.get("before")
          ? "?before=" + encodeURIComponent(q.get("before"))
          : ""),
    );
  if (!h.current()) return;
  const p = d.profile;
  layout(
    `<div class="titlebar"><div><h1>${esc(p.display_name || p.username)}</h1><p>@${esc(p.username)} ${esc(p.location || "")}</p>${p.website ? `<a href="${esc(p.website)}" target="_blank" rel="noopener noreferrer">${esc(p.website)}</a>` : ""}</div></div><div class="panel detail-body markdown" data-markdown>${esc(p.bio || "尚未填写简介。")}</div><section class="panel"><div class="panelhead"><h2>项目</h2></div>${d.repositories.map((r) => `<div class="repo-row"><a data-link href="/${esc(r.namespace)}/${encodeURIComponent(r.name)}">${esc(r.name)}</a><p>${esc(r.description)}</p><span>${esc(r.visibility)}</span></div>`).join("") || '<div class="empty">暂无可见项目</div>'}</section><section class="panel"><div class="panelhead"><h2>活动</h2></div>${d.activity.map((a) => `<div class="token-row"><div><a data-link href="/${esc(a.namespace)}/${encodeURIComponent(a.name)}">${esc(a.namespace)}/${esc(a.name)}</a><p>${esc(a.action)} · ${esc(a.detail)}</p></div><span>${esc(a.created_at)}</span></div>`).join("") || '<div class="empty">暂无可见活动</div>'}${d.next ? `<a data-link class="btn" href="/profile?user=${esc(name)}&before=${d.next}">更早的活动</a>` : ""}</section>`,
    "个人资料",
  );
  h.markdown().catch(() => {});
}
