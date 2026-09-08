# OneStorage v0.4：协作空间与 CI/CD

**简体中文** · [English](en/PLATFORM-v04.md)

## 目标与验收

- 代码高亮：本地打包 Highlight.js，按需加载；常用 16 种语言、行号、HTML 转义；未知格式与超过 200,000 字符的文件退回纯文本。
- 多空间：个人空间保留现有 Git URL；创建团队空间、空间列表/切换、按空间筛选/创建项目、修改空间信息与成员管理。
- 权限：空间角色继承到仓库；独立仓库成员权限可增加访问能力。移出空间的仓库创建者不会保留隐含所有权。API、Git HTTPS、LFS 与 CI 逐次校验。
- 管理后台：用户列表/创建、提权/降权、停用/启用、重设密码、撤销会话；空间所有权恢复；仓库目录/描述/可见性/删除；审计列表。
- CI/CD：推送普通分支触发、手动启动、按提交固定源码、运行历史/状态/日志/产物、取消/重试、仓库专属 Runner、Worker 内检查和外部通用构建/Cloudflare 部署。

## 权限模型

| 角色              | 读取 | 推送/创建空间项目 | 仓库设置、流水线、Runner | 分配空间角色 |
| ----------------- | ---- | ----------------- | ------------------------ | ------------ |
| 只读 reader       | 是   | 否                | 否                       | 否           |
| 开发者 developer  | 是   | 是                | 否                       | 否           |
| 维护者 maintainer | 是   | 是                | 是                       | 否           |
| 所有者 owner      | 是   | 是                | 是                       | 是           |

仓库单独授权与空间继承取较高角色，撤销其中一项不会移除另一项授予的权限。空间始终保留至少一位所有者；实例始终保留一位活跃管理员。用户名和团队空间标识共享唯一命名空间。空间标识创建后固定，避免破坏 Git URL。空团队空间可通过 `DELETE /api/workspaces/:slug` 删除；包含已删除但尚未清理仓库的空间须等待对象回收（首次清理约在删除后 60 秒）。

管理员可管理实例元数据并显式恢复空间所有权（写审计），不会因为 admin 标志就自动读取所有私有代码。停用会立即阻止密码登录、PAT、会话和委托 JWT，撤销会话可同时清除该用户 PAT。后台不展示密码、令牌哈希或上游密钥。

## CI/CD 配置

进入项目的 **CI/CD** 页面，选用模板、编辑 JSON 并保存。配置由维护者保存于 D1，每个运行记录复制配置并固定 SHA；仓库中普通文件不能直接覆盖流水线定义。`branches` 为允许自动触发的精确分支名；临时命名空间、标签和分支删除不触发。手动运行与重试需要维护者权限；关闭“推送自动触发”不会禁止手动运行。

```json
{
  "name": "Build and deploy",
  "runner": "external",
  "branches": ["main"],
  "timeout_seconds": 900,
  "steps": [
    { "type": "run", "name": "Install", "command": "npm ci" },
    { "type": "run", "name": "Test", "command": "npm test" },
    { "type": "run", "name": "Deploy", "command": "npx wrangler deploy" }
  ],
  "artifacts": ["dist/report.json"]
}
```

每个命令在独立 checkout 中使用 `/bin/sh -eu` 执行，共享本次运行工作目录；失败停止后续步骤。目标项目必须包含自己的 Wrangler 配置与测试脚本。`artifacts` 是构建产生的文件清单，不是目录/glob；不需要产物时使用空数组。默认模板不会替你创建远程 Cloudflare 项目或注入密钥。

### 启动通用 Runner

1. 在 CI/CD 页面注册仓库 Runner，将只显示一次的令牌保存到专用主机上的文件，权限设为 `600`。
2. 在该主机取得 OneStorage 源码并 `npm ci`，安装目标构建需要的 Node/npm、编译器等工具。Runner 支持 POSIX 主机。
3. 配置目标 Cloudflare 账户的部署凭证，启动：

```sh
export ONESTORAGE_ORIGIN=https://git.1s.hk
export ONESTORAGE_RUNNER_TOKEN_FILE=/secure/onestorage-runner-token
export ONESTORAGE_JOB_ENV=CLOUDFLARE_API_TOKEN,CLOUDFLARE_ACCOUNT_ID
# CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID 由主机的密钥管理提供
node scripts/runner.mjs
```

`ONESTORAGE_JOB_ENV` 明确列出允许传给构建进程的环境变量；默认只传 PATH、全新 HOME、CI、ONESTORAGE_COMMIT_SHA 和 ONESTORAGE_REF。令牌文件路径与 Runner 令牌不作为构建环境变量传递。部署凭证留在执行主机，按允许列表传给构建。日志会遮盖已知令牌和显式传入环境变量中至少四字符的值，包括跨输出块的原始密钥；这是意外泄漏防护，不能阻止恶意代码编码或外传密钥。

**Runner 会执行仓库代码，必须运行在信任该仓库的专用账户/主机上。** 独立目录、环境变量筛选和日志遮盖不构成 OS 沙箱。服务端及 Worker 检查不使用容器，外部 Runner 也没有容器依赖。不要把不可信的多租户仓库接到共享部署主机。当前源码提取拒绝符号链接/设备文件，产物不可越出 checkout；含符号链接的项目需调整流水线输入或自行实现 Runner 协议。

Cloudflare 官方外部 CI 文档说明了 [Wrangler 部署与账户令牌配置](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)。生产长期 Runner 的进程守护、目标部署凭证和目标项目配置由操作者提供；功能验收不等于已经替用户开通永久构建主机。

### Worker 检查

无需 Runner，可运行固定内置检查：

```json
{
  "name": "Repository checks",
  "runner": "worker",
  "branches": ["main"],
  "steps": [{ "type": "file", "path": "package.json", "format": "json" }],
  "artifacts": []
}
```

`file` 支持 `exists` 与 `json`；`http` 支持 `url` 和预期 `status`，必须由运营者在 `CI_ALLOWED_HOSTS` 中允许目标 HTTPS 主机，不跟随跳转，不携带部署密钥。Worker 不解释仓库脚本，不在主 Worker 中 eval 任意代码。

## 执行可靠性与限制

运行状态为 queued/running/succeeded/failed/canceled。D1 原子领取保证重复 Queue 消息或两个 Runner 不会领取同一运行。120 秒租约、15 秒 Runner 心跳；Cron 回收超时租约并重发待执行 Worker 检查。Queue 发布失败后保留 D1 记录。失联标为失败，必须显式重试，避免部署重复执行。取消撤销租约，拒绝后续源码、日志、产物和完成请求；Runner 在下一次心跳终止进程组，已发生的外部部署不会自动回滚。

每仓库最多 20 个排队/运行任务、10 个 Runner；每运行最多 20 步（Worker 10 步）、10 个产物、每文件 16 MiB；日志最多 256 × 4096 字符。Runner 拉取压缩源码最多 128 MiB，解压后最多 256 MiB。Worker 读取文件沿用网页 1 MiB 限制。外部运行超时 10–3600 秒；Worker 检查最长约 110 秒。暂未实现 DAG 并行 jobs、定时流水线、GitLab YAML 兼容、缓存依赖或部署回滚。日志和产物需要仓库成员权限，不随公开仓库代码匿名公开。

API 索引：`/api/workspaces`、`/api/workspaces/:slug/members`、`/api/admin/*`、`/api/repos/:namespace/:repo/ci/{config,runs,runners}`。Runner 使用 `/api/runner/claim` 和 `/api/runner/runs/:id/{heartbeat,source,logs,artifacts/:name,complete}`；Authorization 为仓库 Runner 令牌，领取后请求额外携带 `X-Run-Lease`。浏览器使用会话；空间/后台/CI 不接受委托 JWT。

## 部署

先导出 D1 备份，再执行 `npm run db:remote` 应用 `0005_workspaces_ci.sql`，最后 `npm run deploy`。不改现有仓库 URL，不重建 R2 或 Durable Objects。公共资源缓存与按需高亮沿用 v0.3.1 内容哈希策略。`public/THIRD_PARTY_LICENSES.txt` 随源码提供 Highlight.js 许可证。
