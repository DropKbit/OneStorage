# OneStorage

**运行在 Cloudflare 上的开源 Git 协作平台。**

像使用 GitLab / Gogs 一样托管代码、管理团队和审阅变更。Git 服务由 JavaScript 在 Workers 中实现，数据保存在你自己的 Cloudflare 账号中，无需服务器、Docker 或容器。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2FDropKbit%2FOneStorage%2Ftree%2Fdeploy)

[在线体验](https://git.1s.hk) · [GitHub](https://github.com/DropKbit/OneStorage) · [自托管仓库](https://git.1s.hk/1shk/nb) · [部署指南](docs/DEPLOYMENT.md) · [版本记录](docs/CHANGELOG.md)

## 能做什么

- **代码托管**：公开 / 私有仓库，HTTPS clone、push、fetch，分支、标签、Fork、Git LFS 和上游同步。
- **代码浏览**：语法高亮、文件历史、Diff、Blame、跨项目搜索，以及 Markdown、图片和 Jupyter Notebook 预览。
- **团队协作**：多工作空间与切换、角色权限、Issue / 看板 / 里程碑、合并请求、行级讨论、CODEOWNERS 和受保护分支。
- **CI/CD**：推送与定时触发、日志、变量 / 密钥、缓存和产物；云端构建 TypeScript / TSX、JS / CSS 与锁定 npm 依赖，支持应用发布和回滚。
- **项目管理**：npm / 通用包仓库、版本发布、Wiki、通知、审计日志和管理员后台。
- **账户与集成**：访问令牌、双重验证、OAuth / OIDC 登录、Webhook、REST API、MCP，以及 TypeScript / Python / Go SDK。

## 如何运行

完整实例由三个 Worker 组成：**主服务**处理 Git、网页和 API，**编译服务**使用 WASM 构建代码，**应用网关**在独立域名提供已发布的应用。

| Cloudflare 服务           | 用途                                     |
| ------------------------- | ---------------------------------------- |
| Workers + Static Assets   | 网页、鉴权、Git HTTPS 协议和 API         |
| Durable Objects           | 每仓库协调写入，原子更新分支 / 标签引用  |
| R2                        | Git 对象、LFS、包文件、构建产物与缓存    |
| D1                        | 用户、权限、协作内容、搜索索引和任务状态 |
| Queues + Cron + DO Alarms | 后台任务、事件投递、重试与清理           |
| Worker Loader + WASM      | 隔离执行云端任务、编译和应用运行         |

一次推送的主要路径是：**Git 客户端 → 主 Worker 校验权限 → 仓库 DO 协调 → R2 保存对象 → DO 发布引用**。提交后的索引、CI 和通知由后台任务处理。详见 [架构设计](docs/ARCHITECTURE.md)。

## 部署到 Cloudflare

点击上方 **Deploy to Cloudflare**，从 `deploy` 模板分支创建自己的实例：

1. 连接 GitHub 与 Cloudflare，选择项目名及新建的 D1、R2、Queue 资源。
2. 填写初始化密钥 `BOOTSTRAP_SECRET` 和凭据加密密钥 `CREDENTIAL_ENCRYPTION_KEY`，服务地址会自动生成。
3. 部署完成后打开主 Worker 的地址，使用初始化密钥创建管理员。

模板自动迁移数据库，依次部署编译服务、应用网关和主服务，并连接共享存储与服务地址。需要相应 Cloudflare 服务额度及部署权限；详见 [部署说明](docs/DEPLOYMENT.md#关于一键部署)。已有实例升级请保留原有资源和加密密钥。

## 本地体验

需要 Node.js 22.13+ 和 npm：

```sh
git clone https://git.1s.hk/1shk/nb.git onestorage
cd onestorage
npm ci
npm run dev
```

打开 [localhost:8787](http://localhost:8787)，使用初始化密钥 `local-development-only-change-me` 创建管理员，密码至少 12 个字符。这个密钥仅供本地开发；Git HTTPS 认证使用个人访问令牌（PAT）作为密码。

## 使用范围

当前为 **v0.37 alpha**。云端 CI 支持 JS / WASM，不运行任意 shell、Python 或 npm 生命周期脚本；通用命令构建可接入自行管理的外部 Runner。暂不支持 SSH Git 传输、shallow / partial clone，也不兼容全部 GitLab API。容量与大仓库限制见 [使用边界](docs/LIMITS.md)。

[部署与恢复](docs/DEPLOYMENT.md) · [CI/CD](docs/CI-BUILDS-v22.md) · [API](docs/API.md) · [SDK](docs/SDK.md) · [贡献](CONTRIBUTING.md) · [安全](SECURITY.md)

采用 [AGPL-3.0-only](LICENSE) 开源协议；修改后提供在线服务时，须向用户提供相应源码。项目参考 [Code Storage 文档](https://code.storage/docs/) 独立实现，与 Code Storage、GitLab、Gogs 或 Cloudflare 无隶属关系。
