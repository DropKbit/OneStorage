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
    [security, { sessions }, identities] = await Promise.all([
      api("/account/security"),
      api("/account/sessions"),
      api("/account/identities"),
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
