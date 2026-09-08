# 版本记录

**简体中文** · [English](en/CHANGELOG.md)

v0.38 将主站迁移至 1s.hk，并增加简体中文/English 界面及双语文档。此前宽泛开发目标已按用户要求收敛至 v0.37 的已交付范围，后续功能另行规划；历史段落中的“目标继续”仅记录当时状态。

v0.37 增加 Jupyter Notebook 只读预览：代码高亮、Markdown、静态表格/图表、源码切换及分页，沿用仓库权限和固定提交。见 [Notebook 预览](NOTEBOOK-v37.md) 与 [验收记录](VERIFICATION-v37.md)。

v0.36 增加云端 tsconfig/JSONC、本地配置继承、baseUrl/paths 别名和 TypeScript 源文件扩展名解析。见 [构建配置](CI-TSCONFIG-v36.md)。

v0.35 增加 Cloudflare 原生构建的公共 npm R2 下载缓存：命中仍验证锁文件完整性，私有包保持独立授权路径，日志显示命中和下载量。见 [npm 缓存](CI-NPM-CACHE-v35.md) 与 [验收记录](VERIFICATION-v35.md)。

v0.34 让默认分支代码索引按仓库复用未变化、重命名和复制文件的内容，减少推送后的 D1 倒排写入；提供完整重建和复用统计。见 [内容复用](CODE-CONTENT-v34.md) 与 [验收记录](VERIFICATION-v34.md)。

v0.33 增加 GitHub/GitLab OAuth 登录，复用显式账户关联、MFA、受控注册和提供方会话/PAT 撤销；支持可信 GitLab 自托管实例。配置及边界见 [OAuth 登录](OAUTH-v33.md)，测试证据见 [验收记录](VERIFICATION-v33.md)。

v0.32 增加默认分支全局代码索引：DO 分批读取 R2 Git 快照，D1 倒排索引按当前权限检索，支持路径/扩展名筛选、固定提交行跳转、覆盖状态与重建。见 [代码搜索](CODE-SEARCH-v32.md) 与 [验收记录](VERIFICATION-v32.md)。

v0.31 增加 Cloudflare 持久合并队列：按目标分支排队，针对最新基线重新审阅并执行候选 CI，发布同一个通过检查的提交。可在分支保护中要求队列，支持取消、故障恢复和网页状态跟踪。详见 [合并队列](MERGE-QUEUE-v31.md) 与 [验收记录](VERIFICATION-v31.md)。

v0.30 增加 Workers/D1 内的自助密码找回：离线保存一次性密钥，保留双重验证，原子更新密码并撤销旧凭据。使用流程、恢复限制与接口见 [密码恢复](PASSWORD-RECOVERY-v30.md)，测试与云端浏览器证据见 [验收记录](VERIFICATION-v30.md)。

v0.28 增加跨项目协作搜索：项目、Issue、合并请求和当前 Wiki 统一检索，支持空间/状态/归档筛选、稳定分页与实时权限校验，见 [使用说明](SEARCH-v28.md) 和 [验收记录](VERIFICATION-v28.md)。v0.32 补充独立代码搜索范围，现有项目内 Git 搜索保留。

v0.27 支持当前实例内的私有 npm 依赖原生云构建：显式部署令牌授权、锁文件与 SHA-512 校验、独立 WASM 编译、工作流依赖撤权门禁，见 [私有包构建](CI-PRIVATE-PACKAGES-v27.md) 和 [本地/生产验收](VERIFICATION-v27.md)。

v0.26 增加项目/空间部署令牌：独立 Git 只读、包读取/发布/撤回权限，支持轮换、到期与撤销，跨空间转移自动收回范围，见 [部署令牌](DEPLOY-TOKENS-v26.md) 和 [本地/生产验收](VERIFICATION-v26.md)。

v0.24 增加空间级 CI 变量与密钥继承、项目覆盖、只读继承展示和跨项目撤销，空间所有者可集中管理团队构建配置，见 [空间变量](CI-WORKSPACE-VARIABLES-v24.md)。

v0.23 增加管理员配置的 OIDC 统一登录、账户关联、无密码账户注册、本地双因素校验及提供方会话/PAT 撤销，见 [统一登录](OIDC-v23.md)。身份验证和状态管理运行在 Workers 与 D1，实际提供方由管理员配置。

v0.22 增加 Cloudflare 内的 TypeScript/TSX、锁定 npm 依赖与 JS/CSS 构建，可生成 R2 产物并发布/回滚应用，见 [云端构建](CI-BUILDS-v22.md)。编译使用独立 Worker 和 WASM，不运行 shell 或 npm 生命周期脚本。R2 共享缓存见 [CI 缓存](CI-CACHES-v21.md)。

v0.15 增加有界 Git 对象暂态恢复、失败阶段诊断及并发写入验收，见 [Git 可靠性](GIT-RELIABILITY-v15.md)。v0.14 的版本化配置和依赖工作流见 [CI/CD](CI-WORKFLOWS-v14.md)。完整 GitLab/Gogs 目标和剩余工作见 [开发路线](ROADMAP.md)。

v0.13 为 Git 下载增加按已验证对象大小控制的四路预取，保持 8 MiB 预留预算、背压与取消排空，见 [预取契约及验证](GIT-PREFETCH-v13.md)。v0.12 的持久 Git 闭包索引、流式下载与浏览器修复见 [大仓库边界](GIT-SCALE-v12.md) 和 [验收记录](VERIFICATION-v12.md)。

v0.11 增加项目转移与重命名，保留项目 UUID 与代码/协作历史，重新计算空间权限并保护旧地址与在途写入。见 [转移契约](TRANSFER-v11.md) 和 [验收记录](VERIFICATION-v11.md)。

项目归档（v0.10）：所有者可在设置中归档/恢复，冻结 Git/LFS/协作内容与流水线写入，保留读取和已有应用。详见 [归档契约](ARCHIVE-v10.md) 与 [验证记录](VERIFICATION-v10.md)。

v0.9 增加 Issue 筛选与分页、标签看板、批量操作和并发编辑保护，见 [Issue 工作流](ISSUES-v09.md) 和 [验证记录](VERIFICATION-v09.md)。

v0.8 增加 CODEOWNERS 门禁、默认分支合并关闭 Issue、R2 双路并发与读取去重，见 [使用说明](REVIEWS-v08.md) 和 [验收记录](VERIFICATION-v08.md)。

v0.7 增加跨 Fork 合并请求、行级讨论与解决门禁、固定快照的目标仓库 CI，见 [审阅说明](REVIEWS-v07.md) 和 [验收记录](VERIFICATION-v07.md)；v0.13 补全创建表单、来源切换、讨论分页及审阅到实际合并的 headless Chromium 验收。

v0.6 新增双重验证、会话管理、个人资料/活动、Markdown 与私有图片预览，见 [账户与展示说明](ACCOUNT-v06.md) 与 [验收记录](VERIFICATION-v06.md)。完整 GitLab/Gogs 目标仍持续推进。

## v0.25 项目包仓库

新增真实 npm 与通用文件仓库：原生 publish/install/dist-tag/unpublish、作用域名称、R2 文件与完整性校验、当前项目权限、不可覆盖版本、异步回收和网页管理。用法、CI 接入及限制见 [包仓库](PACKAGES-v25.md)，本地和生产测试见 [验收记录](VERIFICATION-v25.md)。完整平台目标仍持续推进。
