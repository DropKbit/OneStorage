# 参与贡献

**简体中文** · [English](CONTRIBUTING.en.md)

OneStorage 按 AGPL-3.0-only 接收贡献。

1. 阅读 [架构设计](https://1s.hk/docs/zh-CN/ARCHITECTURE.html)，尤其是先写 R2、后发布引用的顺序以及授权检查。
2. 安装 Node.js 22.13+ 和 npm。原生 Git、tar 仅供测试使用，不是服务运行时依赖。
3. 运行 `npm ci`、`npm run dev`。Wrangler 同时启动 8787 上的 Git 服务与私有 WASM 编译服务；`npm run dev:build` 可单独在 8788 启动编译服务。
4. 协议、存储或鉴权变更需运行 `npm run check`、`npm run test:e2e`、`npm run build:production`。用原生 Git 作独立兼容性对照，为实际失败补充有针对性的回归检查。
5. 使用 `npm run format` 格式化；说明最终行为、验证结果和迁移影响。新增编号 SQL migration，不修改已应用的迁移。

不要在服务运行时引入 Containers、shell 进程或原生 Git；不要在 Git 接收路径执行仓库代码/Hook、信任调用者指定的存储 ID、在持久化之前确认写入、绕过角色校验或保存明文密码/令牌。只有操作者允许的 Webhook 接收端可以接收事件。CI 的仓库代码必须在单独授权的隔离环境执行。

本地 E2E 创建 `e2e_` 测试数据并拒绝非回环主机。不要为访问生产数据库而放宽这个限制。云端验收使用独立、范围明确的脚本及临时凭据和数据。`.data`、`.wrangler`、`.dev.vars` 和所有凭据都不能提交到 Git。

## 界面与多语言

浏览器变更需在本地运行 `npm run test:ui`。可选 Playwright 安装命令为 `npm install --no-save --package-lock=false playwright`；用 `CHROME_EXECUTABLE` 指定已安装的 Chrome/Chromium，或执行 `npx playwright install chromium`。也可用 `PLAYWRIGHT_MODULE` 指定已有安装的 `index.mjs` 绝对路径。测试使用隔离浏览器上下文和临时仓库/空间，清理时停用测试用户，截图写入 `.data/v12-ui`，不会使用操作者浏览器配置。必须等待清理完成后再编辑 Worker 或重建资源，避免 Wrangler 热重载打断验收。

界面只对应用自有字面量使用 `i18nText` / `i18nHTML`。英文文案维护在 `src/i18n/en.json`；不要将完整页面或用户内容传入翻译函数。占位符必须保留，日期使用 `getLocale()`。`npm run check` 检查文案覆盖和占位符；`npm run test:i18n` 验证双语页面、偏好保存与用户内容保持原样。根目录文档使用 `*.md` / `*.en.md` 维护中英文。`docs/` 为仅本地保存的补充文档，不提交 Git，也不进入源码下载包；没有该目录的新克隆仍能构建根目录的双语文档。

## 专项验证

- 跨 Fork 审阅：先 `KEEP_REVIEW_FIXTURE=1 npm run test:reviews`，再 `npm run test:review-ui`，使用同样的 Playwright 配置。覆盖来源选择、分支加载、创建请求、Diff 两侧、讨论/回复分页、审阅与 CI 门禁以及真实合并。主测试仓库留作检查，关闭分页请求、删除额外 Fork、退出隔离会话。再次运行前建立新数据，因为已完成的合并不可逆。截图在 `.data/v13-review-ui`，凭据只存在被忽略的 `.data`。
- CI 工作流：运行 `npm run test:workflows`，覆盖真实 Dynamic Worker、版本化配置、取消/发布门禁和仓库提供的外部 Runner。`npm run test:workflow-git` 验证原生 push、自动工作流、clone 和严格 fsck；`npm run test:workflow-ui` 验证配置模式、任务导航、快照重试、移动布局和 Reader 权限。等全部临时数据清理后再改运行时代码或资源。
- Git 持久化：另运行 `npm run test:git-reliability`，覆盖多次 API 提交、并发 expected-SHA 写入、旧 SHA 拒绝、增量 push/fetch 和 clone/fsck。提供方故障用例在 `tests/git-reliability.test.ts`；不得向生产存储注入故障。远程脚本需 `ALLOW_REMOTE_ACCEPTANCE=1`、`TEST_ORIGIN` 和私有 `ONESTORAGE_TOKEN_FILE`。生产诊断仅保存脱敏字段。
- 定时 CI：运行 `npm run test:schedules` 与 `npm run test:schedule-ui`。前者等待真实 Cron/Queue 触发，在 Cloudflare 上最长约九分钟。后者使用可选 Playwright。清理完成前不重建或部署；远程验收需显式启用与私有令牌文件。
- CI 变量：运行 `npm run test:variables`（真实 Worker、外部 Runner、租约、轮换、日志脱敏）和 `npm run test:variable-ui`（只写值、编辑、权限、移动端）。同样遵守清理与远程启用规则。测试值不能使用真实部署凭据。
- 共享 CI 缓存：运行 `npm run test:caches` 和 `npm run test:cache-ui`，验证真实 Worker/外部 Runner 复用、失败工作流隔离、代际失效、租约拒绝、有界解包、配额和最终 R2 回收。等待清理后再改代码或部署。
- 原生 TypeScript/npm 构建：运行 `npm run test:builds`，应用网关需连接相同的本地 D1/R2；`TEST_APPS_ORIGIN` 默认 localhost:8789。服务发布顺序、依赖限制和验收见 [云端构建](https://1s.hk/docs/zh-CN/CI-BUILDS-v22.html)。本地测试网关不得连接生产存储。
