# GitHub 与 GitLab OAuth 登录 v0.33

管理员在“统一登录管理”选择 OpenID Connect、GitHub OAuth 或 GitLab OAuth，配置提供方名称、地址、Client ID/secret、可信主机、注册开关和可选邮箱域名。保存后登录页出现对应按钮；已有账户在账户安全页显式关联，之后可用提供方登录或重新验证。

## 配置

| 提供方 | 地址与可信主机                                             | 应用权限                                         | 客户端认证                                    |
| ------ | ---------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------- |
| GitHub | `https://github.com`；`github.com,api.github.com`          | `read:user`；配置邮箱限制时额外请求 `user:email` | `client_secret_post`                          |
| GitLab | `https://gitlab.com` 或可信 HTTPS 自托管实例地址；对应主机 | `read_user`                                      | `client_secret_post`，或非机密应用选择 `none` |
| OIDC   | 原有 Issuer/discovery 配置                                 | `openid email profile`                           | 原有三种认证方式                              |

在提供方创建 OAuth 应用，将回调地址设为管理页面显示的地址；本实例为 `https://git.1s.hk/api/auth/oidc/callback`。应用 secret 仅写入，经既有凭据密钥加密保存，编辑时留空保留。地址、Client ID 与协议创建后不可修改；需要变更时建立新提供方并显式关联。GitHub 模式针对 github.com；不声称兼容尚不支持 PKCE 的旧 GitHub Enterprise Server。

服务端始终使用授权码与 PKCE S256；GitHub 的支持及请求参数见 [GitHub OAuth 文档](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)，GitLab 的应用注册与 PKCE 流程见 [GitLab OAuth 文档](https://docs.gitlab.com/api/oauth2/)。不使用隐式授权、设备流或用户密码授权。

## 身份与权限

浏览器一次性 state 和 HttpOnly 流程 Cookie、10 分钟过期、提供方版本及当前账户安全版本约束整个过程。提供方固定 HTTPS token/user API 返回的数字用户 ID 作为身份主体；用户名只是注册建议，不按姓名或邮箱自动合并账户，也不继承提供方的管理员、组织或项目权限。

GitHub 身份来自 `/user`；启用邮箱限制后，仅接受 `/user/emails` 明确 `verified=true` 且域名精确匹配的地址。每页最多 100 项、最多 5 页，不跟随响应中的外部分页链接；未找到匹配时拒绝登录。邮箱 API 的验证字段见 [GitHub 邮箱文档](https://docs.github.com/en/rest/users/emails?apiVersion=2022-11-28)。

GitLab 身份来自 `/api/v4/user`，要求 `state=active`，拒绝 locked/bot；域名限制检查响应主邮箱 `email` 及有效的 `confirmed_at`，不使用 `public_email` 或 `unconfirmed_email`。这是对可信 GitLab 实例账户确认状态的依赖，不是 OneStorage 自行发信验证；管理员可管理提供方的确认策略。字段见 [GitLab 当前用户 API](https://docs.gitlab.com/api/users/#retrieve-the-current-user)。

令牌交换与身份读取均禁止重定向、限制响应体为 64 KiB、每次请求超时 10 秒；endpoint 从固定协议路由重新推导并检查可信主机。外部 access/refresh token 不持久化，也不交给浏览器、Git 客户端或 CI。登录后产生普通 OneStorage 会话；本地 MFA、注册关闭、无密码用户最后一种登录方式保护、显式设定本地密码、解除关联及提供方配置变更的会话/PAT 撤销均复用已有持久事务。

外部账户停用或外部应用授权撤销会影响下次提供方登录；已发出的 OneStorage 会话不会因为未接入的远端 webhook 自动即时撤销。管理员可禁用提供方或账户以撤销本站凭据。Cloudflare Access、其他 OAuth 提供方以及完整目录同步仍在总目标中。

## 兼容与验收

沿用 `/api/auth/oidc/*`、`/api/admin/identity-providers`、`/api/account/identities` 和已有 D1 表；新增配置字段 `protocol=oidc|github|gitlab`（省略默认 oidc），没有数据库迁移。旧 OIDC 配置继续工作，API 路径和审计事件前缀保留。运行旧版本前应先停用其不支持的 OAuth 提供方。

`npm run check` 包含协议适配与账户事务测试。`npm run test:oauth` 使用临时 Cloudflare Worker/DO 提供方执行真实浏览器跳转、单次授权码、PKCE、opaque token 和用户 API。测试服务实现 GitLab 协议契约，不是真实 GitLab 实例；没有因此声称已验证用户的实际 GitHub/GitLab OAuth 应用。真实应用需在对应服务注册并通过管理界面配置。详细证据见 [验收记录](VERIFICATION-v33.md)。
