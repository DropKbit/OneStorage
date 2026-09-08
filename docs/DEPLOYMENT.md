# 部署 OneStorage

## 当前实例

规范地址为 **https://git.1s.hk**；`1s.hk` 继续提供 Cubelink。独立 Worker 地址为 `https://onestorage.xbitfun.workers.dev`，浏览器登录和 LFS 应使用规范地址，以匹配 APP_ORIGIN。

资源：Worker `onestorage`、D1 `onestorage`、R2 `onestorage-objects`、Queue `onestorage-events`、SQLite Durable Object 类 `Repository`。没有 Containers、Docker 镜像或外部 Git 服务器。

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
npm run db:remote
npm run deploy
npx wrangler secret put BOOTSTRAP_SECRET
```

`deploy` 与打包命令会先从明确的源码目录生成 `public/source.tar.gz`，通过页面提供 AGPL 源码下载。不要将私有文件放入这些源码目录；`.data`、`.wrangler` 和环境密钥文件不在打包白名单。

为 BOOTSTRAP_SECRET 使用至少 32 字节的随机值，在 Wrangler 提示中输入。未配置密钥时初始化接口拒绝创建账号，不会开放无密钥注册。生产不能使用 `wrangler.local.jsonc`；它含公开的本地测试密钥。不要导入本地 `.wrangler` 数据。

访问 `/api/health`，确认 HTTPS 与静态页面可用，然后初始化管理员、创建私有验收项目和临时 PAT，执行真实 push、clone、fetch、merge 与 LFS。验证后撤销验收凭证。公开 DNS 和本地负缓存传播可能有时间差；不要为排查 DNS 而关闭 TLS 校验。

## 更新和 v0.1 迁移

保持 Worker 名、DO 类名、migration 历史、D1 UUID 和仓库 UUID 映射稳定。先备份并在独立环境验证，再应用新的编号 SQL migration 和部署。当前配置首次部署即为 v0.2，不存在旧远程 Container 类。若你曾独立部署旧版，须保留已应用的 DO migration 记录，并制定旧 Container 类的退役 migration；不能直接重写历史。

旧 `snapshot` 指针存在、`refs.v2` 尚不存在时，首次请求会在 Worker 内解析 tar，导入 Git 对象到 R2，再原子提交 refs。兼容 macOS AppleDouble 元数据。旧快照不会被删，但迁移后的新写入不会同步回旧快照，因此直接回滚旧引擎会丢失新版本可见的更新。超出新引擎预算的旧仓库需要离线迁移方案；不要初始化空仓库掩盖导入失败。

## Webhook

默认 `WEBHOOK_ALLOWED_HOSTS` 为空，不对外投递。操作者可配置逗号分隔的可信 HTTPS 接收端主机名，例如 `build.example.net,hooks.example.net`。接收端必须由你信任和管理，不使用任意租户可控 DNS 或内部地址。

维护者通过 API 创建 `{url}`，得到一次性显示的签名 secret。事件仅包含事件名、仓库 UUID、actor、detail 和时间，不含代码或凭证。操作记录与 outbox 在 D1 同一 batch；Queue 调用失败由五分钟 Cron 补发。投递最多五次，失败状态可通过 deliveries API 查询。接收端校验时间戳/HMAC，并以 `X-OneStorage-Delivery` 去重。

Git ref 提交与 D1 outbox 不是原子事务；极端情况下 Git 已持久化但事件未生成。Webhook 不能作为唯一同步账本，需定期比较 refs。

## 运行与成本

- APP_ORIGIN 必须与浏览器规范地址一致，影响 Cookie 写操作和 LFS action URL。
- 每仓库一个 DO，最多 16 个请求排队；操作串行执行。没有 Container 实例数/启动延迟。
- R2 逐对象保存 canonical 数据；传输时重新生成 pack。每次请求的 R2 读取数量和历史大小会影响延迟与成本。
- 应用限额见 README；Worker/DO CPU、内存、子请求等平台限额仍独立生效。大仓库尚不适用。
- 没有自动 GC 或总存储配额；失败提交及删除引用后可能留下不可达对象。
- 监控 Worker 错误、DO 请求饱和、R2 用量和缺失对象、D1/Queue 失败。不要把成功健康检查视为持久化或恢复测试。

## 备份和恢复

必须同时备份 D1、R2 的 `repos/` 和 `lfs/`、每个仓库 DO 的 `refs.v2`（以及尚未迁移的 `snapshot`）。**仅备份 R2 无法恢复全部引用与账号。** 当前没有跨服务一致性备份、一键全站恢复或 refs 导出管理工具；生产灾难恢复仍需实现并演练。

- Worker 重启：正常请求从 DO 读取 refs、从 R2 读取对象，无需缓存恢复脚本。
- 缺失已引用对象：恢复相应 R2 canonical 对象，不能提交空 refs。
- 误删：停止该仓库写入，从一致备份恢复必要组件。
- 不为 Git 对象配置盲目到期策略。任何 GC 必须先枚举可靠的活动 refs、计算可达性，并设置保留期和并发保护。

云端验收脚本使用独立临时账号/PAT和仓库，结束时删除其凭证、账号及 D1 仓库元数据。少量测试 R2 对象与 DO refs 作为不可达数据保留，当前没有 GC；未向第三方发送 Webhook。具体通过和未覆盖的检查见 [验证记录](VERIFICATION.md)。
