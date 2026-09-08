# 项目 CI 变量与密钥（v0.20）

在仓库「CI/CD → CI 变量与密钥」中创建变量。维护者及所有者可管理，普通成员不可读取管理接口；管理员仍需项目权限。所有值（包括普通变量）使用 AES-GCM 加密后写入 D1，管理 API 仅返回名称、作用域、版本及权限等元数据，值提交后不再显示。部署需配置已有的 `CREDENTIAL_ENCRYPTION_KEY`，备份时单独保存该密钥，不能直接轮换后丢弃旧密钥。

## 使用

单任务或工作流子任务配置显式声明名称和环境：

```json
{
  "name": "Production build",
  "runner": "worker",
  "environment": "production",
  "variables": ["API_TOKEN", "LABEL"],
  "steps": [{ "type": "javascript", "entry": "ci.js", "files": ["ci.js"] }]
}
```

```js
export default async ({ variables }) => {
  if (!variables.API_TOKEN) throw Error("API_TOKEN missing");
  return {
    logs: ["Configuration loaded"],
    artifacts: { "result.txt": variables.LABEL },
  };
};
```

外部 Runner 使用同样的 `variables` 和 `environment` 配置，变量仅注入该任务的子进程环境。更新到本版本 `scripts/runner.mjs` 后，`npm ci`、测试和 `npx wrangler deploy` 可使用项目密钥中的 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`。令牌值通过管理表单提交，不要写进仓库 JSON、脚本或命令字符串。通用系统命令仍由用户提供的可信外部 Runner 执行；服务自身不运行容器或 shell。

精确环境名优先于 `*`。若精确环境定义已暂停或失去授权，任务直接失败，不回退到通用凭据；删除该定义后才会恢复通用匹配。未指定环境时使用 `deploy.environment`，再回退 `default`；同时指定的两个环境必须一致。每个项目最多 100 个变量定义，任务最多选择 30 个，总解密数据最多 64 KiB；单值最多 8192 字符，密钥至少 8 字符，不允许 NUL。名称仅大写字母、数字和下划线，禁止覆盖 Runner 控制变量和 PATH/HOME 等系统环境。环境名为小写字母开头的 1–40 个字母、数字或连字符。分支使用明确名称，最多 20 个；`*` 代表全部。

## 权限、快照与撤销

默认变量是密钥、仅限受保护分支、允许 `main`、创建后启用。受保护变量要求分支已设置 `require_mr`；密钥或受保护变量仅允许来源为手动、推送、定时的运行。首次读取必须仍匹配该分支当前提交，因此分支已前进的旧提交重试需改为新建运行。MR 及其工作流子任务和重试保留原始来源，不能读取密钥或受保护值。只有显式配置为普通、不受保护且允许对应分支的变量才能用于 MR。

首次使用将所选定义的版本和加密值固定到任务；后续步骤读同一份快照。修改、暂停、删除、所有者停用或丧失最后一项维护权限、归档或跨空间转移会取消已绑定的未完成任务及整个工作流，晚到的完成和发布请求被拒绝。保护规则变化会取消绑定受保护值的运行。尚未使用变量的任务按首次读取时的当前配置和权限选择。接管改变所有者并暂停变量，需手动启用；普通编辑不会自动接管。PAT 撤销不等同于用户权限撤销。已完成历史保留加密快照以继续对旧日志脱敏。

隔离 Worker 收到 `input.variables`，无 Cloudflare 账户绑定，保持 `globalOutbound: null`。外部 Runner 只有持有本任务有效租约时才能请求值，响应 `Cache-Control: no-store`，不落盘变量文件。撤销会阻止后续取值与发布，但无法收回已经交给正在执行代码的值。

## 日志

密钥的直接文本、URL 编码、JSON 转义及 UTF-8 Base64 形式会替换为 `[MASKED]`（外部 Runner 使用 `[REDACTED]`）。Worker 捕获常用 console 方法并过滤返回日志、异常；外部 Runner 缓冲分块输出并处理 UTF-8 分割，服务端读取日志时再跨上传记录过滤。普通变量不脱敏。轮换或删除定义后，历史日志仍使用任务的加密快照过滤。

脱敏用于减少意外泄露，不是阻止代码外传密钥的沙箱策略。可信构建代码仍能转换值或写进产物；不要把密钥用于不可信代码。Worker 沙箱的网络限制和代码信任边界与日志脱敏是不同机制。

## API 与迁移

- `GET/POST /api/repos/:namespace/:repo/ci/variables`：列出元数据或创建。
- `PUT/DELETE .../variables/:id`：更新或删除，需当前 `revision`。更新省略 `value` 保留原值。
- `POST .../variables/:id/take-ownership`：需 `revision`，接管后暂停。
- `GET /api/runner/runs/:id/variables`：Runner 令牌 + `X-Run-Lease`，返回私有变量和脱敏模式。

写操作与当前成员权限、版本检查及审计同一事务提交。迁移 `0016_ci_variables.sql` 增加变量、加密任务快照、来源标记及撤销触发器，不重写已有运行（包括归档历史），不迁移 R2 或 DO 数据。执行前导出 D1 并验证恢复和迁移。

验收脚本 `npm run test:variables` 覆盖真实 Worker/外部 Runner、环境覆盖、只写值、异常/分块日志、租约和轮换。`npm run test:variable-ui` 覆盖界面 CRUD、空值保留、读者拒绝、桌面/手机。远程验收需专用临时项目及显式 opt-in；完整平台范围仍见 [ROADMAP](ROADMAP.md)。空间级变量继承、共享构建缓存和云端 npm/TypeScript 工具链尚未实现。

运行时依据：[Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)、[Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/api-reference/)、[egress control](https://developers.cloudflare.com/dynamic-workers/usage/egress-control/)。

## 本版本验证记录

226 项单元测试和 TypeScript 检查通过；本地变量验收 41 项、变量界面 16 项、通用界面 43 项、基础 API 43 项及原生 Git/LFS、工作流界面 18 项、工作流 23 项（包含实际外部 Runner）、Git→版本化 DAG→克隆/fsck 21 项通过。生产迁移前的独立 D1 恢复及迁移试跑通过完整性和外键检查，并保持原有数据数量。

生产候选版在 `git.1s.hk` 通过 41 项变量验收（真实 Dynamic Worker、发货版外部 Runner、MR/重试拒绝、暂停环境拒绝回退、轮换取消和历史脱敏），以及原生 Git 推送→版本化 DAG→克隆/fsck 的 30 项检查。线上资源与源码指纹和健康检查通过，Cubelink 保持可用。
