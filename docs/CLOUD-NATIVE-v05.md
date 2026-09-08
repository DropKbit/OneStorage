# OneStorage Cloudflare 原生协作平台（v0.5）

目标是尽可能覆盖 GitLab/Gogs 的实际使用流程，保持 Workers + JavaScript/WASM + R2 + Durable Objects，无容器。本版完成云端执行和协作闭环；下表明确可用能力与仍需继续开发的部分，不把某一版发布当成 GitLab 全量功能完成。

## 架构

- Git HTTP v0/v2、对象/pack/delta、合并和引用：JavaScript Workers + 每仓库 Durable Object。对象保存 R2，引用更新串行化并校验 CAS。
- 用户、团队、权限、Issue/MR、审阅、Wiki、运行记录：D1。
- 自动触发与执行：Durable Object 持久事件 → Queues → Worker → Dynamic Worker Loader；Cron 恢复未投递任务、回收超时租约。
- JS/WASM 测试代码：独立 Dynamic Worker，`globalOutbound: null`，无主服务绑定和凭据，CPU 上限 10 秒/步骤，默认 1 秒。
- 产物/应用版本：R2 不可变对象；D1 事务提交产物索引、版本和成功状态。取消/失效租约不能发布产物。
- 应用网关：独立 Worker `onestorage-apps`，在独立 workers.dev 域名运行。只读取显式公开且仓库未删除的激活版本。用户应用不在 Git 登录域名运行，不传 Cookie/Authorization，不向响应转发 Set-Cookie，页面使用 CSP sandbox。

## 使用云端 CI/CD

源码自带 `examples/cloud-native/` 可运行示例；保留目录结构，把 `pipeline.json` 内容粘贴进仓库 CI/CD 配置即可执行测试并生成静态预览版本。

在仓库提交 `ci.js` 和 `index.js`：

```js
// ci.js: Worker 原生 JavaScript，不能调用 /bin/sh、child_process 或本地 npm CLI。
import app from './index.js';
export default async ({ sha, ref, files, artifacts }) => {
  const response = await app.fetch(new Request('https://test.invalid/'));
  if (response.status !== 200) throw Error('Expected HTTP 200');
  return {
    logs: ['Test passed: ' + sha],
    artifacts: { 'report.json': JSON.stringify({ sha, ref, passed: true }) }
  };
};
```

```js
// index.js
export default { fetch() { return new Response('Hello from OneStorage'); } };
```

在仓库 CI/CD 页面保存：

```json
{
  "name": "Cloudflare test and deploy",
  "runner": "worker",
  "branches": ["main", "feature"],
  "timeout_seconds": 90,
  "steps": [{
    "type": "javascript",
    "entry": "ci.js",
    "files": ["ci.js", "index.js"],
    "cpu_ms": 1000
  }],
  "deploy": {
    "environment": "production",
    "kind": "worker",
    "entry": "index.js",
    "files": ["index.js"]
  }
}
```

推送所选分支或手动运行。成功后到「应用发布」激活版本；选择历史版本即回滚。显式激活/回滚的比较并更新避免覆盖另一维护者刚发布的版本。默认环境未公开，私有仓库发布应用也须显式选择公开。停止公开后网关返回 404。

`files` 显式指定固定提交中的源码，支持 JS ESM 和 `.wasm` 二进制模块，普通文件作为 text 模块；不自动下载 npm 依赖、不运行 install scripts。WASM 用 `import wasm from './module.wasm'` 后 `WebAssembly.instantiate(wasm)`。API 提交二进制文件使用 `{path, data: BASE64}`。输出 artifacts 是文件名 → 文本内容；后续步骤可读取 artifacts，部署 files 中同名产物优先于源码。可以在 JS 中生成静态页面，使用 `deploy.kind: "static"`、entry `index.html` 发布。

界限：源码最多 32 个文件、每个 1 MiB、总计 4 MiB；输出产物最多 10 个/总 2 MiB；部署包总 4 MiB。云端步骤只允许相对安全路径，保留内部 `__onestorage` 前缀。每次隔离执行请求 20 秒超时，整个 Worker 流水线最多 110 秒/10 步，实际还受 Cloudflare 账户限制。返回 logs 保存为有界文本；普通 console 输出在 Cloudflare Observability，本版网页以显式返回的 logs 为准。超时运行失败，需显式重试，避免重复部署。已安装的外部 Runner 协议保留，作为通用 OS 构建的可选路径。

## 代码审阅与保护

「分支保护」配置精确分支名称、批准人数、必须 MR、必须 CI。保护始终拒绝删除和强推；要求任一审阅条件时，普通 Git push、API 写入、网页编辑、直接 merge API、上游镜像都不能绕过 MR。规则在 DO 引用发布前读取，用户权限变更后的新请求重新授权。

MR 审阅绑定源和目标两个提交。分支更新后点击「更新到最新提交」，旧批准不再计数。批准必须来自作者以外的现有 developer/maintainer/owner，停用或移除成员的批准不计。最新非评论审阅是要求修改时阻止合并。CI 规则要求源提交最新创建的运行成功（D1 rowid 排序，避免同秒 UUID 排序误判）。支持快进、三方合并、强制合并提交及 squash；目标引用 CAS，DO 与引用一起记录 MR 结果，D1 状态写入失败可重试修复。

## 协作功能

- Issue 创建、讨论、编辑、关闭/重开；开发者给现有仓库成员指派、分配本仓库标签与里程碑；里程碑统计完成比例。
- 版本发布关联已有 Git 标签并固定提交 SHA；更新说明、预发布标记、源码归档下载。删除发布记录不删除 Git 标签。
- Wiki 创建、编辑、历史版本读取，乐观版本号防覆盖；数据库触发器在同一事务记录历史。
- 收藏、关注、站内通知；通知由审计事件创建，读取时再次检查仓库访问权限；目前列表最近 100 条，Wiki/标签/里程碑最近 200 条。
- 原有多空间、继承权限、管理员用户停用/恢复、空间所有权恢复、仓库管理及审计继续使用。

## 部署

```sh
npm ci
npm run db:remote
npm run deploy:apps
npm run deploy
```

主服务配置 `worker_loaders: [{ binding: "LOADER" }]` 和 `APPS_ORIGIN`。网关使用 `wrangler.apps.jsonc`，绑定同一 D1/R2 和 LOADER。开源自部署需替换两份配置中的账户资源与域名；平台不会复制本机 Wrangler OAuth 到任何仓库任务。

正式主站仍为 `git.1s.hk`，`1s.hk` Cubelink 保留。新增 0006 为增量 migration，先备份 D1，再 apply，随后部署。删除仓库时清理 `ci/<repo>/` 包括部署版本。网关每次检查 D1，仓库软删除即停止应用访问。

## 与 GitLab/Gogs 的持续差距清单

| 能力 | 状态 |
| --- | --- |
| HTTPS Git、pack/delta、LFS、分支、标签、提交、目录、编辑、diff/blame/search | 已有并回归验收 |
| 团队空间、继承角色、管理员、用户停用、审计、PAT/JWT、签名提交 | 已有并回归验收 |
| 固定提交 JS/WASM 云端 CI、队列触发、日志、产物、应用发布和回滚 | v0.5 已实现，本地与生产验收通过 |
| MR 批准/要求修改、源/目标版本、CI 门禁、受保护分支 | v0.5 已实现，本地与生产验收通过 |
| Issue 标签/里程碑/指派、发布、Wiki 历史、收藏/关注/通知 | v0.5 已实现，本地与生产验收通过 |
| 跨 Fork MR、行级讨论/解决、代码所有者、合并队列、自动关闭 Issue | v0.7 实现跨 Fork 和行级讨论；v0.8 增加 CODEOWNERS 与默认分支合并自动关闭 Issue；合并队列待开发 |
| 富文本 Markdown、图片/PDF/Notebook 预览、个人资料与活动页 | v0.6 实现 Markdown、栅格图片、资料与活动；PDF/Notebook 待开发 |
| 2FA、OAuth/OIDC、Cloudflare Access 登录、注册/找回、细粒度 deploy token | v0.6 实现 TOTP/恢复码/会话管理；其余待开发 |
| 项目转移/归档、跨项目搜索、Issue 看板/筛选/批量操作、Wiki 迁移 | v0.9 实现项目 Issue 筛选/分页、标签看板、事务批量操作；v0.10 实现可恢复归档及写入/CI 屏障；v0.11 实现项目转移/重命名与旧路径授权；跨项目搜索和 Wiki 迁移待开发 |
| 仓库流水线配置、DAG/并行任务/调度、缓存、变量/密钥、npm/TS 构建 | 仍待开发 |
| 包仓库、镜像仓库、扫描/质量报告、完整 GitLab YAML/API 兼容 | 仍待开发，不能宣称兼容 |
| 持久化可达索引、流式 pack、大仓库增量验证 | 当前仍有 5000 对象图、32 MiB 展开预算；更大仓库支持待实现 |
| 原生 SSH 入站、POSIX/Linux 任意构建 | 当前无容器 Workers 架构不提供此执行模型；HTTPS Git 和 JS/WASM 可用 |

参考：[Gogs 功能](https://github.com/gogs/gogs#-features)、[GitLab Merge requests](https://docs.gitlab.com/user/project/merge_requests/)、[Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/getting-started/)、[资源限制](https://developers.cloudflare.com/dynamic-workers/usage/limits/)、[Workers TCP](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)。上述状态是 OneStorage 实现检查，并非上游项目的兼容性认证。
