# Cloudflare 原生 TypeScript / npm 构建

v0.35 更新：公共 npm 压缩包可以通过专用 R2 缓存跨构建复用，见 [缓存说明](CI-NPM-CACHE-v35.md)。下文无 R2 绑定、每次重新下载的描述记录 v0.22 初始实现。

`build` 步骤在独立的 `onestorage-build` Worker 中运行 esbuild 0.28.2 WASM。无需容器、Node 服务器或外部 Runner。控制面读取固定提交中的源码，通过私有 Service Binding 编译，再将产物、应用版本存入 R2，并沿用 D1 租约、工作流门禁、权限撤销和环境 CAS 激活/回滚。

此功能编译和打包 JS/TS/JSX/TSX、JSON、CSS；**不是任意 `npm run build` 的执行器**。不运行 npm 生命周期脚本、Vite/Next 配置、shell、原生插件或 TypeScript 类型检查。需要这些工具的项目仍可使用外部 Runner。构建 Worker 不接收 CI 密钥，没有 D1/R2/账户绑定，不执行输入源码；部署后的应用仍使用现有无出站网络、无账户绑定的 Dynamic Worker。

## 配置与界面

CI/CD 页面提供「TypeScript / npm 云端构建」模板，可保存页面配置或提交 `.onestorage-ci.json`。`build` 也可放在 DAG 的 Worker 子任务中。产物可由后续 JavaScript 步骤通过 `input.artifacts` 检查，由依赖任务读取，或用于应用发布。

```json
{
  "runner": "worker",
  "timeout_seconds": 110,
  "steps": [
    {
      "type": "build",
      "entry": "src/index.ts",
      "sources": ["src", "package.json", "package-lock.json"],
      "outfile": "dist/index.js",
      "platform": "worker",
      "minify": true,
      "sourcemap": false
    }
  ],
  "deploy": {
    "kind": "worker",
    "entry": "dist/index.js",
    "files": ["dist/index.js"],
    "environment": "production"
  }
}
```

`sources` 选择文件或递归目录，默认如上；只读取任务 SHA，不从活动分支读取。目录选择不展开 glob，不跟随符号链接或子模块。无需依赖时可省略 package 文件；若声明 npm 依赖则必须选择匹配的锁文件。`entry` 必须位于选择范围内。

浏览器入口使用 `platform: "browser"`，CSS 导入生成同目录同文件名 `.css`。静态部署时将源码 HTML 和所有生成的 JS/CSS 列入 `deploy.files`，HTML 使用相对资源路径。输出为 ES2022 ESM。JSX 默认 automatic/react，可设置 `jsx_import_source: "preact"`；transform 模式使用 esbuild 默认 JSX 工厂。不读取 tsconfig 或执行配置脚本，不支持 paths 别名、包 browser 对象映射、动态计算依赖、Node/Cloudflare 内建模块、原生模块和二进制 asset loader；遇到未解析导入或编译警告会使任务失败。源码地图为可选内联模式，会增加产物尺寸并包含源码。

## 锁定依赖与限制

- 支持 npm `package-lock.json` v2/v3 的 `packages` 布局，校验根 dependencies/devDependencies/optionalDependencies 与 package.json 一致。仅按实际导入按需下载锁定条目，支持嵌套 node_modules 版本和包 exports 条件；不解析浮动版本、不运行 npm install、不自动补缺失依赖。
- 每个锁定包必须有确切版本、public npm registry 的 HTTPS tarball 地址和 SHA-512 SRI。拒绝重定向、私有 registry、Git/文件依赖、workspace/link。先验证压缩包完整性，再在内存展开；校验 tar checksum、路径、版本、大小与文件数，不写文件系统，不跟随 archive 链接。当前只支持标准 tar 文件/目录，PAX/GNU 扩展头明确报错。
- 每步最多 256 源文件、单文件 1 MiB、源码合计 4 MiB；最多 64 个实际导入包、10,000 tar 条目、压缩合计 4 MiB、展开合计 8 MiB（包含 tar 头与填充）。JS/CSS 等文本模块进入虚拟文件系统。
- 生成产物单文件 1 MiB，整任务最多 10 文件、JSON 合计 2 MiB。WASM 编译 60 秒，Service Binding 总请求 75 秒，任务仍受原有 110 秒 Worker/租约期限约束。源码读取和发布也消耗任务时间，限额不是最大规模吞吐承诺。
- 同一编译实例一次处理一个任务，忙时控制面最多重试十次，避免两个 WASM 构建共享峰值内存。超限或失败须新建/重试任务；不会生成可激活的失败版本。编译并行度仍受 Cloudflare 实例调度影响。
- npm 包目前每次构建重新读取公共 registry，不持久保存下载缓存；v0.21 的 R2 项目缓存仍供 JavaScript 步骤和外部 Runner 使用。本轮不宣称完整 npm/pnpm/yarn 或 GitLab YAML 兼容。

## 自托管

先 `npm run deploy:build`，再 `npm run deploy`。新增 Worker `onestorage-build` 禁用 workers.dev 与 preview URL，只由主 Worker 的 `BUILDER` Service Binding 调用。没有数据库迁移，不修改 `onestorage-apps` 或 `1s.hk`。

`npm run dev` 同时启动主 Worker 和编译 Worker；已有独立主进程可额外运行 `npm run dev:build`（8788）。应用网关验收需要另一个配置到同一**本地** D1/R2 的实例，默认 `TEST_APPS_ORIGIN=http://localhost:8789`。生产验收使用现有独立应用域名。

运行 `npm run check`、`npm run test:builds`、界面与现有核心/工作流回归。构建专项会创建临时私有空间，验证真实 TSX/npm 编译、R2 下载、Worker 激活和回滚、失败不发布、静态 JS/CSS，并清理项目及空间。远程必须设置 `ALLOW_REMOTE_ACCEPTANCE=1`、`TEST_ORIGIN` 和权限为 600 的 `ONESTORAGE_TOKEN_FILE`。等待完整清理后才能编辑或部署。

实现参考：[esbuild browser/WASM API](https://esbuild.github.io/api/#browser)、[npm lockfile](https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json/)、[Cloudflare Service Binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)。Cloudflare 官方 worker-bundler 展示了 Workers 内编译可行性，本项目为强制锁文件、完整性验证及多产物处理实现了独立受限解析器。

## v0.22 验收记录

2026-09-08 完成类型检查及 245 项单元测试。新增测试覆盖锁文件版本/声明一致性、下载地址/完整性、嵌套包解析、条件 exports、tar 路径/链接/校验和/解压限额。生产 dry-run 通过：主 Worker 压缩约 636 KiB，编译 Worker 约 3.8 MiB，编译代码不进入 Git Worker 包。

- 本地构建专项通过 23 项检查、47 次 API 请求；生产通过 23 项检查、61 次 API 请求。真实 Preact 10.29.3 包在 Worker 中校验 SHA-512 后编译 TSX，生成 R2 产物并由 Dynamic Worker 执行；两次发布、CAS 回滚与过期激活拒绝均通过。错误 SRI 和 `node:fs` 导入使流水线失败，不产生发布版本。浏览器 JS/CSS 和 HTML 在独立应用域名成功返回。
- 生产构建空间 `build_v22_68cf81db`：首次任务 `97b0ec2a-1e9a-40c9-9901-5b70a4c46397`，第二次 `d3fbb910-a9d0-406e-9f96-be9211b37faa`，完整性拒绝 `2087f78f-bebd-4afa-9f37-677393062487`，静态构建 `06df8874-3aaf-4124-be10-f19f3e238744`。临时项目、空间与应用均已清理。
- 核心回归通过 43 次 API 断言及真实 Git/LFS；既有工作流通过 23 项检查、97 次 API 请求，包含外部 Runner 和发布门禁。原生 Git 本地 22 项、生产 21 项检查（轮询次数影响计数）：push → 固定配置 DAG → clone → 严格 fsck。生产提交 `f711f54f8c7acb91ddde443c21155e43b314081b`，工作流 `9c1fb6bd-5ebd-496a-8c7f-c4cb06f67e2b`；测试空间已清理。
- 无头浏览器通用界面 43 项、工作流界面 19 项检查通过，包括新模板、读者权限和移动布局。所有本地测试项目/空间已清理；浏览器测试账户停用、临时会话和令牌撤销。
- 首次本地构建验收遇到独立 Wrangler 进程共享状态目录的 SQLITE_BUSY，编译服务离线导致明确失败；夹具清理后，隔离编译状态目录重跑成功。更新后的 `npm run dev` 多 Worker 单进程启动与 `BUILDER` 连接已另行验证。无数据库迁移，现有应用网关未重新部署。

验收使用小型实际应用，并不代表所有 npm 生态或最大资源边界已通过压力测试。完整 GitLab/Gogs 目标继续按 [路线图](ROADMAP.md) 推进。

## v0.27 私有包云构建

原生 Worker 编译现可通过显式选择的密钥变量和项目/空间部署令牌读取本实例私有包；只把完整性校验后的包内容交给编译服务。授权、限额及客户端用法见 [私有包构建](CI-PRIVATE-PACKAGES-v27.md)。
