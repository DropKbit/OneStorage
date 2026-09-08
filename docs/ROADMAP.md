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

见 [REVIEWS-v07.md](REVIEWS-v07.md)：同一 Fork 网络贡献、固定对象快照、目标 CI、行级讨论与解决门禁、DO 串行审阅变更。v0.13 已用独立无头浏览器补验真实 Fork MR 创建、分页、重新打开、CI 和合并交互，见 [GIT-PREFETCH-v13](GIT-PREFETCH-v13.md)。

## v0.8 代码负责人及 Issue 联动

见 [REVIEWS-v08.md](REVIEWS-v08.md)：目标快照 CODEOWNERS、分节和独立负责人门禁、默认分支自动关闭 Issue、持久化重试恢复与 R2 双路 I/O。完整 GitLab/Gogs 目标仍进行中。

## v0.9 Issue 工作流

见 [ISSUES-v09.md](ISSUES-v09.md)：项目 Issue 筛选与游标、可保存的标签看板、事务批量操作、版本化编辑及评论分页。项目归档/转移和大仓库能力继续开发，不以本轮交付替代完整目标。

## v0.10 项目归档

- 所有者版本化归档/恢复；DO 串行 Git 写屏障、D1 协作写约束、原子 CI 租约取消及上游任务取消。读取、clone/fetch、导出、历史应用保留；权限管理与删除继续可用。
- 详细契约见 [ARCHIVE-v10](ARCHIVE-v10.md)，验收见 [VERIFICATION-v10](VERIFICATION-v10.md)。项目转移与大仓库流式处理仍在总目标内。

## v0.11 项目转移与重命名

- 转移保留项目 UUID、Git/R2 内容、协作与 CI 历史，重新计算空间继承权限；跨空间交接撤销连接并关闭公开应用，同空间重命名保留连接与发布。
- 历史地址重新授权，防止私有目的地泄露和旧地址占用；请求级 D1 版本事务与 DO 请求版本检查阻止旧空间在途写入。
- 详见 [TRANSFER-v11](TRANSFER-v11.md) 与 [VERIFICATION-v11](VERIFICATION-v11.md)。大仓库、完整流水线和统一登录等目标继续推进。

## v0.12–v0.14 Git 与云端工作流

- v0.12/v0.13 增加持久对象索引、增量协商、出站流式 pack、缓存及有界并发读取，见 [GIT-SCALE-v12](GIT-SCALE-v12.md) 和 [GIT-PREFETCH-v13](GIT-PREFETCH-v13.md)。入站规模限制和偶发写入失败仍须处理。
- v0.14 增加固定提交配置、依赖任务、并行执行、跨任务产物、整条工作流的取消和合并/发布门禁；实现及验收见 [CI-WORKFLOWS-v14](CI-WORKFLOWS-v14.md)。

## 后续目标与完成标准

v0.15 增加有界写入恢复和阶段诊断，并修正 thin pack 吞掉存储异常的问题，见 [GIT-RELIABILITY-v15](GIT-RELIABILITY-v15.md)。这些改动不等于已定位历史 503，可靠性目标仍需持续验证。

1. **Git 可靠性与大仓库**：定位实际发生的写入 503；为入站 pack/delta 提供有界流式处理，扩展首次导入规模，并验证失败后引用不前移、重试不损坏对象、原生 clone/fetch/fsck 一致。
2. **完整 CI/CD**：补齐定时流水线、变量与密钥、共享缓存、云端 npm/TypeScript 构建。任务必须绑定确定的代码和配置版本，权限撤销后停止读取凭据或发布，提供失败恢复和真实部署证据。
3. **身份与授权**：实现 OIDC/OAuth、Cloudflare Access、注册/账户恢复、细粒度部署令牌；验证账户关联、角色变更及凭据撤销，不用前端隐藏按钮代替服务端授权。
4. **日常协作**：补齐合并队列、跨项目搜索、Wiki 迁移和 PDF/Notebook 预览，保持私有项目隔离、可审计操作与可恢复数据。
5. **扩展平台能力**：包仓库、镜像仓库、扫描及质量报告逐项实现并独立验收；完整 GitLab YAML/API 兼容不在已有版本的完成声明中。

总目标持续有效。每一阶段须有真实云端持久化、权限/失败路径验证、可操作界面或明确的客户端契约、开源文档、发布和源码同步；阶段版本号不代表完整 GitLab/Gogs 目标已经完成。

## v0.16 流式首次导入

原生 HTTPS receive 使用 R2 会话隔离区增量解析，完整 pack 校验和 delta 解析后再保存正式对象并发布 DO 引用；引入可恢复分页清理。单次应用预算提升至 64 MiB 传输、25,000 条目、256 MiB 展开，单对象仍为 8 MiB。验收与其余路径边界见 [入站记录](GIT-RECEIVE-v16.md)。packed R2、读取并发、大型 Fork/历史算法和剩余平台功能继续推进。

本轮类型检查及 182 项单元测试、本地 43 次核心 API 断言和 35 项大包检查通过。生产单次首次推送 2,108 对象/35 MiB、v0/v2 clone/fsck、增量与中断下载专项通过 33 项检查，另有 57 次写入/CI 断言；夹具已清理。首次导入约 12 分钟，冷克隆仍需优化，完整平台目标不因此标记完成。

## v0.17 完整 pack 缓存

在权限和可达对象集合检查之后复用 R2 完整 pack，减少重复 clone 的对象读取与压缩；有界分块校验、损坏回退、24 小时保留、失败恢复和仓库删除回收见 [GIT-PACK-CACHE-v17](GIT-PACK-CACHE-v17.md)。首次导入、无缓存传输和同仓库串行排队仍属后续性能目标，永久对象存储格式保持兼容。

## v0.18 传输期间的页面读取

原生 Git 传输期间，常用页面可通过有界只读通道读取引用快照；原主队列、生命周期等待及缓存回收屏障保留。实现、资源预算和验证见 [GIT-READS-v18](GIT-READS-v18.md)。两个完整 Git 传输并行、首次导入吞吐和复杂历史算法仍待优化，完整平台目标持续有效。
