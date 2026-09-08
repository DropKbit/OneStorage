# v0.7 跨 Fork 审阅与代码讨论

**简体中文** · [English](en/REVIEWS-v07.md)

此增量继续构建 Cloudflare 原生 GitLab/Gogs 协作平台。运行时仍为 Workers JavaScript、R2 Git 对象与 Durable Objects 引用协调，不引入容器或 Git 服务进程。

## 跨 Fork 合并请求

在目标仓库的“合并请求”页选择来源仓库和来源分支。候选来源为当前用户有开发权限的同一 Fork 网络仓库；支持原仓库、子 Fork 和兄弟 Fork。目标可以是公开仓库，贡献者无需获得目标写权限；私有目标要求现有读取权限。普通同仓库请求继续要求开发权限。合并和目标 CI 由目标维护者执行。

请求创建时，Worker 从来源 Durable Object 解析普通分支的固定提交。目标 Durable Object 在自己的串行队列内从来源 R2 读取、校验并保存此提交可达的 Git 对象与已有 LFS 内容。整个源分支的历史随贡献披露给目标读者；不会复制其他分支、访问令牌或来源仓库配置。页面明确提示这种披露。发布贡献是主动共享代码，不能把私有 Fork 的请求误认为只有差异文本会变得可读。

快照复制不会写入目标分支，不会给贡献者增添目标角色，也不会自动运行来源 CI。目标 DO 不在锁定自己的队列时调用来源 DO，因此互相提交请求不会形成跨 DO 锁等待循环。删除目标由同一队列处理，迟到的导入不能在目标对象清理完成后继续写入。

请求记录来源仓库 ID、名称、分支、源/目标 SHA 和修订号。详情及历史讨论读取目标保留的固定快照。来源分支前进后请求标为过期；作者更新快照后，批准和 CI 门禁按新 SHA 重新计算。私有来源的更新仍要求操作者具有来源开发权限；目标维护者可以刷新公开来源。来源删除后已披露快照仍可阅读；当前需要恢复来源或重新提交请求才能执行新的合并，不能把来源丢失当作默认批准。

合并预检读取来源当前分支，在目标 DO 内检查该源版本、目标引用、当前审阅与 CI 门禁，再通过现有 Git 合并实现快进、三方合并或 squash。源仓库在预检后发生的新提交不会改变已批准的快照；它们不进入本次合并。目标引用更新依旧通过 DO CAS，成功结果持久化以支持幂等重试。

## 审阅、行级讨论与解决状态

差异行号可以直接发起旧/新侧行级讨论，也可以建立普通讨论。服务端验证文件路径、真实文本行号及两端 SHA；二进制文件使用普通讨论。每个讨论支持回复、解决、重新打开及旧版本标记。旧版本讨论继续可读，不会被更新请求覆盖。

目标开发者可以独立批准或要求修改；作者不能批准自己的请求。讨论作者、请求作者或目标开发者可以解决讨论。公开项目的已登录访客可讨论，但访客反馈本身不会成为合并否决权。分支保护新增“审阅讨论必须解决”：只统计当前仍有目标开发权限、未停用的讨论发起者所留下的未解决讨论，包括旧版本。列表分页不会隐藏阻塞条件。

更新/关闭请求、提交审阅、讨论及解决状态变更与合并共享目标 DO 队列。并发合并和重新打开阻塞讨论只能有一方成功：合并先完成时讨论变更被拒绝；讨论先重开时合并门禁拒绝。请求修订号支持 PATCH 的 `revision` 字段，陈旧更新返回 409；省略时保留旧客户端兼容性。

讨论列表每页 100 条，使用数字 `after` 游标；单个讨论回复同样每页 100 条。详情页使用 `discussions_after` 加载后续讨论。所有读取再次经过目标仓库鉴权。

## 目标仓库 CI

维护者点击“运行此版本 CI”，使用目标仓库保存的配置检查请求的固定源 SHA。来源 Fork 的配置、令牌和部署设置不会继承。门禁仍只接受目标仓库中该 SHA 的最新成功流水线；来源自行运行成功的任务不替代目标检查。

云端 JS/WASM 步骤延续无绑定、无外网的隔离执行模型。若操作者明确将目标配置为外部 Runner，手动运行意味着把贡献代码交给那个 Runner；它不是云端隔离步骤。此版本不自动启动 Fork CI 或将主服务凭据提供给任务。

## API 与部署

- `GET /api/repos/:namespace/:repo/merge-sources`：可提交贡献的来源仓库。
- `POST .../merges`：`{title,body?,source,target,source_repo?}`；来源为 ID 或 `namespace/name`，省略表示同仓库。
- `PATCH .../merges/:id`：`{refresh?,state?,title?,body?,revision?}`。
- `POST .../merges/:id/pipeline`：维护者运行固定版本 CI。
- `GET/POST .../merges/:id/discussions`：分页或建立讨论；创建需要 `{source_sha,target_sha,body,path?,side?,line?}`。
- `GET/PATCH .../merges/:id/discussions/:discussion`：读取回复或 `{resolved:true|false}`。
- `POST .../merges/:id/discussions/:discussion/comments`：`{body}`。
- `PUT .../protections` 新增 `require_resolved`。

升级前备份 D1，应用 `0008_fork_reviews.sql`，再部署主 Worker；应用发布网关无需更新。源快照使用现有仓库对象配额：单对象 8 MiB、每次操作展开对象 32 MiB、图遍历 5000 对象。这些限制不等于已验证大型仓库服务能力。

CODEOWNERS、合并队列、自动关闭 Issue、SSO、完整 DAG/缓存/密钥构建、项目转移/归档及包仓库仍在持续目标中。本实现参考 [GitLab 跨 Fork 协作](https://docs.gitlab.com/user/project/merge_requests/allow_collaboration/) 与 [讨论](https://docs.gitlab.com/user/discussions/)，提供独立 API，不声称现阶段可以直接替换 GitLab API。
