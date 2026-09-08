# v0.6 验证记录

日期：2026-09-08。目标仍处于进行中；此记录仅覆盖账户安全与展示增量，不代表完整 GitLab/Gogs 兼容。

## 自动验证

| 检查 | 结果 |
| --- | --- |
| `npm ci --ignore-scripts` | 从锁文件重新安装成功，审计 0 漏洞；随后重新运行类型/单元测试和生产构建通过 |
| `npm run check` | TypeScript 通过，83/83 单元测试通过 |
| `npm run test:e2e` | 43 项基础 API 断言及真实 Git clone/push/clone、pack、并发、LFS、R2/DO 持久化通过 |
| `npm run test:features` | 76 项高级 HTTP 验证通过：JWT、撤销、引用策略、临时命名空间、流式提交、Notes、Range、Fork、生命周期 |
| `npm run test:git-features` | 原生 Git 签名提交、未签名/撤销拒绝、临时与导入 remote、Notes 通过 |
| `npm run test:parity` | 51 项 Code Storage 对照能力具有实现与验证映射 |
| `npm run build:production` | Wrangler 生产构建通过 |
| `scripts/e2e-account.mjs` 本地 | 41 项请求检查通过；显式保留临时账户供浏览器视觉验收 |
| 同脚本真实 Cloudflare | 43 项请求检查通过；包含临时账户停用、凭据撤销、仓库软删除、停用用户资料 404 |
| OpenAPI | 113 个操作，11 个新增账户/资料/预览操作；浏览器 Cookie 认证独立声明 |

单元验证新增 RFC 4226/6238 标准向量、TOTP 单调时间窗、密钥非明文存储、恢复码并发只成功一次、设置过期与版本替换、密码校验、按账户验证码限流、恢复码轮换/关闭双重验证、匿名资料权限过滤、Markdown XSS 与远程图片防自动加载。专门模拟登录过程中认证版本失效、启用过程中会话撤销、创建 PAT 时认证版本改变，均拒绝陈旧状态操作。

真实 HTTP 验收使用每轮随机生成的普通账户，不启用或更改真实管理员的 MFA。验证启用后旧会话失效、登录要求验证码、已用验证码/恢复码拒绝、PAT 创建需要第二因子、PAT 不能管理账户安全、单独撤销会话、轮换恢复码后旧码失效、改密撤销全部凭据，以及私有 PNG 精确字节/MIME/缓存头/匿名拒绝/SVG 拒绝。

本地反复验收曾触发登录速率限制；只清除了本地测试 D1 的 `login_limits` 后继续，生产速率限制未修改。首次新增验收脚本将撤销后的 Bearer 预期写为 200，实际正确返回 401；修正断言后本地与线上通过。

## 浏览器

在本地使用独立临时普通账户验证：登录 OTP 输入、账户安全状态与会话列表、个人资料编辑/查看、README 标题/任务清单、JavaScript 代码高亮、私有 Markdown 图片加载，以及直接打开 PNG 的独立图片预览。图片实际解码成功（naturalWidth=1），代码关键字生成高亮节点，浏览器未报告 JavaScript 错误。二维码 bundle 使用固定的非生产 RFC 测试密钥生成有效 212×212 GIF；完整第二因子设置协议由 HTTP 和单元测试覆盖。

## 生产与源码

生产 D1 已备份，增量 `0007_account_security.sql` 已应用。主 Worker 发布于 `git.1s.hk`，健康检查返回 `0.6.0`。本轮不需要更新应用发布网关。`1s.hk` 返回 200 且保留 Cubelink 页面。

源码压缩包由显式允许列表构建；检查确认不含部署 PAT、生产加密密钥或初始化密钥。临时认证文件保存在忽略的 `.data` 并在交付后移除；数据库备份与部署记录不分发。Git 提交、最终 Worker 版本、源码 SHA-256 与镜像 `git fsck` 结果记录在本地 `.data/release-v06.json`。

限制见 [账户与展示说明](ACCOUNT-v06.md) 和 [持续差距矩阵](CLOUD-NATIVE-v05.md)。SSO、跨 Fork MR、行级讨论、完整构建 DAG、项目管理深化、包仓库等仍待开发。
