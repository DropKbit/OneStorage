# 部署 OneStorage

## 当前实例

规范地址为 **https://git.1s.hk**；`1s.hk` 继续提供 Cubelink。独立 Worker 地址为 `https://onestorage.xbitfun.workers.dev`，浏览器登录和 LFS 应使用规范地址，以匹配 APP_ORIGIN。

资源：Worker `onestorage`、私有编译 Worker `onestorage-build`、D1 `onestorage`、R2 `onestorage-objects`、Queue `onestorage-events`、SQLite Durable Object 类 `Repository`。应用由独立 `onestorage-apps` 网关提供。没有 Containers、Docker 镜像或外部 Git 服务器。

首次初始化通过网页完成，用户名和密码由操作者选择。初始化 secret 存放在本机被 Git 忽略的 `.data/production-bootstrap-secret.txt`（权限 0600），同时保存在 Worker secret 中。不要将它加入源码或公开发送。成功创建管理员后，D1 会锁定初始化，可删除云端 BOOTSTRAP_SECRET。

## 从源码部署新的实例

需要 Cloudflare 账号、Workers、D1、R2、SQLite Durable Objects、Queues 可用，并有对应额度；Node.js 22.13+ 和 npm。无需 Docker 或服务端 Git。资源使用会产生相应费用，配额取决于账号计划。

```sh
npm ci
npx wrangler login
npx wrangler whoami
npx wrangler d1 create onestorage
npx wrangler r2 bucket create onestorage-objects
npx wrangler queues create onestorage-events
```

这些 create 命令仅用于新实例；当前实例的资源已存在，不能重复创建。将返回的数据库 UUID 填入 `wrangler.jsonc`，资源同名冲突时选择独立名称。替换 APP_ORIGIN 及自定义域名 route，不能覆盖其他服务。若仅使用 workers.dev，移除 routes 并将 APP_ORIGIN 改为实际 Worker URL。逻辑 binding 名 `DB`、`OBJECTS`、`REPOSITORIES`、`EVENTS` 保持不变。

```sh
npm run check
npm run build:production
npm run build:compiler
npm run db:remote
npm run deploy:build
npm run deploy
npx wrangler secret put BOOTSTRAP_SECRET
npx wrangler secret put CREDENTIAL_ENCRYPTION_KEY
```

先部署编译 Worker，再部署主 Worker；主配置的 `BUILDER` 服务名必须与 `wrangler.build.jsonc` 的 Worker 名一致。编译 Worker 无存储/密钥绑定，禁用 workers.dev 和预览 URL。升级它无需 D1 迁移。详见 [云端构建](CI-BUILDS-v22.md)。

若使用应用发布，另外配置 `wrangler.apps.jsonc` 的 D1/R2 为本实例资源，保留 `LOADER`，运行 `npm run deploy:apps`，再把主 Worker 的 `APPS_ORIGIN` 设置为返回的独立应用域名并发布主 Worker。应用域名须与 Git 登录域名分开。

`deploy` 与打包命令会先从明确的源码目录生成 `public/source.tar.gz`，通过页面提供 AGPL 源码下载。不要将私有文件放入这些源码目录；`.data`、`.wrangler` 和环境密钥文件不在打包白名单。

为 BOOTSTRAP_SECRET 使用至少 32 字节的随机值，在 Wrangler 提示中输入。未配置密钥时初始化接口拒绝创建账号，不会开放无密钥注册。生产不能使用 `wrangler.local.jsonc`；它含公开的本地测试密钥。不要导入本地 `.wrangler` 数据。

访问 `/api/health`，确认 HTTPS 与静态页面可用，然后初始化管理员、创建私有验收项目和临时 PAT，执行真实 push、clone、fetch、merge 与 LFS。验证后撤销验收凭证。公开 DNS 和本地负缓存传播可能有时间差；不要为排查 DNS 而关闭 TLS 校验。

## 更新和 v0.1 迁移

v0.24 升级先应用 `0019_workspace_ci_variables.sql`，再发布主 Worker；无需部署其他 Worker。原项目变量及运行快照保持兼容，共享值使用原加密密钥和独立空间作用域。详见 [空间变量](CI-WORKSPACE-VARIABLES-v24.md)。

v0.23 升级先应用 `0018_oidc.sql`，再发布主 Worker；应用网关和编译 Worker 无需随本次升级重新部署。现有密码与会话保持兼容，必须保留 `CREDENTIAL_ENCRYPTION_KEY`。管理员在 `/admin/identity` 配置自己的 OIDC 应用，回调为 APP_ORIGIN 加 `/api/auth/oidc/callback`；详见 [统一登录与迁移](OIDC-v23.md)。测试用提供方不作为默认生产登录方式保留。

保持 Worker 名、DO 类名、migration 历史、D1 UUID 和仓库 UUID 映射稳定。先备份并在独立环境验证，再应用新的编号 SQL migration 和部署。当前配置首次部署即为 v0.2，不存在旧远程 Container 类。若你曾独立部署旧版，须保留已应用的 DO migration 记录，并制定旧 Container 类的退役 migration；不能直接重写历史。

旧 `snapshot` 指针存在、`refs.v2` 尚不存在时，首次请求会在 Worker 内解析 tar，导入 Git 对象到 R2，再原子提交 refs。兼容 macOS AppleDouble 元数据。旧快照不会被删，但迁移后的新写入不会同步回旧快照，因此直接回滚旧引擎会丢失新版本可见的更新。超出新引擎预算的旧仓库需要离线迁移方案；不要初始化空仓库掩盖导入失败。

## Webhook

默认 `WEBHOOK_ALLOWED_HOSTS` 为空，不对外投递。操作者可配置逗号分隔的可信 HTTPS 接收端主机名，例如 `build.example.net,hooks.example.net`。接收端必须由你信任和管理，不使用任意租户可控 DNS 或内部地址。

维护者通过 API 创建 `{url}`，得到一次性显示的签名 secret。事件仅包含事件名、仓库 UUID、actor、detail 和时间，不含代码或凭证。操作记录与 outbox 在 D1 同一 batch；Queue 调用失败由五分钟 Cron 补发。投递最多五次，失败状态可通过 deliveries API 查询。接收端校验时间戳/HMAC，并以 `X-OneStorage-Delivery` 去重。

Git ref 与 push 事件现在在 DO 中原子写入，再由 alarm 幂等投影至 D1 outbox。接收端仍需处理重复/延迟，并定期比较 refs；协作元数据与 Git 不是分布式事务。

## 运行与成本

- APP_ORIGIN 必须与浏览器规范地址一致，影响 Cookie 写操作和 LFS action URL。
- 每仓库一个 DO，最多 16 个请求排队；操作串行执行。没有 Container 实例数/启动延迟。
- R2 逐对象保存 canonical 数据；传输时重新生成 pack。每次请求的 R2 读取数量和历史大小会影响延迟与成本。
- 应用限额见 README；Worker/DO CPU、内存、子请求等平台限额仍独立生效。大仓库尚不适用。
- 删除整个仓库会通过 DO alarm 清理对象；活跃仓库没有不可达对象 GC 或总存储配额。
- 监控 Worker 错误、DO 请求饱和、R2 用量和缺失对象、D1/Queue 失败。不要把成功健康检查视为持久化或恢复测试。

## 备份和恢复

必须同时备份 D1、R2 的 `repos/` 和 `lfs/`、每个仓库 DO 的 `refs.v2`（以及尚未迁移的 `snapshot`）。**仅备份 R2 无法恢复全部引用与账号。** 当前没有跨服务一致性备份、一键全站恢复或 refs 导出管理工具；生产灾难恢复仍需实现并演练。

- Worker 重启：正常请求从 DO 读取 refs、从 R2 读取对象，无需缓存恢复脚本。
- 缺失已引用对象：恢复相应 R2 canonical 对象，不能提交空 refs。
- 误删：停止该仓库写入，从一致备份恢复必要组件。
- 不为 Git 对象配置盲目到期策略。任何 GC 必须先枚举可靠的活动 refs、计算可达性，并设置保留期和并发保护。

## v0.3 升级与连接配置

先备份 D1/对象/引用，应用 `0004_forge_features.sql`，再发布 v0.3 Worker。为 `CREDENTIAL_ENCRYPTION_KEY` 配置 **32 随机字节的 base64**，例如在安全终端用 `openssl rand -base64 32` 生成，通过 Wrangler secret 提示输入。不要输出到日志、提交源码或使用本地测试值。已存在加密数据时必须保留原密钥；直接替换会使凭证无法解密。新实例可以先设置 secrets，或先部署空实例再设置；未配置时连接管理明确返回 503。

`SYNC_ALLOWED_HOSTS` 可选，逗号分隔，用于自托管 Gitea/Forgejo/GitLab 主机；只填可信公网 HTTPS 主机名，无端口/路径/IP。常见公共提供方已内置允许。`WEBHOOK_ALLOWED_HOSTS` 仍默认空。

GitHub App 在网页“密钥与连接”配置 app_id、installation_id、RSA private_key 与至少 16 字符 webhook_secret；为 App 授予 Contents read/write，并订阅 push，Webhook URL 为 `/webhooks/github/<用户名>`。私钥只保存为 D1 密文。公有 GitHub 仓库可用 public 模式，无 App；generic 模式需先保存 HTTPS 凭证再请求同步。外部 App 未配置时不会返回假成功。

同步状态页可查询持久任务/错误并手动重试。上游推送结果不确定时普通操作会暂时返回 409，后台实际拉取后解除。自动重试最多五次，修复权限/网络后使用手动 pull。勿直接删除 DO reconcile marker 绕过恢复。

`npm run test:sync` 只对本地实例拉取公共 GitHub，不修改该外部仓库。SDK 验收需要 Python ≥3.10 + cryptography 和 Go ≥1.24；CI 已包含本地 HTTP/native Git/SDK 组合。真实私有 App 安装的验收需操作者自身配置，区别于可重复的提供方模拟测试。

历史验收见 [v0.2 记录](VERIFICATION-v0.2.md)，当前验证见 [VERIFICATION.md](VERIFICATION.md)。历史文档中的“未初始化/无删除 GC”描述仅针对当时版本，不能用于当前实例的操作判断。

## 可重复的云端验收

`scripts/verify-cloud.mjs` 默认拒绝执行。操作者确认使用自己的测试实例后，设置 `ALLOW_REMOTE_ACCEPTANCE=1`、`ONESTORAGE_ORIGIN`、`ONESTORAGE_NAMESPACE`、`ONESTORAGE_TOKEN`，运行 `node --import tsx scripts/verify-cloud.mjs`。令牌通过安全环境注入，不写入命令行或配置。脚本只创建随机 `accept_v03_` 私有仓库，并在 finally 中删除；读取公开 GitHub，不写外部上游。可设置 `ACCEPTANCE_REPORT` 将无凭证的结果保存至忽略目录。
