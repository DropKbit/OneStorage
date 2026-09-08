const globalSearch = () => import("./search.js?v=6a7618b7a0242477");
const deployTokens = () => import("./deploy-tokens.js?v=3624ebb344aa8e94");
const packages = () => import("./packages.js?v=940a14d638488fa5");
const account = () => import("./account.js?v=78a530138d3ce5b3");
const oidc = () => import("./oidc.js?v=3413673d20418475");
const collaboration = () => import("./collaboration.js?v=e564a672794f8bb0");
const platform = () => import("./manage.js?v=3f4cfee2f85c57c9");
import {
  keyPage,
  forgePage,
  upstreamPage,
} from "./forge.js?v=5830e6e9cedfecd4";
const root = document.querySelector("#app");
const esc = (x) =>
  String(x ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const icons = {
  repo: "M4 3h13a2 2 0 0 1 2 2v16H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z M3 17h16 M7 7h8 M7 10h6",
  plus: "M12 5v14 M5 12h14",
  code: "M8 6l-6 6 6 6 M16 6l6 6-6 6",
  key: "M14 7a5 5 0 1 0-3 9l3 3h3v-3h3v-3l-3-3",
  folder: "M3 5h6l2 3h10v12H3z",
  file: "M5 3h9l5 5v13H5z M14 3v6h5",
  branch: "M6 3v12a4 4 0 0 0 8 0V9 M3 3h6 M11 6h6v3h-6z",
  users:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M17 4a4 4 0 0 1 0 7 M22 21v-2a4 4 0 0 0-3-4",
};
const icon = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${icons[name] || icons.repo}"/></svg>`;
const date = (s) =>
  new Date(s.includes("T") ? s : s + "Z").toLocaleDateString("zh-CN", {
    month: "short",
    day: "numeric",
  });
let user = null,
  setup = false,
  routeVersion = 0;
let booting = true,
  hasRendered = false,
  navigation = new AbortController(),
  cacheEpoch = 0;
const pendingReads = new Map(),
  repositoryMetadata = new Map(),
  primedReads = new Map();
async function api(path, options = {}) {
  const reading = !options.method || options.method === "GET";
  if (reading && primedReads.has(path)) {
    const promise = primedReads.get(path);
    primedReads.delete(path);
    return promise;
  }
  const metadata = reading && /^\/repos\/[^/]+\/[^/]+$/.test(path);
  if (metadata) {
    const cached = repositoryMetadata.get(path);
    if (cached && cached.expires > Date.now()) return cached.data;
  }
  if (reading && pendingReads.has(path)) return pendingReads.get(path);
  if (!reading) {
    cacheEpoch++;
    repositoryMetadata.clear();
    pendingReads.clear();
    primedReads.clear();
  }
  const epoch = cacheEpoch;
  const request = (async () => {
    const r = await fetch("/api" + path, {
      ...options,
      signal: options.signal || (reading ? navigation.signal : undefined),
      headers: {
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...options.headers,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const data = await r.json();
    if (!r.ok) {
      if ([401, 403, 404].includes(r.status)) repositoryMetadata.clear();
      const error = new Error(
        data.error +
          (data.details
            ? "：" + data.details.map((i) => i.message).join("；")
            : ""),
      );
      error.status = r.status;
      throw error;
    }
    if (metadata && epoch === cacheEpoch) {
      if (repositoryMetadata.size >= 20)
        repositoryMetadata.delete(repositoryMetadata.keys().next().value);
      repositoryMetadata.set(path, { data, expires: Date.now() + 15000 });
    }
    return data;
  })();
  if (reading) pendingReads.set(path, request);
  try {
    return await request;
  } finally {
    if (pendingReads.get(path) === request) pendingReads.delete(path);
    if (!reading) {
      cacheEpoch++;
      repositoryMetadata.clear();
    }
  }
}

let workspaces = [];
let selectedSpace = new URLSearchParams(location.search).get("namespace") || "";
async function reloadSpaces() {
  if (!user) {
    workspaces = [];
    return;
  }
  const result = await api("/workspaces");
  workspaces = result.workspaces;
  updateWorkspaceControl();
}
function updateWorkspaceControl() {
  const control = document.querySelector("#workspace-select");
  if (!control) return;
  control.innerHTML =
    '<option value="">所有可访问项目</option>' +
    (selectedSpace && !workspaces.some((w) => w.slug === selectedSpace)
      ? `<option selected value="${esc(selectedSpace)}">空间 · ${esc(selectedSpace)}</option>`
      : "") +
    workspaces
      .map(
        (w) =>
          `<option value="${esc(w.slug)}" ${selectedSpace === w.slug ? "selected" : ""}>${esc(w.name)}${w.personal ? " · 个人" : ""}</option>`,
      )
      .join("");
  control.onchange = () => {
    selectedSpace = control.value;
    if (location.pathname === "/search") {
      const params = new URLSearchParams(location.search);
      params.set("namespace", selectedSpace);
      params.delete("cursor");
      go("/search?" + params);
      return;
    }
    go(
      "/" +
        (selectedSpace
          ? "?namespace=" + encodeURIComponent(selectedSpace)
          : ""),
    );
  };
}
const namespaceQuery = () =>
  selectedSpace ? "&namespace=" + encodeURIComponent(selectedSpace) : "";
function codeViewer(code, path) {
  return `<div class="code-viewer"><pre class="line-numbers" aria-hidden="true">${code
    .split("\n")
    .map((_, i) => `<span id="L${i + 1}">${i + 1}</span>`)
    .join(
      "\n",
    )}</pre><pre><code id="highlight-target" data-path="${esc(path)}">${esc(code)}</code></pre></div>`;
}
async function applyHighlight() {
  const target = document.querySelector("#highlight-target");
  if (!target) return;
  const raw = target.textContent;
  const { highlightCode } = await import("./highlight.js?v=42546bacb8cbde94");
  const html = highlightCode(raw, target.dataset.path);
  if (target.isConnected && html !== null) target.innerHTML = html;
}

async function applyMarkdown(context = {}) {
  const targets = [...document.querySelectorAll("[data-markdown]")].filter(
    (el) => !el.dataset.rendered,
  );
  if (!targets.length) return;
  const { renderMarkdown } = await import("./markdown.js?v=8019fb73893e5723");
  for (const el of targets) {
    if (!el.isConnected) continue;
    const raw = el.textContent;
    el.innerHTML = renderMarkdown(raw, {
      ...context,
      base: el.dataset.base || context.base,
      ref: el.dataset.ref || context.ref,
      path: el.dataset.file || "README.md",
    });
    el.dataset.rendered = "1";
  }
  const code = targets.flatMap((el) => [
    ...el.querySelectorAll('pre code[class*="language-"]'),
  ]);
  if (code.length) {
    const { highlightCode } = await import("./highlight.js?v=42546bacb8cbde94");
    for (const el of code) {
      const lang = [...el.classList]
          .find((c) => c.startsWith("language-"))
          .slice(9),
        aliases = {
          javascript: "js",
          typescript: "ts",
          python: "py",
          bash: "sh",
          shell: "sh",
          rust: "rs",
          markdown: "md",
          cpp: "cpp",
          yaml: "yaml",
        };
      const html = highlightCode(
        el.textContent,
        "file." + (aliases[lang] || lang),
      );
      if (el.isConnected && html !== null) el.innerHTML = html;
    }
  }
}
function loadingContent(title = "项目") {
  return `<div class="titlebar"><h1>${esc(title)}</h1></div><section class="panel page-loading" aria-busy="true" aria-label="正在加载${esc(title)}"><div class="skeleton skeleton-heading"></div>${'<div class="skeleton skeleton-row"></div>'.repeat(5)}<span class="sr-only" role="status">正在加载${esc(title)}</span></section>`;
}
function browseURL(ap) {
  const q = new URLSearchParams(location.search),
    params = new URLSearchParams({
      path: q.get("path") || "",
      view: q.get("view") === "blob" ? "blob" : "tree",
    });
  if (q.get("ref")) params.set("ref", q.get("ref"));
  return ap + "/browse?" + params;
}
function primeRoute() {
  const path = location.pathname,
    parts = path.split("/").filter(Boolean);
  const reads = [];
  if (path === "/") {
    const q = new URLSearchParams(location.search);
    reads.push(
      "/repos?q=" +
        encodeURIComponent(q.get("q") || "") +
        "&page=" +
        (Number(q.get("page")) || 0) +
        namespaceQuery(),
    );
  } else if (
    parts.length >= 2 &&
    !["settings", "admin", "spaces"].includes(parts[0])
  ) {
    const ap = "/repos/" + parts[0] + "/" + parts[1];
    reads.push(ap);
    if (!parts[2]) reads.push(browseURL(ap));
    else if (parts[2] === "issues" && !parts[3]) {
      const q = new URLSearchParams(location.search);
      reads.push(ap + "/planning", ap + "/issue-boards");
      if (q.get("view") === "board")
        reads.push(
          ap +
            "/issue-boards/" +
            encodeURIComponent(q.get("board") || "default"),
        );
      else {
        q.set("limit", "50");
        reads.push(ap + "/issues?" + q);
      }
    } else if (
      parts[2] === "issues" &&
      parts[3] &&
      new URLSearchParams(location.search).get("comments_after")
    ) {
      reads.push(
        ap +
          "/issues/" +
          parts[3] +
          "?comments_after=" +
          encodeURIComponent(
            new URLSearchParams(location.search).get("comments_after"),
          ),
      );
    } else if (["commits", "members", "issues", "merges"].includes(parts[2]))
      reads.push(ap + "/" + parts[2] + (parts[3] ? "/" + parts[3] : ""));
  }
  // Attach rejection handlers immediately; the page awaits the same in-flight reads.
  for (const path of reads) {
    const promise = api(path);
    primedReads.set(path, promise);
    promise.catch(() => {});
  }
}

function notice(message) {
  const n = document.querySelector("#notice");
  n.textContent = message;
  n.className = "notice-visible";
  setTimeout(() => {
    n.className = "";
    n.textContent = "";
  }, 4500);
}
function go(path) {
  history.pushState({}, "", path);
  render();
}
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-link]");
  if (a && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
    e.preventDefault();
    go(a.getAttribute("href"));
  }
});
window.addEventListener("popstate", render);
const link = (path, label, cls = "") =>
  `<a data-link href="${esc(path === "/" && user && selectedSpace ? "/?namespace=" + encodeURIComponent(selectedSpace) : path)}" class="${cls}">${label}</a>`;
function layout(content, crumb = "项目", active = "repos") {
  root.innerHTML = `<div class="layout"><aside class="sidebar">${link("/", '<img src="/favicon.svg" alt="">OneStorage', "brand")}<div class="workspace"><span class="avatar">${esc(user?.username[0].toUpperCase() || "O")}</span><div>${esc(user?.username || (booting ? "工作空间" : "公开空间"))}<div class="muted">${user ? "个人工作空间" : "探索开源项目"}</div></div></div>${user ? '<div class="space-switch"><label for="workspace-select">当前空间</label><select id="workspace-select" aria-label="切换工作空间"></select></div>' : ""}<div class="eyebrow">WORKSPACE</div><nav>${link("/search" + (selectedSpace ? "?namespace=" + encodeURIComponent(selectedSpace) : ""), icon("code") + "跨项目搜索", `navlink ${active === "search" ? "active" : ""}`)}${link("/", icon("repo") + "项目", `navlink ${active === "repos" ? "active" : ""}`)}${user ? link("/settings/tokens", icon("key") + "访问令牌", `navlink ${active === "tokens" ? "active" : ""}`) : ""}${user ? link("/settings/keys", icon("key") + "密钥与连接", `navlink ${active === "keys" ? "active" : ""}`) : ""}${user ? link("/spaces", icon("users") + "工作空间", `navlink ${active === "spaces" ? "active" : ""}`) : ""}${user ? link("/settings/account", icon("key") + "账户安全", "navlink") + link("/settings/profile", icon("users") + "个人资料", "navlink") : ""}${user ? link("/notifications", icon("repo") + "通知", "navlink") : ""}${user?.admin ? link("/admin/users", icon("users") + "管理员后台", `navlink ${active === "admin" ? "active" : ""}`) : ""}</nav><footer><a href="https://git.1s.hk">git.1s.hk ↗</a>OneStorage · 开源 Git 服务<br><a href="/source.tar.gz" download>源代码 · AGPL-3.0 ↓</a></footer></aside><main class="main"><header class="topbar"><div class="breadcrumb">${link("/", "工作空间")}<span>/</span><span>${crumb}</span></div><div class="right"><span class="pill">SELF-HOSTED</span>${user ? `<span class="avatar" title="${esc(user.username)}">${esc(user.username[0].toUpperCase())}</span><button class="text" id="logout">退出</button>` : link("/login", "登录", "btn small")}</div></header><div class="content">${content}</div></main></div>`;
  updateWorkspaceControl();
  document.querySelector("#logout")?.addEventListener("click", async () => {
    await api("/logout", { method: "POST" });
    user = null;
    workspaces = [];
    selectedSpace = "";
    go("/login");
  });
}
function bindForm(id, handler) {
  const form = document.querySelector(id);
  form?.querySelectorAll("input,textarea,select").forEach((input, i) => {
    if (!input.id || input.id === input.name)
      input.id = form.id + "-" + (input.name || i);
    const label = input.closest(".field")?.querySelector("label");
    if (label) label.htmlFor = input.id;
  });
  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector("[type=submit]");
    const error = form.querySelector(".error");
    if (error) error.remove();
    btn.disabled = true;
    try {
      await handler(Object.fromEntries(new FormData(form)), form);
    } catch (e) {
      const div = document.createElement("div");
      div.className = "error";
      div.textContent = e.message;
      form.prepend(div);
    } finally {
      btn.disabled = false;
    }
  });
}
function field(label, name, type = "text", value = "", hint = "") {
  return `<div class="field"><label for="${name}">${label}</label><input id="${name}" name="${name}" type="${type}" value="${esc(value)}" required ${type === "password" ? 'minlength="12" maxlength="128" autocomplete="current-password"' : ""}>${hint ? `<p class="hint">${hint}</p>` : ""}</div>`;
}
const textarea = (label, name, value = "", cls = "") =>
  `<div class="field"><label for="${name}">${label}</label><textarea name="${name}" id="${name}" class="${cls}">${esc(value)}</textarea></div>`;
function authPage() {
  const initializing = setup;
  root.innerHTML = `<main class="auth"><section class="auth-story"><a href="/" class="brand" data-link><img src="/favicon.svg" alt="">OneStorage</a><div><h1>代码的归属，<br><span>由你定义。</span></h1><p>从第一个 commit 到下一次合并。把仓库、讨论与协作，留在自己的空间。</p><div class="lines">$ git add .<br>$ git commit -m "a new beginning"<br>$ git push origin main<br><span>↳ git.1s.hk</span></div></div><div class="auth-footer"><a href="/source.tar.gz" download>OPEN SOURCE · AGPL-3.0 ↓</a></div></section><section class="auth-form"><form id="login-form"><h2>${initializing ? "创建你的工作空间" : "欢迎回来"}</h2><p class="muted">${initializing ? "使用部署时配置的初始化密钥创建管理员。" : "登录 OneStorage，继续你的下一个想法。"}</p>${initializing ? field("初始化密钥", "secret", "password") : ""}${field("用户名", "username")}${field("密码", "password", "password", "", "至少 12 个字符")}${!initializing ? '<div class="field"><label>双重验证（已启用时填写）<input name="otp" maxlength="64" autocomplete="one-time-code" placeholder="验证码或恢复码"></label></div>' : ""}<button type="submit" class="btn primary">${initializing ? "初始化 OneStorage" : "登录工作空间"} →</button>${!initializing ? link("/login/recover", "忘记密码？") + link("/", "浏览公开项目 →") : ""}</form></section></main>`;
  bindForm("#login-form", async (data) => {
    if (initializing) {
      await api("/setup", { method: "POST", body: data });
      setup = false;
    }
    user = await api("/login", {
      method: "POST",
      body: {
        username: data.username,
        password: data.password,
        otp: data.otp || "",
      },
    });
    await reloadSpaces();
    go("/");
  });
  if (!initializing) {
    const holder = document.createElement("div");
    holder.id = "oidc-login";
    holder.className = "form";
    document.querySelector(".auth-form").append(holder);
    if (new URLSearchParams(location.search).has("oidc_error"))
      holder.textContent = "统一登录未完成，请重新开始或使用原登录方式。";
    api("/auth/oidc/providers")
      .then(({ providers }) => {
        if (!holder.isConnected) return;
        holder.insertAdjacentHTML(
          "beforeend",
          providers
            .map(
              (p) =>
                `<button type="button" class="btn" data-oidc-login="${p.id}">使用 ${esc(p.name)} 登录</button>`,
            )
            .join(""),
        );
        holder.querySelectorAll("[data-oidc-login]").forEach(
          (b) =>
            (b.onclick = async () => {
              b.disabled = true;
              try {
                const result = await api(
                  "/auth/oidc/" + b.dataset.oidcLogin + "/start",
                  { method: "POST", body: { mode: "login" } },
                );
                location.assign(result.url);
              } catch (e) {
                notice(e.message);
                b.disabled = false;
              }
            }),
        );
      })
      .catch(() => {});
  }
}
async function projects(version) {
  const query = new URLSearchParams(location.search),
    q = query.get("q") || "",
    page = Number(query.get("page")) || 0;
  const { repositories } = await api(
    `/repos?q=${encodeURIComponent(q)}&page=${page}${namespaceQuery()}`,
  );
  if (version !== routeVersion) return;
  layout(
    `<div class="titlebar"><div><h1>项目</h1><p class="muted">每一个想法，都从一个仓库开始。</p></div>${user ? link("/new", icon("plus") + "新建项目", "btn primary") : link("/login", "登录以创建项目", "btn primary")}</div><div class="stats"><div class="stat"><div class="muted">当前列表</div><div class="number">${repositories.length}<span>个项目</span></div></div><div class="stat"><div class="muted">公开项目</div><div class="number">${repositories.filter((r) => r.visibility === "public").length}<span>开放协作</span></div></div><div class="stat"><div class="muted">私有项目</div><div class="number">${repositories.filter((r) => r.visibility === "private").length}<span>受控访问</span></div></div></div><form class="toolbar" id="search"><div class="search"><input name="q" value="${esc(q)}" placeholder="搜索项目名称或描述…" aria-label="搜索项目"></div><button class="btn" type="submit">搜索</button><span class="muted">最近创建 ↓</span></form><div class="panel"><div class="panelhead"><strong>${q ? "搜索结果" : "所有可访问项目"}</strong><span class="muted">${repositories.length} 个项目</span></div>${repositories.length ? repositories.map((r) => `<article class="repo-row"><div class="repo-icon">${icon("repo")}</div><div class="repo-info">${link(`/${r.namespace}/${encodeURIComponent(r.name)}`, `<span class="namespace">${esc(r.namespace)} / </span>${esc(r.name)}`, "repo-name")}<p>${esc(r.description || "这个项目还没有描述。")}</p><div class="rowmeta"><span><i class="dot"></i>Git</span><span>${esc(r.default_branch)}</span><span>创建于 ${date(r.created_at)}</span></div></div><span class="pill">${r.visibility === "private" ? "私有" : "公开"}</span></article>`).join("") : `<div class="empty">${icon("repo")}<h2>${q ? "没有找到匹配的项目" : "让第一个想法落地"}</h2><p>${q ? "试试其他项目名称或描述关键词。" : "创建一个仓库，用 Git 推送代码，邀请伙伴一起构建。"}</p>${user && !q ? link("/new", "创建第一个项目", "btn primary") : ""}</div>`}</div><div class="page-nav">${page > 0 ? link(`/?page=${page - 1}&q=${encodeURIComponent(q)}${namespaceQuery()}`, "← 上一页", "btn small") : "<span></span>"}${repositories.length === 50 ? link(`/?page=${page + 1}&q=${encodeURIComponent(q)}${namespaceQuery()}`, "下一页 →", "btn small") : ""}</div><p class="footer-note">你的代码，存放在你自己的 Cloudflare 账户。</p>`,
  );
  document.querySelector("#search").onsubmit = (e) => {
    e.preventDefault();
    go(
      "/?q=" +
        encodeURIComponent(new FormData(e.target).get("q")) +
        namespaceQuery(),
    );
  };
}
async function newProject() {
  if (user && !workspaces.length) await reloadSpaces();
  if (!user) return go("/login");
  layout(
    `<div class="titlebar"><div><h1>新建项目</h1><p class="muted">为下一件值得构建的事，留一个位置。</p></div></div><div class="panel"><form class="form" id="create">${field("项目名称", "name", "text", "", "支持小写字母、数字、短横线、下划线和最多 5 层分组路径，例如 team/project。")}<div class="field"><label for="namespace">工作空间</label><select id="namespace" name="namespace">${workspaces
      .filter((w) => ["owner", "maintainer", "developer"].includes(w.role))
      .map(
        (w) =>
          `<option value="${esc(w.slug)}" ${w.slug === (selectedSpace || user.username) ? "selected" : ""}>${esc(w.name)} / ${esc(w.slug)}</option>`,
      )
      .join(
        "",
      )}</select></div>${textarea("项目描述", "description")}<div class="inline"><div class="field"><label for="visibility">可见性</label><select id="visibility" name="visibility"><option value="private">私有 · 仅成员可访问</option><option value="public">公开 · 所有人可读取</option></select></div>${field("默认分支", "default_branch", "text", "main")}</div><button type="submit" class="btn primary">创建项目</button></form></div>`,
    "新建项目",
  );
  bindForm("#create", async (data) => {
    const r = await api("/repos", { method: "POST", body: data });
    go(`/${r.namespace}/${encodeURIComponent(r.name)}`);
  });
}
let currentRepo = null;
function repoLayout(r, tab, content, actions = "") {
  currentRepo = r;
  if (user) selectedSpace = r.namespace;
  const base = `/${r.namespace}/${encodeURIComponent(r.name)}`;
  layout(
    `<div class="titlebar"><div><div class="inline"><h1>${esc(r.name)}</h1><span class="pill">${r.visibility === "public" ? "公开" : "私有"}</span></div><p class="muted">${esc(r.description || "添加描述，让伙伴了解这个项目。")}</p></div>${actions}</div><nav class="tabs" aria-label="项目导航">${[
      ["code", "代码", ""],
      ["commits", "提交", "/commits"],
      ["ci", "CI/CD", "/ci"],
      ["packages", "包仓库", "/packages"],
      ["forge", "Git 工具", "/forge"],
      ["search", "搜索", "/search"],
      ["issues", "Issues", "/issues"],
      ["merges", "合并请求", "/merges"],
      ["planning", "规划", "/planning"],
      ["releases", "版本", "/releases"],
      ["wiki", "Wiki", "/wiki"],
      ["deployments", "应用发布", "/deployments"],
      ["protect", "分支保护", "/protect"],
      ["members", "成员", "/members"],
      ...(["owner", "maintainer"].includes(r.role)
        ? [
            ["settings", "设置", "/settings"],
            ["upstream", "同步与 Fork", "/upstream"],
          ]
        : []),
    ]
      .map(([key, label, path]) =>
        link(base + path, label, `tab ${tab === key ? "active" : ""}`),
      )
      .join(
        "",
      )}</nav>${r.archived_at ? '<div class="info" role="status">此项目已归档：代码与历史记录可读，协作写入和流水线已暂停。项目所有者可在设置中恢复。</div>' : ""}${content}`,
    `${esc(r.namespace)} / ${esc(r.name)}`,
  );
}
function copyButton(value, id = "copy") {
  document.querySelector("#" + id)?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(value);
      notice("已复制到剪贴板");
    } catch {
      notice("无法访问剪贴板，请手动复制。");
    }
  });
}
const writeable = (r) =>
  !r.archived_at && ["owner", "maintainer", "developer"].includes(r.role);
async function codePage(r, base, ap, version) {
  const params = new URLSearchParams(location.search),
    p = params.get("path") || "",
    blob = params.get("view") === "blob";
  const {
    branches,
    data,
    readme: readmeFile,
    default_branch,
  } = await api(browseURL(ap));
  const ref = params.get("ref") || default_branch;
  r = { ...r, default_branch };
  if (version !== routeVersion) return;
  const clone = `<button class="btn" id="copy">克隆地址 ↗</button>`;
  const aside = `<aside class="aside"><section><h3>关于项目</h3><p class="muted">${esc(r.description || "暂无描述")}</p><span class="pill">${r.visibility === "public" ? "公开仓库" : "私有仓库"}</span></section><section><h3>使用 Git 克隆</h3><code>${esc(r.clone_url)}</code><p class="muted">HTTPS 凭证：用户名 + 访问令牌</p>${link("/settings/tokens", "管理访问令牌 →")}</section><section><h3>仓库详情</h3><p class="muted">${branches.length} 个分支<br>默认分支 ${esc(r.default_branch)}<br>创建于 ${date(r.created_at)}</p></section></aside>`;
  if (!branches.length) {
    repoLayout(
      r,
      "code",
      `<div class="grid"><div class="panel"><div class="empty">${icon("code")}<h2>第一行代码，从这里开始</h2><p>仓库已准备好。推送现有项目，或者在线创建第一个文件。</p>${writeable(r) ? link(base + "/edit", "创建 README", "btn primary") : ""}</div><pre>git init -b ${esc(r.default_branch)}
git add .
git commit -m "Initial commit"
git remote add origin ${esc(r.clone_url)}
git push -u origin ${esc(r.default_branch)}</pre></div>${aside}</div>`,
      clone,
    );
    copyButton(r.clone_url);
    return;
  }
  const readme = readmeFile?.content
    ? `<section class="panel readme"><div class="panelhead"><strong>README.md</strong></div><div class="markdown detail-body" data-markdown data-base="${esc(base)}" data-ref="${esc(data.ref)}" data-file="README.md">${esc(readmeFile.content)}</div></section>`
    : "";
  if (version !== routeVersion) return;
  const nav = `<div class="toolbar"><div class="actionbar"><select class="select-branch" id="branch" aria-label="选择分支">${!branches.some((b) => b.name === ref) ? `<option selected value="${esc(ref)}">提交 ${esc(ref.slice(0, 12))}</option>` : ""}${branches.map((b) => `<option ${b.name === ref ? "selected" : ""} value="${esc(b.name)}">⑂ ${esc(b.name)}</option>`).join("")}</select><span class="muted">${esc(p || "/")}</span></div>${writeable(r) ? link(`${base}/edit?ref=${encodeURIComponent(ref)}${blob ? "&path=" + encodeURIComponent(p) : ""}`, blob ? "编辑文件" : "新建文件", "btn small") : ""}</div>`;
  const up = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
  const list = blob
    ? `<div class="panelhead">${esc(p)}<span class="muted">${data.size} bytes</span></div>${/\.(png|jpe?g|gif|webp)$/i.test(p) ? `<div class="image-preview"><img id="blob-preview" alt="${esc(p)}" src="${esc("/api" + ap + "/preview?" + new URLSearchParams({ ref: data.ref, path: p }))}"><p class="muted" id="preview-caption">图片预览 · ${esc(p)}</p></div>` : data.binary ? '<div class="empty"><p>二进制文件，请通过 Git 下载。</p></div>' : /\.md$/i.test(p) ? `<div class="markdown detail-body" data-markdown data-base="${esc(base)}" data-ref="${esc(data.ref)}" data-file="${esc(p)}">${esc(data.content)}</div><details><summary>查看源码</summary>${codeViewer(data.content, p)}</details>` : codeViewer(data.content, p)}`
    : `<div class="panelhead"><span>${link(base + "?ref=" + encodeURIComponent(ref), esc(r.name))}${p ? " / " + esc(p) : ""}</span><code>${esc(data.ref.slice(0, 8))}</code></div>${p ? `<div class="file-row">${link(`${base}?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(up)}`, "← 上一级")}<span></span></div>` : ""}${data.entries
        .sort(
          (a, b) =>
            (a.type === b.type ? 0 : a.type === "tree" ? -1 : 1) ||
            a.name.localeCompare(b.name),
        )
        .map(
          (f) =>
            `<div class="file-row">${link(`${base}?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent((p ? p + "/" : "") + f.name)}${f.type === "tree" ? "" : "&view=blob"}`, icon(f.type === "tree" ? "folder" : "file") + esc(f.name))}<span class="muted">${f.sha.slice(0, 8)}</span></div>`,
        )
        .join("")}`;
  repoLayout(
    r,
    "code",
    nav +
      `<div class="grid"><div><div class="panel">${list}</div>${readme}</div>${aside}</div>`,
    clone,
  );
  const preview = document.querySelector("#blob-preview");
  if (preview) {
    const failed = () => {
      preview.hidden = true;
      document.querySelector("#preview-caption").textContent =
        "无法预览：仅支持有效的 PNG、JPEG、GIF、WebP 图片，且不超过 5 MiB。";
    };
    preview.addEventListener("error", failed);
    if (preview.complete && !preview.naturalWidth) failed();
  }
  copyButton(r.clone_url);
  applyHighlight().catch(() => {});
  if (/^#L[1-9][0-9]*$/.test(location.hash)) {
    const line = document.getElementById(location.hash.slice(1));
    const details = line?.closest("details");
    if (details) details.open = true;
    line?.scrollIntoView({ block: "center" });
  }
  document.querySelector("#branch").onchange = (e) =>
    go(`${base}?ref=${encodeURIComponent(e.target.value)}`);
}
async function searchPage(r, base, ap, version) {
  const q = new URLSearchParams(location.search).get("q") || "";
  const result = q
    ? await api(ap + "/search?q=" + encodeURIComponent(q))
    : { matches: [] };
  if (version !== routeVersion) return;
  repoLayout(
    r,
    "search",
    `<section class="panel" id="code-index-status"></section><form class="toolbar" id="code-search"><div class="search"><input name="q" value="${esc(q)}" required maxlength="128" placeholder="在默认分支搜索代码…" aria-label="搜索代码"></div><button class="btn primary" type="submit">搜索代码</button></form><div class="panel"><div class="panelhead"><strong>${result.matches.length} 处匹配</strong><span class="muted">${esc(r.default_branch)}${result.truncated ? " · 仅显示前 200 条" : ""}</span></div>${result.matches.map((m) => `<div class="comment">${link(base + "?view=blob&path=" + encodeURIComponent(m.path), esc(m.path) + ":" + m.line)}<pre>${esc(m.text)}</pre></div>`).join("") || '<div class="empty"><p>' + (q ? "没有匹配的代码。" : "输入关键词，搜索仓库中的文本文件。") + "</p></div>"}</div>`,
  );
  const indexUI = await import("./search.js?v=6a7618b7a0242477");
  if (version !== routeVersion) return;
  indexUI.mountCodeIndex(document.querySelector("#code-index-status"), r, ap, {
    api,
    esc,
    notice,
    current: () => version === routeVersion,
  });
  document.querySelector("#code-search").onsubmit = (e) => {
    e.preventDefault();
    go(
      base + "/search?q=" + encodeURIComponent(new FormData(e.target).get("q")),
    );
  };
}
async function editPage(r, base, ap, version) {
  if (!writeable(r)) throw Error("需要项目写入权限。");
  const params = new URLSearchParams(location.search),
    ref = params.get("ref") || r.default_branch,
    p = params.get("path") || "README.md";
  const { branches } = await api(ap + "/branches"),
    head = branches.find((b) => b.name === ref)?.sha || null;
  let content = "";
  if (params.has("path"))
    content =
      (
        await api(
          `${ap}/blob?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(p)}`,
        )
      ).content || "";
  else if (!head) content = `# ${r.name}\n\n${r.description}\n`;
  if (version !== routeVersion) return;
  repoLayout(
    r,
    "code",
    `<div class="panel"><div class="panelhead"><strong>${params.has("path") ? "编辑文件" : "新建文件"}</strong><span class="muted">${esc(ref)}</span></div><form class="form" id="edit">${field("文件路径", "path", "text", p)}${textarea("文件内容", "content", content, "editor")}${field("提交说明", "message", "text", params.has("path") ? "Update " + p : "Add " + p)}<button class="btn primary" type="submit">提交到 ${esc(ref)}</button></form></div>`,
  );
  bindForm("#edit", async (data) => {
    await api(ap + "/commit", {
      method: "POST",
      body: {
        branch: ref,
        expected_sha: head,
        message: data.message,
        files: [{ path: data.path, content: data.content }],
      },
    });
    go(base + "?ref=" + encodeURIComponent(ref));
    notice("提交已保存");
  });
}
async function commitsPage(r, base, ap, version) {
  const { commits } = await api(ap + "/commits");
  if (version !== routeVersion) return;
  repoLayout(
    r,
    "commits",
    `<div class="panel"><div class="panelhead"><strong>最近提交</strong><span class="muted">${esc(r.default_branch)}</span></div>${commits.map((c) => `<div class="repo-row"><span class="avatar">${esc(c.author[0])}</span><div class="repo-info"><strong>${esc(c.message)}</strong><p>${esc(c.author)} · ${date(c.date)}</p></div><code>${c.sha.slice(0, 8)}</code></div>`).join("")}</div>`,
  );
}
async function issuesPage(r, base, ap, sub, version, helpers) {
  if (sub) {
    const after = new URLSearchParams(location.search).get("comments_after");
    const i = await api(
      ap +
        "/issues/" +
        sub +
        (after ? "?comments_after=" + encodeURIComponent(after) : ""),
    );
    if (version !== routeVersion) return;
    repoLayout(
      r,
      "issues",
      `<div class="titlebar"><div><h2>#${i.id} ${esc(i.title)}</h2><span class="pill ${i.state === "open" ? "green" : "purple"}">${i.state === "open" ? "开放中" : "已关闭"}</span> <span class="muted">${esc(i.author)} · ${date(i.created_at)}</span></div>${!r.archived_at && user && (user.id === i.author_id || ["owner", "maintainer", "developer"].includes(r.role)) ? '<button class="btn" id="toggle">' + (i.state === "open" ? "关闭 Issue" : "重新打开") + "</button>" : ""}</div>${!r.archived_at && user && (user.id === i.author_id || ["owner", "maintainer", "developer"].includes(r.role)) ? `<details class="panel"><summary class="panelhead">编辑标题与描述</summary><form class="form" id="edit-issue">${field("标题", "title", "text", i.title)}${textarea("描述", "body", i.body)}<button class="btn primary" type="submit">保存</button></form></details>` : ""}<div class="panel"><div class="detail-body markdown" data-markdown>${esc(i.body || "暂无描述。")}</div>${i.comments.map((c) => `<div class="comment"><strong>${esc(c.author)}</strong> <span class="muted">${date(c.created_at)}</span><div class="markdown" data-markdown>${esc(c.body)}</div></div>`).join("")}${i.comments_next ? `<a data-link class="btn" href="${base}/issues/${i.id}?comments_after=${i.comments_next}">更多评论 →</a>` : ""}${!r.archived_at && user ? `<form class="form" id="comment">${textarea("参与讨论", "body")}<button class="btn primary" type="submit">发表评论</button></form>` : ""}</div>`,
    );
    document.querySelector("#toggle")?.addEventListener("click", async () => {
      try {
        await api(ap + "/issues/" + sub, {
          method: "PATCH",
          body: {
            state: i.state === "open" ? "closed" : "open",
            revision: i.revision,
          },
        });
        render();
      } catch (e) {
        notice(e.message);
      }
    });
    bindForm("#edit-issue", async (b) => {
      await api(ap + "/issues/" + sub, {
        method: "PATCH",
        body: { ...b, revision: i.revision },
      });
      render();
    });
    bindForm("#comment", async (data) => {
      await api(ap + "/issues/" + sub + "/comments", {
        method: "POST",
        body: data,
      });
      render();
    });
    return i;
  }
  return (await import("./issues.js?v=35bf97a02fe71433")).issuesPage(
    r,
    base,
    ap,
    helpers,
  );
}
async function mergesPage(r, base, ap, sub, version) {
  return (await collaboration()).mergesPage(r, base, ap, {
    api,
    repoLayout,
    esc,
    field,
    textarea,
    bindForm,
    go,
    user,
    current: () => version === routeVersion,
  });
}
async function membersPage(r, base, ap, version) {
  const { members, inherited_members = [] } = await api(ap + "/members");
  if (version !== routeVersion) return;
  const maintain = ["owner", "maintainer"].includes(r.role);
  repoLayout(
    r,
    "members",
    `<div class="stack"><div class="panel"><div class="panelhead"><strong>项目成员</strong></div><div class="token-row"><strong>${esc(r.namespace)}</strong><span class="pill">${r.workspace_id ? "继承空间权限" : "所有者"}</span></div>${inherited_members.map((m) => `<div class="token-row"><strong>${esc(m.username)}</strong><span class="pill">${esc(m.role)} · 空间继承</span></div>`).join("")}${members.map((m) => `<div class="token-row"><strong>${esc(m.username)}</strong><div class="actionbar"><span class="pill">${esc(m.role)}</span>${maintain ? `<button class="btn small danger" data-remove="${esc(m.username)}">移除</button>` : ""}</div></div>`).join("")}</div>${maintain ? `<div class="panel"><form class="form" id="member"><h2>添加或更新成员</h2>${field("用户名", "username", "text", "", "用户须先由管理员创建账号。")}<div class="field"><label for="role">项目角色</label><select id="role" name="role"><option value="reader">Reader · 读取代码</option><option value="developer">Developer · 推送代码</option><option value="maintainer">Maintainer · 合并与管理</option></select></div><button class="btn primary" type="submit">保存成员</button></form></div>` : ""}</div>`,
  );
  bindForm("#member", async (data) => {
    await api(ap + "/members", { method: "PUT", body: data });
    render();
  });
  document.querySelectorAll("[data-remove]").forEach(
    (b) =>
      (b.onclick = async () => {
        try {
          await api(ap + "/members/" + b.dataset.remove, { method: "DELETE" });
          render();
        } catch (e) {
          notice(e.message);
        }
      }),
  );
}
async function settingsPage(r, base, ap, version) {
  const [{ events }, { webhooks }, { deliveries }] = await Promise.all([
    api(ap + "/audit"),
    api(ap + "/webhooks"),
    api(ap + "/deliveries"),
  ]);
  if (version !== routeVersion) return;
  repoLayout(
    r,
    "settings",
    `<p><a data-link href="${base}/deploy-tokens" class="btn">部署令牌</a></p><div class="stack">${r.role === "owner" ? `<div class="panel"><form class="form" id="project-lifecycle"><h2>${r.archived_at ? "恢复项目" : "归档项目"}</h2><p class="muted">归档后可继续 clone、下载和读取历史；停止写入及新流水线，取消正在执行的任务。已发布应用保留最后版本。恢复后，已取消任务需要手动重试。</p><button type="submit" class="btn">${r.archived_at ? "取消归档" : "归档为只读"}</button></form></div>` : ""}${r.role === "owner" ? `<details class="panel"><summary class="panelhead">转移或重命名项目</summary><form class="form" id="project-transfer">${field("目标空间", "namespace", "text", r.namespace, "填写你的个人空间或你拥有的团队空间名称。")}${field("目标项目名", "name", "text", r.name)}<p class="muted">保留代码、Issues、MR、Wiki 与历史产物；显式项目成员保留，团队继承权限重新计算。跨空间转移会取消 CI 与同步，撤销 Runner、Git 连接及 Webhook，暂停自动流水线并关闭应用公开访问；目标空间需要重新配置后启用。同空间重命名保留连接、运行与发布状态。</p><label><input type="checkbox" required name="acknowledge">我已了解连接与发布状态的变更</label><button class="btn" type="submit">转移项目</button></form></details>` : ""}<div class="panel"><form class="form" id="repo-settings"><h2>项目设置</h2>${textarea("项目描述", "description", r.description)}${field("默认分支", "default_branch", "text", r.default_branch)}<div class="field"><label for="visibility">可见性</label><select name="visibility" id="visibility"><option value="private" ${r.visibility === "private" ? "selected" : ""}>私有 · 仅成员可访问</option><option value="public" ${r.visibility === "public" ? "selected" : ""}>公开 · 所有人可读取</option></select></div><button class="btn primary" type="submit">保存设置</button></form></div><div class="panel"><div class="panelhead"><strong>Webhook</strong><span class="muted">${webhooks.length} / 10</span></div>${webhooks.map((h) => `<div class="token-row"><span>${esc(h.url)}</span><button class="btn small danger" data-hook="${h.id}">移除</button></div>`).join("")}<form class="form" id="webhook"><p class="muted">接收地址须为管理员已允许的 HTTPS 主机。签名密钥仅在创建时显示一次。</p>${field("接收地址", "url", "url")}<button class="btn primary" type="submit">添加 Webhook</button><div id="hook-result"></div></form></div><div class="panel"><div class="panelhead"><strong>最近投递</strong></div>${deliveries.length ? deliveries.map((d) => `<div class="token-row"><code>${esc(d.id.slice(0, 8))}</code><span class="pill">${esc(d.state)}</span><span class="muted">${d.attempts} 次尝试 · HTTP ${d.last_status || "—"}</span></div>`).join("") : '<div class="empty"><p>暂无投递记录。</p></div>'}</div><div class="panel"><div class="panelhead"><strong>审计记录</strong><span class="muted">最近 100 条</span></div>${events.map((e) => `<div class="token-row"><div><strong>${esc(e.action)}</strong><p class="muted">${esc(e.actor || "system")} · ${esc(e.detail)}</p></div><span class="muted">${date(e.created_at)}</span></div>`).join("")}</div></div>`,
  );
  bindForm("#project-transfer", async (data) => {
    const result = await api(ap + "/transfer", {
      method: "POST",
      body: {
        namespace: data.namespace,
        name: data.name,
        revision: r.lifecycle_revision,
      },
    });
    notice(
      data.namespace.toLowerCase() === r.namespace.toLowerCase()
        ? "项目已重命名"
        : "项目已转移；请在目标空间重新配置连接与发布",
    );
    go(`/${result.namespace}/${encodeURIComponent(result.name)}/settings`);
  });
  bindForm("#project-lifecycle", async () => {
    await api(ap + "/lifecycle", {
      method: "PUT",
      body: { archived: !r.archived_at, revision: r.lifecycle_revision },
    });
    notice(r.archived_at ? "项目已恢复" : "项目已归档");
    render();
  });
  if (r.archived_at)
    document
      .querySelectorAll(
        "#repo-settings input, #repo-settings textarea, #repo-settings select, #repo-settings button, #webhook input, #webhook button, [data-hook]",
      )
      .forEach((el) => (el.disabled = true));
  bindForm("#webhook", async (data) => {
    const result = await api(ap + "/webhooks", { method: "POST", body: data });
    document.querySelector("#hook-result").innerHTML =
      `<div class="token-display">已添加。请保存签名密钥：<code>${esc(result.secret)}</code></div>`;
  });
  document.querySelectorAll("[data-hook]").forEach(
    (b) =>
      (b.onclick = async () => {
        try {
          await api(ap + "/webhooks/" + b.dataset.hook, { method: "DELETE" });
          render();
        } catch (e) {
          notice(e.message);
        }
      }),
  );
  bindForm("#repo-settings", async (data) => {
    await api(ap, { method: "PATCH", body: data });
    notice("项目设置已保存");
    render();
  });
}
async function tokensPage(version) {
  if (!user) return go("/login");
  const { tokens } = await api("/tokens");
  if (version !== routeVersion) return;
  layout(
    `<div class="titlebar"><div><h1>访问令牌</h1><p class="muted">为 Git 客户端和自动化工具创建凭证。</p></div></div><div class="info">Git 通过 HTTPS 使用你的用户名和令牌认证。令牌只显示一次；可随时撤销。</div><div id="token-result"></div><div class="stack"><details class="panel"><summary class="panelhead">修改账号密码</summary><form class="form" id="change-password">${field("当前密码", "current_password", "password")}${field("新密码", "new_password", "password", "", "修改后将撤销所有会话与访问令牌，需要重新登录。")}<label>双重验证码（已启用时填写）<input name="otp" maxlength="64" autocomplete="one-time-code"></label><button type="submit" class="btn primary">修改密码</button></form></details><div class="panel"><form class="form" id="new-token"><h2>创建令牌</h2>${field("名称", "name", "text", "", "例如：MacBook、CI read-only")}<div class="inline"><div class="field"><label for="scope">权限</label><select id="scope" name="scope"><option value="write">读写 · 使用账号已有权限</option><option value="read">只读</option></select></div><div class="field"><label for="days">有效期</label><select id="days" name="days"><option value="30">30 天</option><option value="90" selected>90 天</option><option value="365">365 天</option></select></div></div><label>双重验证码（已启用时填写）<input name="otp" maxlength="64" autocomplete="one-time-code"></label><button class="btn primary" type="submit">生成令牌</button></form></div><div class="panel"><div class="panelhead"><strong>已有令牌</strong></div>${tokens.length ? tokens.map((t) => `<div class="token-row"><div><strong>${esc(t.name)}</strong><p class="muted">${t.scope === "read" ? "只读" : "读写"} · 到期 ${new Date(t.expires_at).toLocaleDateString("zh-CN")}</p></div><button class="btn small danger" data-revoke="${t.id}">撤销</button></div>`).join("") : '<div class="empty"><p>暂无访问令牌。</p></div>'}</div></div>`,
    "访问令牌",
    "tokens",
  );
  bindForm("#change-password", async (data) => {
    await api("/password", { method: "POST", body: data });
    user = null;
    workspaces = [];
    selectedSpace = "";
    go("/login");
    notice("密码已更新，请重新登录。");
  });
  bindForm("#new-token", async (data) => {
    const result = await api("/tokens", {
      method: "POST",
      body: { ...data, days: Number(data.days) },
    });
    document.querySelector("#token-result").innerHTML =
      `<div class="token-display">请现在保存令牌，离开页面后将无法再次查看。<code>${esc(result.token)}</code><button class="btn small" id="copy-token">复制令牌</button></div>`;
    copyButton(result.token, "copy-token");
  });
  document.querySelectorAll("[data-revoke]").forEach(
    (b) =>
      (b.onclick = async () => {
        try {
          await api("/tokens/" + b.dataset.revoke, { method: "DELETE" });
          render();
          notice("令牌已撤销");
        } catch (e) {
          notice(e.message);
        }
      }),
  );
}
async function render() {
  if (booting) return;
  if (hasRendered) {
    navigation.abort();
    navigation = new AbortController();
    pendingReads.clear();
    primedReads.clear();
  }
  hasRendered = true;
  const version = ++routeVersion;
  const path = location.pathname;
  if (path === "/" || path === "/search")
    selectedSpace = new URLSearchParams(location.search).get("namespace") || "";
  document.title = "OneStorage · Code, together.";
  const titles = {
    tokens: "访问令牌",
    keys: "密钥与连接",
    commits: "提交",
    forge: "Git 工具",
    upstream: "同步与 Fork",
    issues: "Issues",
    merges: "合并请求",
    members: "成员",
    settings: "设置",
    "deploy-tokens": "部署令牌",
    packages: "包仓库",
    search: "搜索",
  };
  const segment = path.split("/").filter(Boolean).at(-1),
    title = titles[segment] || "项目";
  layout(
    loadingContent(title),
    title,
    path.startsWith("/settings/") ? segment : "repos",
  );
  primeRoute();
  try {
    if (path === "/login" || setup) {
      authPage();
      return;
    }
    if (path === "/new") {
      await newProject();
      return;
    }
    const helpers = {
      api,
      layout,
      repoLayout,
      esc,
      field,
      textarea,
      bindForm,
      notice,
      render,
      go,
      current: () => version === routeVersion,
      reloadSpaces,
      user,
      qr: () => import("./qr.js?v=9bb5494c3ba088b6"),
      markdown: applyMarkdown,
    };
    if (path === "/search") {
      await (await globalSearch()).searchPage(helpers);
      return;
    }
    if (path === "/login/oidc") {
      await (await oidc()).completeLogin(helpers);
      return;
    }
    if (path === "/login/recover") {
      (await account()).recoverPasswordPage(helpers);
      return;
    }
    if (path === "/admin/identity") {
      if (!user?.admin) throw Error("需要管理员权限");
      await (await oidc()).providerAdmin(helpers);
      return;
    }
    if (path === "/settings/account") {
      if (!user) return go("/login");
      await (await account()).securityPage(helpers);
      return;
    }
    if (path === "/settings/profile") {
      if (!user) return go("/login");
      await (await account()).profileSettings(helpers);
      return;
    }
    if (path === "/profile") {
      await (
        await account()
      ).profilePage(
        helpers,
        new URLSearchParams(location.search).get("user") ||
          user?.username ||
          "",
      );
      return;
    }
    if (path === "/notifications") {
      await (await collaboration()).notificationsPage(helpers);
      return;
    }
    if (path === "/admin/users") {
      if (!user?.admin) throw Error("需要管理员权限");
      await (await platform()).adminConsole(helpers, user);
      return;
    }
    if (/^\/spaces\/[^/]+\/deploy-tokens$/.test(path)) {
      if (!user) return go("/login");
      await (
        await deployTokens()
      ).deployTokensPage(helpers, { workspace: path.split("/")[2] });
      return;
    }
    if (/^\/spaces\/[^/]+\/ci\/variables$/.test(path)) {
      if (!user) return go("/login");
      await (
        await platform()
      ).workspaceVariablesPage(helpers, path.split("/")[2]);
      return;
    }
    if (path === "/spaces" || path.startsWith("/spaces/")) {
      if (!user) return go("/login");
      await (await platform()).spacesPage(helpers, path.split("/")[2]);
      return;
    }
    if (path === "/settings/keys") {
      if (!user) return go("/login");
      await keyPage(helpers);
      return;
    }
    if (path === "/settings/tokens") {
      await tokensPage(version);
      return;
    }
    if (path === "/") {
      await projects(version);
      return;
    }
    const parts = path.split("/").filter(Boolean);
    if (parts.length < 2) throw Error("页面不存在");
    const [namespace, name, tab, sub] = parts,
      base = `/${namespace}/${name}`,
      ap = "/repos" + base;
    const r = await api(ap);
    if (version !== routeVersion) return;
    const canonical = `/${r.namespace}/${encodeURIComponent(r.name)}`;
    if (base !== canonical) {
      history.replaceState(
        {},
        "",
        canonical + path.slice(base.length) + location.search,
      );
      return render();
    }
    document.title = `${r.namespace} / ${r.name} · OneStorage`;
    repoLayout(r, tab || "code", loadingContent(titles[tab] || "文件"));
    if (!tab) await codePage(r, base, ap, version);
    else if (tab === "packages")
      await (await packages()).packagePage(r, base, ap, helpers, sub);
    else if (tab === "ci")
      await (await platform()).ciPage(r, base, ap, helpers, sub);
    else if (
      ["protect", "planning", "releases", "wiki", "deployments"].includes(tab)
    )
      await (await collaboration()).projectPage(r, base, ap, helpers, tab, sub);
    else if (tab === "merges" && sub)
      await (await collaboration()).reviewPage(r, base, ap, helpers, sub);
    else if (tab === "forge") await forgePage(r, base, ap, helpers);
    else if (tab === "upstream") await upstreamPage(r, base, ap, helpers);
    else if (tab === "search") await searchPage(r, base, ap, version);
    else if (tab === "edit") await editPage(r, base, ap, version);
    else if (tab === "commits") await commitsPage(r, base, ap, version);
    else if (tab === "issues") {
      const issue = await issuesPage(r, base, ap, sub, version, helpers);
      if (sub && issue && version === routeVersion)
        await (await collaboration()).issuePlanning(r, ap, helpers, issue);
    } else if (tab === "merges") await mergesPage(r, base, ap, sub, version);
    else if (tab === "members") await membersPage(r, base, ap, version);
    else if (tab === "deploy-tokens")
      await (await deployTokens()).deployTokensPage(helpers, { r, base, ap });
    else if (tab === "settings") await settingsPage(r, base, ap, version);
    else throw Error("页面不存在");
    if (version === routeVersion)
      applyMarkdown({ base, ref: r.default_branch }).catch(() => {});
    if (version === routeVersion)
      (await collaboration()).social(r, ap, helpers).catch(() => {});
  } catch (e) {
    if (version !== routeVersion) return;
    layout(
      `<div class="error">${esc(e.message)}</div>${link("/", "返回项目列表", "btn")}`,
      "暂时无法打开",
    );
  }
}
layout(loadingContent("项目"));
primeRoute();
try {
  const state = await api("/bootstrap", { signal: AbortSignal.timeout(20000) });
  user = state.user;
  setup = state.required;
  if (user) reloadSpaces().catch(() => {});
  booting = false;
  await render();
} catch (e) {
  booting = false;
  layout(
    `<h1>暂时无法加载</h1><div class="error">${esc(e.message)}</div><button id="retry-start" class="btn primary">重试</button>`,
  );
  document.querySelector("#retry-start").onclick = () => location.reload();
}
