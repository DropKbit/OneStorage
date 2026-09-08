# OneStorage

**自己的代码，自己的空间。** 基于 Cloudflare 的开源、自托管 Git 协作服务，部署域名 **git.1s.hk**。

Inspired by [code.storage](https://code.storage/), with a GitLab-style collaboration interface. Independent implementation, **AGPL-3.0-only**. Version **0.2.0 alpha** targets small repositories; it does not claim GitLab feature parity or code.storage-scale performance.

## 无容器架构

Git 对象、packfile、delta 解码和 smart HTTP 协议全部由 Workers 内的 TypeScript/JavaScript 实现；使用 Web Crypto 计算 SHA-1，pako 处理 zlib。服务端不需要 Docker、原生 Git、Node 子进程或外部服务器，也没有 WASM 二进制依赖。

- **Workers / Static Assets**：鉴权、API、中文协作界面。
- **R2**：按仓库隔离、按对象 ID 寻址的不可变 Git 对象，以及 LFS 文件。
- **Durable Objects**：每仓库串行协调；R2 对象写入成功后，以一次持久化写入原子发布全部 refs。
- **D1**：账号、权限、Issues、合并请求、审计和 Webhook outbox。
- **Queues + Cron**：签名 Webhook 投递、重试及补发。

## 已实现

- 原生 Git HTTPS clone / fetch / push；协议 v0 / v2、OFS_DELTA / REF_DELTA / thin-pack 输入、分块 HTTP、分支、轻量/附注标签。
- 私有/公开仓库，Owner / Maintainer / Developer / Reader 权限。
- 密码登录、会话 Cookie、只读/可写 PAT、撤销、修改密码后撤销全部凭证。
- 项目搜索、文件树、在线编辑、提交历史、文本代码搜索。
- Issues、评论和状态变更；固定 SHA 审阅与 fast-forward 合并请求。
- Git LFS basic transfer，SHA-256 校验、仓库级隔离。
- Webhook API、HMAC 签名、持久 outbox、投递记录。
- 无依赖 TypeScript SDK，旧 v0.1 tar 快照自动导入。

## 本地运行

需要 **Node.js 22.13+** 和 npm。原生 Git 和 tar 只用于兼容性测试，不参与服务运行。

```sh
npm ci
npm run dev
```

打开 [http://localhost:8787](http://localhost:8787)，创建管理员：初始化密钥为 `local-development-only-change-me`（仅限本地），用户名自选，例如 `owner`，密码至少 12 字符。`admin` 等路由名称不能作为用户名。

开发命令自动应用本地 D1 迁移，只启动 Wrangler/workerd。D1、R2、DO 状态保存在 `.wrangler/`。创建项目和访问令牌后：

```sh
git clone http://localhost:8787/owner/my-project.git
# HTTP Basic 用户名：账号名；密码：PAT，不是登录密码
```

空仓库也可点击“创建 README”，直接生成真实 Git 提交。

## 部署

参见 [部署指南](docs/DEPLOYMENT.md)。生产配置使用 `git.1s.hk`、D1、R2、Durable Objects 和 Queues，**不包含 Containers**。`1s.hk` 的 Cubelink 不受影响。其他操作者应替换资源名、D1 UUID 和域名。

```sh
npm run check
npm run build:production
npm run db:remote
npm run deploy
```

首次部署须先按指南创建资源并设置私有初始化密钥。源码不包含生产密钥。部署前自动生成 `/source.tar.gz`，页面提供本版本完整源代码下载；打包使用明确的文件白名单，不包含本地状态和密钥。

## 验证

```sh
npm run check             # TypeScript + Git 协议/持久化/安全/Webhook 测试
npm run test:e2e          # 另一个终端保持 npm run dev 运行
npm run build:production # 完整 Worker 打包检查
```

E2E 仅允许 localhost，创建 `e2e_` 测试项目/用户。未初始化的本地实例使用 `owner` / `local-test-password-123`；已自行初始化时通过 `TEST_ADMIN_USERNAME` / `TEST_ADMIN_PASSWORD` 指定本地账号。测试数据保留供检查，不能迁移至生产。实际验证结果见 [验证记录](docs/VERIFICATION.md)。

## 当前边界

| 项目                          | 上限/策略                             |
| ----------------------------- | ------------------------------------- |
| 单 Git 对象                   | 解压后 8 MiB                          |
| 单次 push / 输出 pack         | 16 MiB；push 上限包含协议头           |
| 请求内对象缓存、pack 解压预算 | 各 32 MiB，存在额外临时缓冲区         |
| 入站 pack 对象数              | 2,000                                 |
| 单次对象图遍历                | 5,000；fetch 会检查全部 refs 的可达图 |
| 分支与标签合计                | 256                                   |
| Delta / 标签链 / API 目录深度 | 64                                    |
| LFS 单文件                    | 16 MiB                                |
| 浏览/编辑单文件               | 1 MiB                                 |

输出 pack 使用完整对象加 zlib，尚未进行 delta 压缩；每次操作可能逐个读取多个 R2 对象，因此延迟和成本随历史增长。运行平台的 CPU、内存和子请求上限仍可能先于上述预算触发。没有总存储配额或自动 GC；失败写入的不可达对象会保留。

未实现 SSH、SHA-256 Git 仓库、shallow clone、partial clone/filter、强制改写历史、组织/SSO、CI Runner、复杂合并/审批、完整 GitLab API、生产规模性能验证或一键灾难恢复。Diff 当前按整个文件生成替换块，尚非最小行差异算法。

## 文档与许可证

[架构](docs/ARCHITECTURE.md) · [部署与恢复](docs/DEPLOYMENT.md) · [API / SDK](docs/API.md) · [安全](SECURITY.md) · [贡献](CONTRIBUTING.md) · [验证](docs/VERIFICATION.md)

Copyright © 2026 OneStorage contributors. [GNU Affero General Public License v3.0 only](LICENSE). 部署修改版本时，请按许可证向交互用户提供相应源代码。OneStorage 与 code.storage、GitLab 或 Cloudflare 不存在隶属关系。
