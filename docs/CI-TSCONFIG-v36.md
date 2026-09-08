# Workers 构建中的 tsconfig

**简体中文** · [English](en/CI-TSCONFIG-v36.md)

`build` 可以读取所选源码中的 `tsconfig.json`，或通过 `tsconfig` 字段指定另一份配置。支持 JSONC 注释和尾逗号、相对路径 `extends`（含父配置数组）、`baseUrl`、`paths` 和部分影响转译的 TypeScript 选项。所有配置和源文件必须属于本次固定 Git 提交、位于 `sources` 选择范围内；不会读取部署机器文件或下载外部配置。

```json
{
  "runner": "worker",
  "steps": [
    {
      "type": "build",
      "entry": "src/index.tsx",
      "sources": [
        "src",
        "config",
        "tsconfig.json",
        "package.json",
        "package-lock.json"
      ],
      "tsconfig": "tsconfig.json",
      "outfile": "dist/index.js"
    }
  ]
}
```

例如根配置继承 `./config/base.json`，父配置可写：

```json
{
  "compilerOptions": {
    "baseUrl": "..",
    "paths": { "@app/*": ["src/*"] },
    "jsx": "react-jsx",
    "jsxImportSource": "preact"
  }
}
```

`@app/label.js` 可以解析到 `src/label.ts`；也支持 `.mjs` → `.mts`、`.cjs` → `.cts` 的项目源码替换。别名精确匹配优先，否则选择星号前缀最长的一条，按目标数组顺序尝试；未找到后尝试 `baseUrl`，最后按现有 npm 锁文件解析。项目配置不改变 `node_modules` 内依赖的解析，也不能通过别名绕过锁文件直接读 `node_modules`。

继承中后面的父配置优先，当前文件的选项覆盖父配置；子配置的 `paths` 整体替换继承映射。相对 `baseUrl` 基于定义它的配置文件；没有有效 `baseUrl` 时，`paths` 基于定义映射的配置目录。越出源码根目录、外部 URL、包配置继承、缺失配置、循环或超限会报错。每个配置最多 64 KiB，最多 16 份不同配置，继承深度最多 8 层；别名最多 128 条，每条最多 16 个目标、一个星号。

支持传给 esbuild 的运行时选项：`alwaysStrict`、`strict`、`experimentalDecorators`、`useDefineForClassFields`、`verbatimModuleSyntax`、`preserveValueImports`、`importsNotUsedAsValues`、`jsxFactory`、`jsxFragmentFactory`、`jsxImportSource`，以及 `jsx: react | react-jsx | react-jsxdev`。步骤显式设置的 `jsx` 与 `jsx_import_source` 优先；无配置且无显式值时保持 automatic/react。旧流水线中已有的显式 JSX 字段需要移除后才会采用 tsconfig 对应设置。

这里仍是 WASM 编译与打包，不执行 tsc 类型检查。目标固定 ES2022/ESM，`target`、`module`、类型检查相关选项不改变该输出契约；`include`/`exclude`/`files` 不扩大或缩小步骤选择的源码范围。不支持项目 `references` 构建图、npm 包形式的 `extends`、Vite/Next 配置或 npm 生命周期脚本。原有源文件、依赖和产物预算保留，私有包权限与公共 R2 缓存规则不变。

参考：[TypeScript 模块解析](https://www.typescriptlang.org/docs/handbook/modules/reference.html#paths)、[esbuild tsconfigRaw](https://esbuild.github.io/api/#tsconfig-raw)、[Microsoft JSONC parser](https://github.com/microsoft/node-jsonc-parser)。验收命令为 `npm run check` 和 `npm run test:tsconfig`；远端沿用独立项目及显式授权的验收流程。

## 验证进度

类型检查及 363 项测试通过，包括真实 DO 回归、配置继承与路径隔离、循环/越界/缺失拒绝、重复继承只解析一次。重复继承缓存加入前，本地实际 Workers 构建通过 24 项检查、49 次 API 请求：继承 JSX、别名、扩展名替换、发布/回滚、循环配置拒绝和静态产物均通过，夹具清理完成。初始生产编译版本通过 24 项检查、71 次 API 请求。随后修正普通目录名包含 node_modules 字样时的误判，最终编译 Worker `dc3c65bc-9566-4e88-8117-60222ab9e124` 通过 24 项检查、88 次 API 请求，额外验证从该普通目录再次导入别名；主 Worker 的配置接口保持同一已验收实现。实际源码与配置均按任务提交读取，错误 SRI、不支持的原生模块和循环配置均使构建失败；Worker 激活、回滚和静态 JS/CSS 继续通过。本地及两轮生产夹具均已清理。实际 D1 查询确认各测试空间、项目、流水线、发布版本、代码索引状态、路径文档和索引内容均为零。无数据库迁移，schema 保持 0027；最终文档发布不改变已验收的运行时代码。
