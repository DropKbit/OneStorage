export function variablePanel(root, variables, branch, h, options = {}) {
  const { esc, api, bindForm, render } = h;
  let editing = null;
  const button = (label, action, id = "") =>
    `<button type="button" class="btn small" data-action="variable-${action}" data-id="${esc(id)}">${label}</button>`;
  const metadata = (v) => ({
    key: v.key,
    environment: v.environment,
    refs: v.refs,
    secret: !!v.secret,
    protected: !!v.protected,
    enabled: !!v.enabled,
    revision: v.revision,
  });
  const inherited = options.inherited || [];
  const inheritedHTML = inherited.length
    ? `<section class="panel" aria-label="继承的空间变量"><div class="panelhead"><strong>继承的空间变量</strong></div><div class="detail-body"><p class="muted">项目定义优先于空间定义，同一层级精确环境优先于 *。暂停或失去授权的高优先级定义会阻止回退。这里只显示元数据，空间所有者可在空间管理中编辑。</p>${inherited.map((v) => `<div class="token-row" data-inherited-variable="${esc(v.key)}"><div><strong>${esc(v.key)}</strong> <span class="pill">${v.enabled && v.available ? "可继承" : "不可用"}</span><p>${esc(v.workspace)} · ${esc(v.environment)} · ${v.secret ? "密钥" : "普通变量"} · ${v.protected ? "仅受保护分支" : "允许未保护分支"}</p><p class="muted">分支：${v.refs.map(esc).join("、")} · 版本 ${v.revision}</p></div></div>`).join("")}</div></section>`
    : "";
  return {
    html: `${inheritedHTML}${options.workspace ? '<p class="hint">空间共享变量由所有者管理，供空间内项目显式选择使用。轮换或撤权会取消各项目已使用它的未完成工作流。</p>' : ""}<section class="panel" aria-label="CI 变量与密钥"><div class="panelhead"><strong>CI 变量与密钥</strong></div><div class="detail-body"><p class="muted">值加密保存，提交后不再显示。任务通过 variables 显式选择名称，environment 选择环境；项目定义优先于空间定义，同一层级精确环境优先于 *。密钥仅提供给当前分支提交的手动、推送或定时任务，MR 及其重试不可读取密钥。</p><pre>{ "variables": ["API_TOKEN"], "environment": "production" }</pre>${variables.map((v) => `<div class="token-row" data-variable="${esc(v.key)}"><div><strong>${esc(v.key)}</strong> <span class="pill">${v.enabled ? "已启用" : "已暂停"}</span><p>${esc(v.environment)} · ${v.secret ? "密钥 · 日志脱敏" : "普通变量"} · ${v.protected ? "仅受保护分支" : "允许未保护分支"}</p><p class="muted">分支：${v.refs.map(esc).join("、")} · 版本 ${v.revision}</p></div><div class="actionbar">${button("编辑", "edit", v.id)}${button(v.enabled ? "暂停" : "启用", "toggle", v.id)}${button("接管", "own", v.id)}${button("删除", "delete", v.id)}</div></div>`).join("") || '<p class="empty">暂无变量</p>'}</div><form class="form" id="variable-config"><h3 id="variable-form-title">新建变量</h3><label>变量名<input name="key" required pattern="[A-Z_][A-Z0-9_]{0,79}" placeholder="API_TOKEN"></label><label>环境<input name="environment" required value="*"></label><label>允许的分支<input name="refs" required value="${esc(branch)}"></label><p class="hint">多个分支用逗号分隔，* 表示全部分支。</p><label>值<input name="value" type="password" required maxlength="8192" autocomplete="new-password"></label><p class="hint">密钥至少 8 个字符。编辑时留空保留原值。取消日志脱敏也不会开放值的读取接口。</p><label class="check"><input type="checkbox" name="secret" checked> 密钥（日志脱敏）</label><label class="check"><input type="checkbox" name="protected" checked> 仅允许已启用合并请求保护的分支</label><label class="check"><input type="checkbox" name="enabled" checked> 启用变量</label><p class="hint">修改、暂停、接管、删除或撤销所有者权限会取消已使用该变量的未完成运行。接管后需手动启用。脱敏用于减少意外日志泄露，产物内容由构建代码决定。</p><div class="actionbar"><button class="btn primary" type="submit">保存变量</button>${button("清空编辑", "reset")}</div></form></section>`,
    bind() {
      bindForm("#variable-config", async (b) => {
        await api(root + "/variables" + (editing ? "/" + editing.id : ""), {
          method: editing ? "PUT" : "POST",
          body: {
            key: b.key,
            environment: b.environment,
            refs: b.refs
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
            ...(b.value ? { value: b.value } : {}),
            secret: b.secret === "on",
            protected: b.protected === "on",
            enabled: b.enabled === "on",
            ...(editing ? { revision: editing.revision } : {}),
          },
        });
        document.querySelector('#variable-config input[name="value"]').value =
          "";
        render();
      });
    },
    async action(a, id) {
      const v = variables.find((v) => v.id === id),
        form = document.querySelector("#variable-config");
      if (a === "variable-edit" || a === "variable-reset") {
        editing = a === "variable-edit" ? v : null;
        form.reset();
        form.elements.value.required = !editing;
        if (editing) {
          for (const key of ["key", "environment"])
            form.elements[key].value = v[key];
          form.elements.refs.value = v.refs.join(", ");
          for (const key of ["secret", "protected", "enabled"])
            form.elements[key].checked = !!v[key];
        }
        document.querySelector("#variable-form-title").textContent = editing
          ? "编辑变量"
          : "新建变量";
        form.scrollIntoView({ block: "nearest" });
        return;
      }
      if (!v) return;
      const path = root + "/variables/" + v.id;
      if (a === "variable-delete")
        await api(path, { method: "DELETE", body: { revision: v.revision } });
      if (a === "variable-own")
        await api(path + "/take-ownership", {
          method: "POST",
          body: { revision: v.revision },
        });
      if (a === "variable-toggle")
        await api(path, {
          method: "PUT",
          body: { ...metadata(v), enabled: !v.enabled },
        });
      render();
    },
  };
}
