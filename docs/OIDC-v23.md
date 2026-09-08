# v0.23 统一登录

OneStorage 在 Workers 中实现 OIDC Authorization Code + PKCE S256，通过 Web Crypto/Jose 验证 ID Token。D1 保存身份映射、版本化配置与一次性登录状态，提供方密钥和短期流程数据用既有 `CREDENTIAL_ENCRYPTION_KEY` 加密。无需容器、独立认证服务器或外部数据库。

## 管理与使用

1. 管理员打开 `/admin/identity`，在自己的身份服务中注册 Web 应用。当前实例回调地址为 `https://git.1s.hk/api/auth/oidc/callback`，必须精确登记。
2. 填写名称、准确的 issuer、client ID、client secret、客户端认证方式及获准端点主机。支持 `client_secret_basic`、`client_secret_post`、`none`。主机列表须覆盖 discovery、authorization、token 与 JWKS 的实际域名；不使用通配符。
3. 保存时读取 discovery 并验证 issuer、code 流、端点与认证方式。启用后登录页出现按钮。默认不开放创建账户；需要时显式开启该提供方的注册，可限制已验证邮箱的准确域名。
4. 已有用户先按原方式登录，在 `/settings/account` 输入当前密码和已启用的双因素验证码，再关联身份。匹配依据是提供方 ID 与 `sub`，不会按邮箱、显示名或用户名自动合并账户。
5. 新身份在允许注册时自行选择用户名，创建普通、无本地密码的账户，不自动授予管理员或空间权限。可在账户安全中设置第一个本地密码，之后也能用密码登录。

有本地密码的账户，安全操作仍要求密码。无密码账户要求五分钟内完成一次 OIDC 登录，过期可使用「重新验证」；启用本地双因素后，OIDC 登录与敏感操作仍须验证本地 TOTP 或一次性恢复码。修改密码会退出全部会话。管理员可以通过已有密码重置流程恢复账户，不要求用户知道自动生成的不可用随机密码。

客户端密钥只写不读，编辑时留空保留原密钥。issuer/client ID 不可直接修改，需要建立新提供方并重新关联。最多配置 20 个提供方；修改配置立即撤销该提供方签发的浏览器会话、由这些会话创建的 PAT 和未完成登录。解除关联只撤销该用户在该提供方下的凭据，并要求保留本地密码或另一种已启用身份。存在关联账户时不能删除提供方，可先停用；删除空提供方也检查版本和当前管理员权限。

OIDC 的撤销不会删除独立本地登录产生的凭据、仓库委托签名密钥或外部系统的登录会话。站点账户禁用继续撤销全部站点凭据。此版本没有 IdP 后台退出通知、SCIM、SAML、普通 GitHub OAuth 或直接接收 Cloudflare Access JWT；它们仍在身份接入路线内。普通 OAuth access token 不能作为 OIDC ID Token 使用。

## 安全与一致性

- 浏览器独立 HttpOnly/SameSite=Lax 临时 cookie 绑定 state，允许外部提供方回调；正式会话维持 SameSite=Strict。开始和完成接口要求匹配站点 Origin。
- state 单次原子认领、十分钟有效；PKCE verifier 为 67 个合法字符，nonce 和 verifier 加密保存在短期流程中。失败、完成或定时回收后删除。提供方返回的访问、刷新及 ID Token 不持久化。
- JWT 检查签名、issuer、audience、azp、sub、nonce、iat、exp，允许 RS256/ES256/EdDSA，最多 30 秒时钟偏差。拒绝未验证邮箱和不符合配置的邮箱域名。
- 所有服务器端身份服务请求仅允许管理员明确批准的 HTTPS 公共主机，禁用重定向，响应限 64 KiB、十秒超时。JWKS 最多 16 个公钥。端点不能带查询参数；需要这类端点的提供方暂不兼容。
- 提供方版本、账户禁用/密码代号、原会话和双因素版本在关联或发放会话时重新核验。管理员操作也在最终写入时检查当前管理员及凭据，防止 discovery 请求期间撤权后继续配置。
- 重新认证仅接受原账户身份，并在新会话落库后撤销原会话。完成注册与重试可恢复已创建的同一账户。配置、关联、解绑和登录记录审计事件，不记录密钥或认证回调参数。

协议依据：[OIDC Core](https://openid.net/specs/openid-connect-core-1_0.html)、[PKCE RFC 7636](https://www.rfc-editor.org/rfc/rfc7636)。这是受限的标准代码流实现，不是全部 OIDC 可选扩展的兼容声明。

## 迁移与验收

本地和生产的逐项结果见 [验收记录](VERIFICATION-v23.md)。

应用 `0018_oidc.sql` 后发布主 Worker。新增表与字段；现有用户默认 `has_password=1`，现有凭据提供方字段为空。不改变 Git 对象、R2 布局、DO 类、应用网关或编译 Worker。保留原有加密密钥。升级前导出 D1 并在隔离 SQLite 副本验证迁移和约束；D1 导出不等于 R2/DO 全站备份。

`npm run check` 包含 OIDC 密码学和 D1 事务单元测试。`npm run test:oidc` 使用 Playwright 和独立受密码保护的 Cloudflare 身份测试 Worker，覆盖管理界面、真实跨域回调、账户关联、MFA、撤销 PAT、普通账户注册和本地密码设置。测试程序在结束时解绑身份、删除测试提供方并停用临时账户。生产运行必须显式设置 `ALLOW_REMOTE_ACCEPTANCE=1`、`TEST_ORIGIN` 和私有 `ONESTORAGE_TOKEN_FILE`。

可重建的测试提供方源码位于 `scripts/support/oidc-provider.ts`。它仅用于验收，部署时必须使用独立 Worker 和随机客户端密钥、测试密码及 ES256 密钥；配置和密钥文件放在忽略目录且权限为 0600。测试后删除该 Worker 及本地密钥。实际商业提供方需要实例管理员配置自己的客户端凭据，受控提供方通过不代表已验证 Google/Microsoft 的真实账户。
