# Code Storage 功能对照与开发目标

对照日期：2026-09-08。基线：OneStorage v0.2.0 / `e72e52d`。已获取官方文档索引的 101 个非重复 Markdown 页面及 OpenAPI，逐项状态保存在 [parity.json](parity.json)。原文仅用于行为研究，未作为本项目源码分发。

## 开发目标

1. **鉴权和引用隔离**：用户命名空间下注册/撤销 JWT 公钥；精确 scope、repo、有效期校验；首次匹配引用策略；SSH/OpenPGP 提交验签；Git Notes；临时和导入远程。
2. **完整 Git API**：分支/标签 CRUD 与游标；提交元数据/签名、按路径历史；二进制/流式提交；文本和 binary patch；恢复提交；三方合并、预览、冲突和 squash；最小行差异；原始文件条件请求、范围/HEAD；归档过滤、blame 和正则搜索。
3. **仓库生命周期**：自定义名称、修改默认分支、独立 fork、删除状态与异步对象清理、ID 到 URL 查询。
4. **上游连接**：加密保存 HTTPS 凭证、公共 GitHub 导入、普通 Git 上游同步、GitHub App 安装令牌和签名 webhook；只同步普通 heads/tags，临时状态不外传；失败可观察，成功必须有实际 Git/R2 状态。
5. **SDK 与 Agent 使用**：TypeScript/Python/Go 的对应操作、短期委托 Git URL、提交构造器；MCP 和机器可读文档；内存、会话、恢复、实时 diff、产品文件和并行尝试示例。
6. **验收与交付**：每个契约都有成功/失败测试；原生 Git 验证对象、签名、Notes 和协议；测试旧接口回归；更新部署配置/迁移/文档后再发布。

## v0.3 交付结果

六个开发目标已完成对应实现与验收。51 项均有真实后端实现和可重复验证证据，40 个首选 REST 操作已在 Cloudflare 临时仓库验收；完整结果和未覆盖事项见 [验证记录](VERIFICATION.md)。新版本提供三种语言 SDK、七类 Agent 工作流、MCP、OpenAPI，以及 Git 工作台/密钥/上游管理页面。

真实私有 GitHub App 的安装配置仍由操作者提供；其密码学与提供方协议由可重复测试覆盖，公开 GitHub 同步已在真实 Cloudflare 上验证。规模、SLA、原生 Git 未支持的协议与复杂合并边界不包含在“功能完成”的声明中。

## v0.2 基线的主要差距

v0.2 只有 PAT/会话鉴权、heads/tags、基本读写、快进合并、文本编辑和简单检索。上述新增能力均不能仅凭一个路由或 SDK 方法就标记完成，必须连接真实持久化后端。Issues、评论、成员管理和网页审阅属于 OneStorage 的额外能力，会继续保留。

## 对齐原则

- 维持完全无容器架构，不运行服务端 Git 进程。对齐可见功能与安全语义，服务域名和命名空间 API 路径采用 OneStorage 自身约定，不声称第三方 SDK 可直接替换 base URL。
- Code Storage 的热盘复制/冷存储实现不能照搬。OneStorage 的数据始终保存在 R2，导入后的持久化无需热盘迁移；必须写清楚这一实现差异。
- 大仓库吞吐、TB 级容量和 SLA 不因 API 完成而自动成立。保留经过验证的应用/平台限额，单独记录规模测试边界。
- GitHub App 及私有上游需要操作者提供连接配置；实现和可重复集成测试应先完成，缺少真实外部安装信息不可以用假成功掩盖。

## 参考

[官方文档](https://code.storage/docs/)、[鉴权](https://code.storage/docs/getting-started/authentication)、[引用策略](https://code.storage/docs/guides/ref-policies)、[命名空间](https://code.storage/docs/guides/ephemeral-branches)、[签名](https://code.storage/docs/guides/commit-signing)、[同步](https://code.storage/docs/guides/generic-sync)、[OpenAPI](https://code.storage/docs/openapi.json)。

## v0.4 平台扩展目标

用户已指定：代码高亮、通用构建与 Cloudflare 部署、多空间、权限分配、管理员后台。验收范围、权限矩阵、Runner 配置和当前边界见 [平台说明](PLATFORM-v04.md)。功能开发、权限/协议回归与生产迁移已完成，线上核心验收通过；测试证据和 Runner 部署前提见 [v0.4 验证记录](VERIFICATION-v04.md)。


## Cloudflare 原生 GitLab/Gogs 持续目标

以 [v0.5 能力与差距矩阵](CLOUD-NATIVE-v05.md) 为当前状态，逐步补齐跨 Fork 审阅、身份安全、Markdown/预览、完整项目协作及原生构建。v0.5 发布不表示总目标完成。


## v0.6 账户与展示

本轮实现见 [ACCOUNT-v06.md](ACCOUNT-v06.md)：TOTP/恢复码、会话撤销、个人资料/权限过滤活动、Markdown 与栅格图片预览。其余差距继续追踪，不以阶段发布结束总目标。


## v0.7 Fork 审阅与讨论

见 [REVIEWS-v07.md](REVIEWS-v07.md)：同一 Fork 网络贡献、固定对象快照、目标 CI、行级讨论与解决门禁、DO 串行审阅变更。完整平台目标继续保留，浏览器交互验证在电脑解锁后补验。
