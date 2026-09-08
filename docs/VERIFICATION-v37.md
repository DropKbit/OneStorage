# v0.37 Notebook 验收记录

## 实现范围

nbformat 4 只读预览、语言高亮、Markdown、静态 HTML 表格、PNG/JPEG 输出与附件、纯文本/错误/JSON、分页、源码切换和固定提交链接。源码为 `src/browser/notebook.js`、`notebook-model.ts`，复用 Markdown、高亮和现有 Git/图片鉴权接口。完整支持范围与限额见 [Notebook 说明](NOTEBOOK-v37.md)。

本次只发布主 Worker；D1 schema 0027、R2/DO/Queues 配置、构建 Worker 和应用发布 Worker 均未改变。

## 自动化验证

- TypeScript 检查通过，367 个单元测试全部通过。
- 生产配置 dry run 通过；新增浏览器模块通过静态资源路由和缓存回归。
- 本地完整验收 33 项 API/浏览器检查，生产 32 项；差异是本地多一次管理员登录，生产使用已有 PAT。
- 两个环境均建立真实私有仓库，通过 commit-files 写入 Notebook 和 PNG。预览显示 30 个单元，首批 25 个、加载更多后 30 个；Python 高亮、表格、PNG 输出与附件正确。
- 恶意 HTML 的脚本、事件、SVG、iframe、表单、样式、链接和外部图片被过滤；JS/SVG MIME 未执行。浏览器记录外部请求 0、page error 0，脚本标记未改变。
- JSON 源码与原始文件一致，`#L10`、`#nb-cell-30` 正常；移动端无页面水平溢出。无效 JSON 和 nbformat 3 提示原因并允许查看源码。
- HEAD 后续改变不影响固定提交预览或相对图片的 SHA。reader 能读取；撤权后 JSON 与图片均 404，刷新页面不再显示 Notebook；未登录读取私有文件 401。

第一次本地运行在“未登录应返回 404”的错误测试预期处失败；实际接口返回既有 401。修改测试预期后重新运行完整验收成功，未改变权限实现。首次失败 fixture 也完成清理。

验收脚本 `scripts/e2e-notebook.mjs` 在退出前删除仓库、禁用测试用户并撤销会话，再通过真实 D1 查询检查 repositories、credentials、enabled_users、code_documents、code_index_state、code_contents 均为零。隔离 fixture 的用户行保留禁用状态，未删除审计用户标识。

线上静态文件逐字节对照本地发布产物，版本健康检查、无效凭据的浏览器/Git 鉴权语义，以及 `1s.hk` Cubelink 保留检查均通过。源代码归档使用原有显式文件允许清单，任务私有状态不发布。

## 未包含

Notebook 预览不运行 Python/Jupyter kernel，不执行脚本图表、MathJax 或 widget。未重新跑之前版本的全部云端 Git/CI 压力验收；相关单元测试通过，本次未改动其运行时代码。本轮交付范围止于 v0.37，不代表所有 GitLab 功能均已实现。
