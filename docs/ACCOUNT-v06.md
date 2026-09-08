# OneStorage v0.6：账户安全与内容展示

这是 GitLab/Gogs 持续目标的增量版本，仍使用 Workers、D1、R2、Durable Objects，不增加容器或外部认证服务。

## 双重验证

登录后打开“账户安全”，输入当前密码开始设置。二维码在浏览器本地生成；使用支持 TOTP 的身份验证器扫码或输入密钥，再提交六位验证码。未验证的设置十分钟过期。启用后立即保存十个恢复码；页面关闭后不再显示，每个恢复码只能使用一次。

TOTP 使用 RFC 6238 SHA-1、六位数字、30 秒窗口，接受当前及相邻时间步。同一时间步只能成功验证一次，后续安全操作需等新验证码或使用恢复码。共享 D1 限制每账户十分钟十次验证码验证（包括成功请求），不依赖客户端 IP；当前密码验证使用单独的同等配额。

启用后，密码登录必须提供验证码或恢复码。创建 PAT、修改密码也要求新验证码或恢复码。重新生成恢复码或关闭双重验证要求当前密码和有效第二因子。启用/关闭会撤销其他浏览器会话；当前会话保留。修改密码撤销所有浏览器会话与 PAT。账户安全页可单独撤销浏览器会话。

Git HTTPS、SDK、MCP 继续使用 PAT/JWT，不把验证码混入 Git 密码。启用双重验证不会撤销已有 PAT；应在“访问令牌”页检查并删除不用的凭据。管理账户安全需要浏览器会话，PAT/委托 JWT 不能调用这些接口。

密钥在 D1 中使用 AES-GCM 加密，复用 `CREDENTIAL_ENCRYPTION_KEY`，AAD 绑定用户与 enrollment 版本。恢复码只存带用户/版本上下文的 SHA-256 摘要。验证码和恢复码通过 D1 条件写入/删除原子消费；账户认证版本防止在登录过程中更改密码/双重验证后继续签发旧状态会话。

管理员重置密码不会移除双重验证。当前没有邮件找回或自动 MFA 恢复。丢失身份验证器时使用恢复码；二者都丢失时需由部署管理员核验身份后进行数据库级恢复，不能将密码重置视为绕过 MFA 的机制。备份时需同时安全保管 D1 与原加密密钥。

## 个人资料和内容

“个人资料”支持显示名称、Markdown 简介、所在地和 HTTP(S) 个人网站。`/profile?user=<用户名>` 是公开资料页；项目和活动分别根据查看者权限过滤，不泄露私有项目或其审计信息。停用用户的资料返回 404。个人项目最多列出 50 个，活动每页 50 条，使用 `before` 游标。

README、Markdown 文件、Issue 正文/评论、合并请求正文/审阅、版本说明、Wiki 和简介支持 Markdown。支持表格、任务清单、代码块高亮、标题锚点和相对文件链接。Markdown 模块按需加载；超 200,000 字符回退为转义后的纯文本。原始 HTML 不执行；危险 URL 协议被拒绝；外部图片转换为主动点击的链接，避免被动请求跟踪。

README 内和独立文件页的 PNG/JPEG/GIF/WebP 图片通过经过仓库鉴权的 `/preview` 接口显示，按文件字节识别类型，最大 5 MiB，`private, no-store` 与 `nosniff`。README 相对图片/文件链接固定到当前读取的 Git 引用；原始文件下载接口保持原有语义。SVG、PDF、Notebook 尚不提供内联预览。

## 自部署与接口

升级前备份 D1 和加密密钥，然后运行 `npm run db:remote` 应用增量 `0007_account_security.sql`，再执行 `npm run deploy`。不需要更新应用发布网关。旧账户默认不启用 MFA，现有仓库和 PAT 不受迁移影响。

OpenAPI 增加 11 个账户/资料/图片操作，Cookie 认证单独声明。常用请求体：

- `POST /api/login`：`{username,password,otp?}`；需要第二因子时返回 401 和 `mfa_required:true`。
- `POST /api/account/mfa/setup`：`{password}` → `{version,secret,uri,expires_at}`。
- `POST /api/account/mfa/enable`：`{version,otp}` → `{enabled,recovery_codes}`。
- `POST /api/account/mfa/recovery`、`/disable`：`{password,otp}`。
- `POST /api/tokens`：原有字段加 `otp?`；`POST /api/password`：`{current_password,new_password,otp?}`。
- `GET /api/account/security`、`GET /api/account/sessions`、`DELETE /api/account/sessions/:id`。
- `GET/PUT /api/profile`、`GET /api/profiles/:username?before=<cursor>`。

不要在日志、公开报告或 URL 中记录设置响应、验证码、恢复码或凭据。浏览器 Cookie 写请求必须提供同源 Origin。

## 持续目标

此版本完成基础 2FA、会话管理、个人资料/活动、Markdown 和安全栅格图片预览。跨 Fork MR、行级讨论、CODEOWNERS、合并队列、SSO、项目转移/归档、看板、完整 DAG 构建及包仓库仍在总目标内；没有声称完整兼容 GitLab YAML/API 或提供任意 Linux 构建。

实现参考：[RFC 6238](https://www.rfc-editor.org/rfc/rfc6238)、[markdown-it](https://github.com/markdown-it/markdown-it)、[qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)。浏览器依赖许可证位于 `public/THIRD_PARTY_LICENSES.txt`。
