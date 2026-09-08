# 项目与空间部署令牌

v0.26 增加专门给 Git 拉取、包发布和部署工具使用的凭据。认证、授权及管理由 Workers/D1 完成，Git 读取仍走 Durable Objects/R2，软件包仍存于 R2；不引入容器。

项目维护者在「项目设置 → 部署令牌」管理项目令牌。空间所有者在空间详情进入「部署令牌」，管理覆盖该空间所有当前及未来项目的空间令牌。代码读取、包读取、包发布和包撤回四项权限独立选择。

| 权限 | 允许的操作 |
| --- | --- |
| `read_repository` | Git HTTPS clone/fetch、LFS 下载，包含临时远程读取；不能 push 或上传 LFS |
| `read_package_registry` | 包列表、详情、npm 元数据及包文件下载 |
| `write_package_registry` | 通用文件与 npm 发布、增加/修改/移除 dist-tag |
| `delete_package_registry` | 删除包版本、npm unpublish；npm 客户端撤回还需读取权限 |

发布工具可能先读取元数据，因此实际 npm 自动化通常同时选择包读取与发布权限。仅发布权限的令牌可以直接上传，但不能列出或下载包。部署令牌不能调用用户、成员、Issue、CI 配置、密钥、管理后台或令牌管理 API，也不能通过公开项目绕过自身范围。需要 Git 写入的自动化继续使用受用户角色限制的 PAT 或委托 Git JWT。

## 生命周期与权限

令牌属于项目/空间，独立于创建者的成员关系和账户启用状态。创建者离开团队或被禁用不会自动撤销它；其他当前项目维护者或空间所有者仍可管理。创建者仅保留为历史来源，软件包发布者显示部署令牌用户名，审计记录部署主体标识，不冒充用户操作。团队交接应检查与撤销不再需要的部署凭据。

- 有效期 1–365 天，默认 90 天；每项目/空间最多 100 个有效令牌。管理列表每页 50 条，包含到期和已撤销记录。
- 只存储随机 256 位令牌的 SHA-256 散列。原文仅创建/轮换响应一次，网页默认遮罩且不会写入 localStorage；关闭一次性显示后不可再取回。
- 轮换要求当前 `revision`，立即废止旧秘密；可以续期已到期令牌，但不能恢复已撤销令牌。撤销同样要求当前版本，以免并发操作覆盖较新决定。
- 同空间项目重命名保留令牌；跨空间转移不可逆地撤销项目令牌。原空间令牌不再覆盖转移项目，即使项目公开也拒绝；目标空间令牌可以访问。项目转回时，已撤销的项目令牌不会恢复，当前原空间令牌重新覆盖它。
- 归档允许读取和管理部署令牌，禁止包写入。删除项目/空间级联删除对应令牌。
- 会话创建和轮换遵循已启用的 MFA；API 创建/轮换允许有当前管理权限的写 PAT。API 不要求 PAT 再提供 OTP，令牌持有者必须具备该资源的管理权限。
- 上传完成、包返回字节前、DO 排队结束和返回准备好的 Git 响应前均复核当前权限、到期、轮换和项目生命周期。撤销后取消未读流；已交付的字节无法收回。最近认证时间最多每小时更新，不是逐次成功操作日志。

## 客户端

Git 使用令牌配置的用户名，密码为令牌原文。建议使用 Git 凭据管理器或 `GIT_ASKPASS`；不要将秘密写入 URL 或命令历史。

```sh
git clone https://git.1s.hk/team/project.git
```

npm 项目 `.npmrc` 引用环境变量；`ONESTORAGE_DEPLOY_TOKEN` 由 CI 密钥或本地秘密管理器注入。占位符替换为实际空间和项目名。

```ini
@team:registry=https://git.1s.hk/api/repos/team/project/packages/npm/
//git.1s.hk/api/repos/team/project/packages/npm/:_authToken=${ONESTORAGE_DEPLOY_TOKEN}
```

```sh
npm publish --registry=https://git.1s.hk/api/repos/team/project/packages/npm/ --access=public
npm install @team/example --ignore-scripts
```

`--access=public` 不改变私有项目可见性。详细 npm 支持范围、大小和版本不可重用规则见 [包仓库](PACKAGES-v25.md)。外部 Runner 可以通过显式选择的加密 CI 变量使用部署令牌；原生 Worker 编译器目前仍只下载公开 npmjs 依赖，私有包接入属于后续目标，本版不自动注入令牌到构建任务。

## 管理 API

基址为 `/api/repos/:namespace/:repo/deploy-tokens` 或 `/api/workspaces/:slug/deploy-tokens`。使用管理者会话或 PAT，不能用部署令牌调用。

| 方法与后缀 | 输入 / 输出 |
| --- | --- |
| `GET ?offset=0` | `{tokens,next_offset,available_scopes,limit}`，列表不含原文和散列 |
| `POST` | `{name,username?,scopes,days?,otp?}`；201，返回元数据和一次性 `token` |
| `POST /:id/rotate` | `{revision,days?,otp?}`；200，返回新元数据和一次性 `token` |
| `DELETE /:id` | `{revision}`；200，返回已撤销元数据 |

名称不超过 80 字符；可选用户名匹配 `[a-zA-Z0-9][a-zA-Z0-9._+-]{0,79}`，未指定自动生成。时间字段为 Unix 毫秒。陈旧版本、有效数量超限或操作过程中管理权限改变返回 409。认证失败为 401，已认证但范围不足为 403。OpenAPI 与本地/生产验收脚本 `npm run test:deploy-tokens` 随源码提供。

设计参照 [GitLab deploy tokens](https://docs.gitlab.com/user/project/deploy_tokens/) 的独立项目/组主体与代码只读语义；OneStorage 额外拆分包撤回权限并强制有限有效期，不宣称 GitLab API 完全兼容。
