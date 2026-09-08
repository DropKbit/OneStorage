# 私有 npm 依赖的原生云构建

v0.27 的 `build` 步骤可以混合使用公开 npmjs 依赖和当前 OneStorage 实例内的私有 npm 包。主 Worker 按固定提交的锁文件从 R2 读取包，校验完整性后将包内容传给独立 WASM 编译 Worker；编译服务没有账户存储绑定，也不会接收部署令牌或 CI 变量值。构建不需要容器或外部 Runner。

## 使用

1. 在包所在项目或空间创建具有 `read_package_registry` 权限的部署令牌。
2. 在构建项目的 CI/CD 页面创建名为 `PACKAGE_TOKEN` 的**密钥**变量，配置允许分支和保护条件。变量也可由空间继承。不要把令牌写入 Git 文件、锁文件或配置 JSON。
3. 使用 npm 对该包仓库安装依赖，提交 `package.json` 与 npm v2/v3 `package-lock.json`。锁文件须包含当前项目地址、固定版本和 SHA-512 完整性值。
4. 选择「私有 npm 云端构建」模板。模板默认使用构建项目自己的包仓库；跨项目依赖应将 `project_id` 改为包仓库项目的 UUID。UUID 可从项目 API `GET /api/repos/:namespace/:repo` 的 `id` 字段取得。

```json
{
  "runner": "worker",
  "variables": ["PACKAGE_TOKEN"],
  "timeout_seconds": 110,
  "steps": [{
    "type": "build",
    "entry": "src/index.ts",
    "private_registries": [{
      "project_id": "00000000-0000-4000-8000-000000000001",
      "token_variable": "PACKAGE_TOKEN"
    }]
  }],
  "deploy": {
    "kind": "worker",
    "entry": "dist/index.js",
    "files": ["dist/index.js"],
    "environment": "production"
  }
}
```

UUID 为示例，须替换。`private_registries` 最多 8 项，不能重复项目，且每个凭据变量必须同时列入该任务的 `variables`。只允许标记为密钥的变量以及 OneStorage 部署令牌，不会自动使用用户的 PAT、当前会话或整个空间权限。一个空间部署令牌可配置到多个明确列出的项目。

npm 客户端配置见 [部署令牌](DEPLOY-TOKENS-v26.md)。成功后在「应用发布」激活或回滚，沿用既有固定 SHA、环境比较交换和工作流门禁。

## 授权与固定输入

主 Worker 校验地址属于当前 `APP_ORIGIN`，对应当前项目地址、配置的项目 UUID、令牌范围、文件名、包名、版本和 SHA-512；随后从内部 R2 对象读取字节，不向锁文件地址发送携带凭据的网络请求。不跟随旧项目地址跳转，不接受 URL 用户名/密码、查询令牌、第三方私有 registry、Git/file/link 依赖。重命名后应重新生成锁文件中的地址。

凭据先经过现有 CI 密钥的分支、保护、当前提交、MR 来源、租约与所有者权限检查。未可信授权的 MR 不能借构建读取私有包。包读取前后还检查部署令牌；完整性检查后，编译 Worker 收到的只有源文件、编译选项和有界的包内容。编译过程不执行包的生命周期脚本。

`ci_run_packages` 保存依赖文件、项目生命周期和部署令牌散列/版本快照，不保存原文。令牌轮换、撤销或到期，包撤回、删除或项目转移导致授权失效时，尚未完成的工作流与任务不得继续发布产物、应用或缓存；D1 在最终写入时也执行检查。同一工作流中已完成构建任务的依赖授权继续约束父工作流和其他任务。主动撤销事件取消未完成的运行，自然到期在读取和发布时检查，不依赖 Cron 及时触发。

已经成功完成的流水线，其产物保留为历史输出；之后撤销下载凭据不会删除它们，也不会下线已经激活的应用。父工作流仍未完成时，单个子任务成功不代表整个发布已完成，依赖撤权门禁仍有效。若要停止现有发布，应在应用环境中关闭或切换版本。撤销前已交付给授权任务的字节无法收回。

## 限额与支持范围

控制面预加载锁文件中的所有私有包，包括本次入口未实际导入的私有条目；公开包继续按导入按需获取。每步最多 64 条私有锁条目，私有包压缩总量最多 4 MiB，重复 URL 只传输一次。编译器将全部传入私有包和实际下载的公开包一起计入 4 MiB 压缩预算；展开/文件/源码/产物限额沿用 [原生构建](CI-BUILDS-v22.md)。主 Worker 到编译服务的有界 JSON 请求上限为 12 MiB。

此版本没有依赖包下载缓存，不从 npm tag 推断版本，不执行任意 `npm run build`。私有 npm 包名与锁文件安装位置须匹配；npm alias、扩展 tar 头、原生模块和其余现有编译器不支持的工具链仍需后续扩展。包仓库本身可以存储比编译预算更大的包；上传成功不代表该包可在受限云编译器内使用。

迁移新增 `0022_ci_private_packages.sql`。自托管先备份并应用 D1 迁移，再发布编译 Worker 和主 Worker；编译协议向后兼容原有公开包请求。验收脚本为 `node scripts/e2e-private-builds.mjs`，覆盖真实 npm 发布/锁文件、混合 TSX 编译、R2 输出、激活/回滚、浏览器模板、无效锁与未授权输入、轮换失效/更新密钥恢复及撤销拒绝。远程验收必须显式设置 `ALLOW_REMOTE_ACCEPTANCE=1` 和私密 `ONESTORAGE_TOKEN_FILE`。

锁文件字段依据 [npm package-lock.json 文档](https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json/)；此功能沿用 OneStorage 独立的 CI 配置，不宣称 GitLab YAML 或全部 npm 构建生态兼容。
