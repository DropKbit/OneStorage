# OneStorage

v0.29 将原生 Git 审计与引用一起持久化，去除提交后的 D1 审计依赖，支持可重试、去重的异步审计，并保持大批引用更新的原子性。已确认的修复路径与历史 500 的证据边界见 [Git 提交与审计](docs/GIT-RECEIPTS-v29.md) 和 [验收记录](docs/VERIFICATION-v29.md)。

v0.28 增加跨项目协作搜索：项目、Issue、合并请求和当前 Wiki 统一检索，支持空间/状态/归档筛选、稳定分页与实时权限校验，见 [使用说明](docs/SEARCH-v28.md) 和 [验收记录](docs/VERIFICATION-v28.md)。全局代码索引仍待实现，现有项目内代码搜索保留。

v0.27 支持当前实例内的私有 npm 依赖原生云构建：显式部署令牌授权、锁文件与 SHA-512 校验、独立 WASM 编译、工作流依赖撤权门禁，见 [私有包构建](docs/CI-PRIVATE-PACKAGES-v27.md) 和 [本地/生产验收](docs/VERIFICATION-v27.md)。

v0.26 增加项目/空间部署令牌：独立 Git 只读、包读取/发布/撤回权限，支持轮换、到期与撤销，跨空间转移自动收回范围，见 [部署令牌](docs/DEPLOY-TOKENS-v26.md) 和 [本地/生产验收](docs/VERIFICATION-v26.md)。

v0.24 增加空间级 CI 变量与密钥继承、项目覆盖、只读继承展示和跨项目撤销，空间所有者可集中管理团队构建配置，见 [空间变量](docs/CI-WORKSPACE-VARIABLES-v24.md)。

v0.23 增加管理员配置的 OIDC 统一登录、账户关联、无密码账户注册、本地双因素校验及提供方会话/PAT 撤销，见 [统一登录](docs/OIDC-v23.md)。身份验证和状态管理运行在 Workers 与 D1，实际提供方由管理员配置。

v0.22 增加 Cloudflare 内的 TypeScript/TSX、锁定 npm 依赖与 JS/CSS 构建，可生成 R2 产物并发布/回滚应用，见 [云端构建](docs/CI-BUILDS-v22.md)。编译使用独立 Worker 和 WASM，不运行 shell 或 npm 生命周期脚本。R2 共享缓存见 [CI 缓存](docs/CI-CACHES-v21.md)。

v0.15 增加有界 Git 对象暂态恢复、失败阶段诊断及并发写入验收，见 [Git 可靠性](docs/GIT-RELIABILITY-v15.md)。v0.14 的版本化配置和依赖工作流见 [CI/CD](docs/CI-WORKFLOWS-v14.md)。完整 GitLab/Gogs 目标和剩余工作见 [开发路线](docs/ROADMAP.md)。

v0.13 为 Git 下载增加按已验证对象大小控制的四路预取，保持 8 MiB 预留预算、背压与取消排空，见 [预取契约及验证](docs/GIT-PREFETCH-v13.md)。v0.12 的持久 Git 闭包索引、流式下载与浏览器修复见 [大仓库边界](docs/GIT-SCALE-v12.md) 和 [验收记录](docs/VERIFICATION-v12.md)。

v0.11 增加项目转移与重命名，保留项目 UUID 与代码/协作历史，重新计算空间权限并保护旧地址与在途写入。见 [转移契约](docs/TRANSFER-v11.md) 和 [验收记录](docs/VERIFICATION-v11.md)。

项目归档（v0.10）：所有者可在设置中归档/恢复，冻结 Git/LFS/协作内容与流水线写入，保留读取和已有应用。详见 [归档契约](docs/ARCHIVE-v10.md) 与 [验证记录](docs/VERIFICATION-v10.md)。

v0.9 增加 Issue 筛选与分页、标签看板、批量操作和并发编辑保护，见 [Issue 工作流](docs/ISSUES-v09.md) 和 [验证记录](docs/VERIFICATION-v09.md)。

v0.8 增加 CODEOWNERS 门禁、默认分支合并关闭 Issue、R2 双路并发与读取去重，见 [使用说明](docs/REVIEWS-v08.md) 和 [验收记录](docs/VERIFICATION-v08.md)。

v0.7 增加跨 Fork 合并请求、行级讨论与解决门禁、固定快照的目标仓库 CI，见 [审阅说明](docs/REVIEWS-v07.md) 和 [验收记录](docs/VERIFICATION-v07.md)；v0.13 补全创建表单、来源切换、讨论分页及审阅到实际合并的 headless Chromium 验收。

v0.6 新增双重验证、会话管理、个人资料/活动、Markdown 与私有图片预览，见 [账户与展示说明](docs/ACCOUNT-v06.md) 与 [验收记录](docs/VERIFICATION-v06.md)。完整 GitLab/Gogs 目标仍持续推进。

**自己的代码，自己的空间。** 基于 Cloudflare Workers 的开源 Git 服务，部署于 **[git.1s.hk](https://git.1s.hk)**。AGPL-3.0-only，**v0.27.0 alpha**。

参考 [Code Storage 文档](https://code.storage/docs/) 独立实现，并提供 GitLab 风格的中文协作界面。此次对照涵盖 **40 个首选 REST 操作和 11 类跨接口能力**；逐项差异、实现和验证证据见 [开发目标](docs/ROADMAP.md) 与 [功能矩阵](docs/parity.json)。不承诺第三方 SDK 直接兼容或相同的容量、性能和 SLA。

新增 **代码高亮、多工作空间、角色权限、管理员后台与 CI/CD**。使用说明和通用 Runner / Cloudflare 部署配置见 [平台指南](docs/PLATFORM-v04.md)。

页面加载与缓存改进、线上测量见 [性能记录](docs/PERFORMANCE.md)。

新增 Cloudflare 原生 JS/WASM CI、应用发布/回滚、受保护分支和审阅门禁、Issue 规划、版本发布、Wiki 与通知。见 [v0.5 使用说明及持续差距](docs/CLOUD-NATIVE-v05.md)。

## 完全无容器

Git 对象、packfile、delta、HTTPS 协议、diff、merge 与签名验证运行在 Workers JavaScript 中。Web Crypto 提供散列与密码学，pako 提供 zlib；无需 WASM 模块、服务端 Git、Docker 或外部计算服务器。

- **Workers / Static Assets**：网页、鉴权、REST API、MCP。
- **R2**：仓库隔离的不可变 Git 对象、LFS 内容。
- **Durable Objects**：仓库串行协调、原子 refs 与 Git 事件、隔离临时引用、删除清理。
- **D1**：账号、成员、Issues、合并请求、加密上游凭证、同步任务和投递状态。
- **Queues + Cron + DO alarms**：同步、Webhook、失败重试和恢复。

## 功能

- 原生 Git HTTPS clone/fetch/push，协议 v0/v2，OFS/REF/thin-pack，分支、标签、Notes、二进制、执行位和符号链接。
- 私有/公开仓库、分组名称、默认分支、独立 fork、异步删除清理、UUID 到 URL。
- 会话/PAT、ES256/384/512/RS256 委托 JWT、独立 scope、引用策略、SSH/OpenPGP 提交验签与公钥撤销。
- `+ephemeral` 临时远程、`+import` 导入远程，临时分支与普通分支互相基于/合并。
- 流式文件提交、原生 Git 文本/二进制 patch、恢复提交、三方合并预览/冲突/squash、按行 diff、历史、blame、RE2 检索。
- 原始文件 GET/HEAD、条件请求与 Range；过滤 tar.gz 归档；Git LFS basic transfer。
- GitHub 公共仓库导入；普通 HTTPS Git 双向同步；GitHub App 安装令牌、签名 webhook、LFS 透传缓存。
- TypeScript、Python、Go SDK；MCP、OpenAPI、七类 Agent 工作流示例。
- 保留成员权限、Issues/评论、固定 SHA 的快进合并请求、审计与签名 Webhook。

## 本地运行

Node.js 22.13+。原生 Git/tar 仅用于测试。

```sh
npm ci
npm run dev
```

打开 [localhost:8787](http://localhost:8787)，首次初始化密钥为 `local-development-only-change-me`，密码至少 12 字符。开发命令自动应用本地 D1 迁移，状态保存在 `.wrangler/`。生产不得使用本地配置或测试密钥。

```sh
git clone http://localhost:8787/owner/project.git
# HTTP Basic 密码使用 PAT，不是账号密码
```

## 部署与验证

遵循 [部署指南](docs/DEPLOYMENT.md)，配置资源和私有 secrets 后执行迁移及发布。当前实例只使用 `git.1s.hk`，保留 `1s.hk` 的 Cubelink。

```sh
npm run check
npm run test:parity
npm run build:production
npm run build:compiler
npm run db:remote
npm run deploy:build
npm run deploy
```

`deploy` 自动生成 `/source.tar.gz` 和 `/openapi.json`，源码打包使用明确白名单，排除本地数据、环境文件和密钥。完整本地验收另需保持 `npm run dev` 运行：

```sh
npm run test:e2e
npm run test:features
npm run test:git-features
# Python: pip install -e ./sdk/python；Go >=1.24
PYTHON_BINARY=python3 GO_BINARY=go npm run test:sdks
npm run test:sync  # 联网读取公共 GitHub 测试仓库
```

E2E 仅运行于 localhost，默认 `owner` / `local-test-password-123`；可通过 `TEST_ADMIN_USERNAME` / `TEST_ADMIN_PASSWORD` 指定本地账号。测试证据及未验证事项见 [验证记录](docs/VERIFICATION.md)。

## 实际边界

| 项目                        | 上限/语义                                                |
| --------------------------- | -------------------------------------------------------- |
| 单 Git 对象 / LFS 文件      | 8 MiB / 16 MiB                                           |
| 入站 / 流式出站 pack        | 64 MiB、25,000 对象 / 512 MiB、100,000 对象              |
| 请求对象缓存 / 原生入站展开 | 8 MiB LRU / 256 MiB 总量，R2 暂存，另有临时缓冲区        |
| Git 索引遍历 / 引用 / 深度  | 100,000 / 256 / 64；其他历史/目录算法仍有独立 5,000 预算 |
| NDJSON 提交                 | 48 MiB 传输、32 MiB 解码、每块 4 MiB、每行 6 MiB         |
| Diff / 搜索输出             | 4 MiB；搜索另有计算预算                                  |
| 活跃仓库不可达对象          | 保留；删除整个仓库才异步清理                             |

v0.12 使用仓库 DO 的持久化对象闭包索引和流式 pack；已验证历史不再反复读取 R2，新公共提交协商避免增量 fetch 重传历史。输出 pack 未做 delta 压缩，冷克隆仍逐对象读取 R2；平台 CPU/内存/子请求限制可能先触发。v0.16 已加入原生入站流式接收和 R2 临时块；正式对象写入、冷克隆吞吐、大 Fork 与其他历史算法仍需扩展，见 [入站验证与边界](docs/GIT-RECEIVE-v16.md)。没有 TB 级测试、总存储配额、跨服务一致备份或生产 SLA。

三方合并对多 merge-base 的 criss-cross 历史返回明确冲突；重命名检测保守且有限额。Blame 支持行/正则/函数范围及移动/复制块，但不复现全部 Git 语言驱动。公共 GitHub 是手动单向同步；通用上游不支持 LFS，GitHub App 的 LFS 限 16 MiB。私有 GitHub App 需要操作者提供真实安装信息，验证记录区分模拟提供方测试与实际联网测试。

没有 SSH 传输、SHA-256 Git 仓库、shallow/partial clone 或完整 GitLab API。多工作空间、OIDC 统一登录、原生 JS/WASM CI 和可选外部 Runner 已提供，支持范围见对应文档。SSH **提交签名**与 SSH **传输**是不同能力，前者已实现。

## 文档

[API](docs/API.md) · [SDK](docs/SDK.md) · [架构](docs/ARCHITECTURE.md) · [部署与恢复](docs/DEPLOYMENT.md) · [安全](SECURITY.md) · [贡献](CONTRIBUTING.md) · [示例](examples/README.md)

Copyright © 2026 OneStorage contributors. [AGPL-3.0-only](LICENSE)。修改部署时请向交互用户提供相应源代码。与 Code Storage、GitLab、Cloudflare 无隶属关系。

原生 Git 首次导入使用 R2 隔离区、流式 pack 校验与 DO 引用发布，见 [v0.16 入站设计与验证](docs/GIT-RECEIVE-v16.md)。旧上游解析器、Fork 和非原生 API 保留各自预算。

## v0.25 项目包仓库

新增真实 npm 与通用文件仓库：原生 publish/install/dist-tag/unpublish、作用域名称、R2 文件与完整性校验、当前项目权限、不可覆盖版本、异步回收和网页管理。用法、CI 接入及限制见 [包仓库](docs/PACKAGES-v25.md)，本地和生产测试见 [验收记录](docs/VERIFICATION-v25.md)。完整平台目标仍持续推进。
