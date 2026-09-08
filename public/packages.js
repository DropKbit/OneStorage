export async function packagePage(r, base, ap, h, id) {
  const { api, esc, repoLayout, current, render, go, notice } = h;
  const writable =
      !r.archived_at && ["owner", "maintainer", "developer"].includes(r.role),
    maintain = !r.archived_at && ["owner", "maintainer"].includes(r.role);
  const bytes = (n) =>
    n >= 1048576
      ? (n / 1048576).toFixed(2) + " MiB"
      : n.toLocaleString() + " B";
  const registry = `${location.origin}/api${ap}/packages/npm/`,
    authPath = registry.replace(/^https?:/, "");
  const guide = `<details class="panel"><summary>npm 发布与安装</summary><div class="detail-body"><p>npm 的 --access public 不会公开私有项目；包继承项目的${r.visibility === "public" ? "公开" : "私有"}可见性。开发者可发布、修改标签；维护者可撤回。使用个人访问令牌，发布需要写权限。</p><p>项目 .npmrc（令牌从环境变量读取）：</p><pre>${esc(`registry=${registry}\n${authPath}:_authToken=\${ONESTORAGE_TOKEN}`)}</pre><p>在终端设置 ONESTORAGE_TOKEN，然后运行：</p><pre>${esc(`npm publish --access public\nnpm install ${id ? "PACKAGE@VERSION" : "your-package@1.0.0"}\nnpm dist-tag add your-package@1.0.0 stable\nnpm unpublish your-package@1.0.0 --force`)}</pre><p class="hint">npm 包最大 16 MiB，解压后最大 64 MiB；支持普通文件和目录。名称与版本发布后不能覆盖，撤回后也不能重用。项目转移后请更新 registry 地址。通用构建 Runner 可通过 CI 变量提供令牌并执行相同命令。</p></div></details>`;
  const error = (e) => {
    if (current()) notice(e.message);
  };
  if (id) {
    const data = await api(ap + "/packages/versions/" + encodeURIComponent(id));
    if (!current()) return;
    const prefix = `/api${ap}/packages/${data.kind === "npm" ? "npm/" + encodeURIComponent(data.name) + "/-/" : "generic/" + encodeURIComponent(data.name) + "/" + encodeURIComponent(data.version) + "/"}`;
    repoLayout(
      r,
      "packages",
      `<p><a data-link href="${base}/packages">← 包仓库</a></p><section class="panel"><div class="panelhead"><strong>${esc(data.name)} · ${esc(data.version)}</strong><span class="pill">${esc(data.kind)}</span></div><div class="detail-body"><p>${esc(new Date(data.created_at).toLocaleString())}</p>${data.files.map((f) => `<div class="token-row"><div><a href="${prefix + encodeURIComponent(f.filename)}" download>${esc(f.filename)}</a> · ${bytes(f.size)}<p class="hint">SHA-256</p><pre>${esc(f.sha256)}</pre></div></div>`).join("")}${data.kind === "npm" ? `<p>安装此版本：</p><pre>${esc(`npm install ${data.name}@${data.version} --registry=${registry}`)}</pre><h3>分发标签</h3><div>${data.tags.map((t) => `<span class="pill">${esc(t.tag)}</span> ${writable ? `<button class="btn small" data-remove-tag="${esc(t.tag)}" aria-label="移除标签 ${esc(t.tag)}">移除</button>` : ""}`).join(" ") || '<p class="muted">此版本没有标签</p>'}</div>${writable ? '<form id="package-tag" class="form"><label>新增或移动标签<input name="tag" required maxlength="64" placeholder="stable" pattern="[a-zA-Z][a-zA-Z0-9._-]*" /></label><button class="btn" type="submit">指向此版本</button></form>' : ""}<details><summary>package.json</summary><pre>${esc(JSON.stringify(data.metadata, null, 2))}</pre></details>` : ""}${maintain ? '<p><button class="btn danger" id="package-delete">撤回此版本</button></p><p class="hint">撤回会停止下载并回收所有文件，同名版本不能重新发布。</p>' : ""}</div></section>${data.kind === "npm" ? guide : ""}`,
    );
    document
      .querySelector("#package-delete")
      ?.addEventListener("click", async (e) => {
        if (
          !confirm(
            `撤回 ${data.name}@${data.version} 的所有文件？此版本不能重新发布。`,
          )
        )
          return;
        e.currentTarget.disabled = true;
        try {
          await api(ap + "/packages/versions/" + id, { method: "DELETE" });
          if (current()) go(base + "/packages");
        } catch (err) {
          error(err);
          if (current())
            document.querySelector("#package-delete").disabled = false;
        }
      });
    document
      .querySelector("#package-tag")
      ?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const form = e.currentTarget,
          button = form.querySelector("button");
        button.disabled = true;
        try {
          await api(
            ap +
              "/packages/npm/-/package/" +
              encodeURIComponent(data.name) +
              "/dist-tags/" +
              encodeURIComponent(new FormData(form).get("tag")),
            { method: "PUT", body: data.version },
          );
          if (current()) await render();
        } catch (err) {
          error(err);
          if (current()) button.disabled = false;
        }
      });
    for (const button of document.querySelectorAll("[data-remove-tag]"))
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          await api(
            ap +
              "/packages/npm/-/package/" +
              encodeURIComponent(data.name) +
              "/dist-tags/" +
              encodeURIComponent(button.dataset.removeTag),
            { method: "DELETE" },
          );
          if (current()) await render();
        } catch (err) {
          error(err);
          if (current()) button.disabled = false;
        }
      });
    return;
  }
  const offset = Math.max(
      0,
      Number(new URLSearchParams(location.search).get("offset")) || 0,
    ),
    data = await api(ap + "/packages?offset=" + offset);
  if (!current()) return;
  repoLayout(
    r,
    "packages",
    `<section class="panel" aria-label="包仓库"><div class="panelhead"><strong>包仓库</strong><span>${bytes(data.used.bytes)} / ${bytes(data.limits.quota_bytes)}</span></div><div class="detail-body"><p class="muted">发布可被下载和安装的软件包，按名称及版本管理。</p>${data.versions.map((v) => `<div class="token-row"><div><a data-link href="${base}/packages/${v.id}"><strong>${esc(v.name)} · ${esc(v.version)}</strong></a> <span class="pill">${esc(v.kind)}</span><p>${v.files} 个文件 · ${bytes(v.size)} · ${esc(v.publisher)} · ${esc(new Date(v.created_at).toLocaleString())}</p></div></div>`).join("") || '<p class="empty">暂无软件包。可以上传通用文件或使用 npm publish。</p>'}<div class="inline">${offset ? `<a data-link class="btn" href="${base}/packages?offset=${Math.max(0, offset - 50)}">上一页</a>` : ""}${data.next_offset !== null ? `<a data-link class="btn" href="${base}/packages?offset=${data.next_offset}">下一页</a>` : ""}</div></div></section>${writable ? '<section class="panel"><div class="panelhead"><strong>发布通用文件包</strong></div><form id="package-upload" class="form detail-body"><label>包名称<input name="name" required maxlength="128" pattern="[a-zA-Z0-9][a-zA-Z0-9._+-]*" placeholder="my-tool" /></label><label>版本<input name="version" required maxlength="128" pattern="[a-zA-Z0-9][a-zA-Z0-9._+-]*" placeholder="1.0.0" /></label><label>文件<input name="file" type="file" required /></label><p class="hint">最大 64 MiB。文件名仅支持英文字母、数字、点、下划线、加号和连字符。同一版本可上传多个不同文件，文件不能覆盖。</p><button class="btn primary" type="submit">校验并发布</button><p id="package-upload-status" role="status"></p></form></section>' : ""}${guide}`,
  );
  document
    .querySelector("#package-upload")
    ?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.currentTarget,
        button = form.querySelector("button"),
        status = document.querySelector("#package-upload-status"),
        fields = new FormData(form),
        file = fields.get("file");
      button.disabled = true;
      try {
        if (!file?.size || file.size > data.limits.generic_bytes)
          throw Error("文件大小应为 1 B 至 64 MiB");
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,127}$/.test(file.name))
          throw Error("文件名不符合格式要求");
        status.textContent = "正在计算 SHA-256…";
        const checksum = Array.from(
          new Uint8Array(
            await crypto.subtle.digest("SHA-256", await file.arrayBuffer()),
          ),
          (b) => b.toString(16).padStart(2, "0"),
        ).join("");
        if (!current()) return;
        status.textContent = "正在上传并校验…";
        const response = await fetch(
          `/api${ap}/packages/generic/${encodeURIComponent(fields.get("name"))}/${encodeURIComponent(fields.get("version"))}/${encodeURIComponent(file.name)}`,
          {
            method: "PUT",
            headers: {
              "content-type": "application/octet-stream",
              "x-package-sha256": checksum,
            },
            body: file,
            signal: AbortSignal.timeout(100000),
          },
        );
        const result = await response.json();
        if (!response.ok) throw Error(result.error || "发布失败");
        if (current()) go(base + "/packages/" + result.version_id);
      } catch (err) {
        if (current()) status.textContent = err.message;
      } finally {
        if (current()) button.disabled = false;
      }
    });
}
