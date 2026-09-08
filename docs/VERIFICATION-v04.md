# v0.4 验证记录

**简体中文** · [English](en/VERIFICATION-v04.md)

2026-09-08。基线 `8b5653c`（v0.3.1）。平台功能与边界见 [平台指南](PLATFORM-v04.md)。

## 本地

- `npm run check`：TypeScript 与 **66 项测试通过**。新增覆盖空间继承/撤销/最后所有者/最后管理员、CI 配置边界、推送幂等、独占领取、超时不重放、取消、Queue 发布失败后的 D1 outbox 恢复、Worker 读取真实源码、高亮转义与降级。
- `npm run test:platform`：最终 **62 项 HTTP 断言通过**。包括工作空间创建、命名空间冲突、空间项目/URL/列表权限、创建者移出空间后立即失权、管理员停用与 PAT/密码拒绝、推送触发 Worker 检查、真实外部 Runner 执行 `npm ci && npm test`、日志脱敏、R2 产物、独占领取、取消后不能补报成功、Runner 撤销与管理员仓库管理。
- `npm run test:e2e`：原有 **43 项 API 断言与原生 Git、并发、LFS 流程通过**。
- `npm run test:features`：**76 项高级 HTTP 检查通过**；`npm run test:git-features` 签名推送/撤销、Notes、临时/导入远程通过。
- `npm run test:sdks`：TypeScript、Python、Go SDK 通过。
- `npm run build:production` 通过；所有模块导入均校验内容哈希，管理与高亮模块按需加载。
- 浏览器检查了空间切换入口、实际管理员用户列表、CI 配置/运行列表；文件页面有真实 `hljs-attr` 元素和行号，源码文本未被修改。

开发期间修复了 Runner 在 macOS `/var` 与 `/private/var` 的目录判断错误。一次热更新期间本地手动检查排队超时，保持服务稳定后重跑通过；另一次连续登录测试触发正确的限流，清理**仅本地**测试限流状态后重跑。失败运行不计入通过项。

## Cloudflare

D1 导出初次鉴权失败，重试后成功；备份保留为操作者本地 0600 文件。迁移 `0005_workspaces_ci.sql` 成功，不重建现有存储与仓库。首次平台部署版本为 `95e2158e-65bc-4be4-926a-bc672005ad54`。

`verify-platform.mjs` 对临时空间 `accept_v04_89cc6d1a` 完成 **26 项核心线上检查**：空间创建、空间仓库与继承角色、匿名拒绝、推送触发 Worker CI、手动 CI、外部 Runner 执行 `npm test`、日志、产物内容与固定 SHA 一致、撤销 Runner、管理员仓库元数据更新。实际使用 Cloudflare Queue / D1 / R2 / Durable Objects。

首次验收脚本的清理等待仅 30 秒，短于仓库既有的 60 秒延迟垃圾回收，因此核心检查通过后清理阶段超时。随后确认回收正常，手动删除该临时空间返回 200；脚本等待窗口已改为 120 次重试，并在清理完成后才输出最终 PASS。没有缩短生产回收窗口或绕过权限删除真实项目。

通用 Runner 已通过本地服务和线上服务验收；**未配置用户的永久构建主机，也未使用真实部署密钥让 Runner 发布任意目标项目**。Cloudflare 部署模板调用真实 `npx wrangler deploy`，需要操作者提供目标项目配置及账户凭证。OneStorage 自身仍用已授权的 Wrangler 会话部署；不会把该会话复制进 Runner。
