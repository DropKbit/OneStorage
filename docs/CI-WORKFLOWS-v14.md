# 仓库配置与依赖工作流（v0.14）

本轮把流水线配置纳入 Git 版本，并增加有独立运行记录、租约、日志和产物的依赖任务。现有单流水线 JSON 与外部 Runner 协议继续可用；这是 OneStorage 的配置格式，不是 GitLab YAML 兼容层。定时流水线、共享构建缓存、平台变量/密钥和云端 npm/TypeScript 工具链仍待开发。

## 配置来源

维护者在 CI/CD 中选择「仓库中的 JSON 文件」，默认路径 `.onestorage-ci.json`。API 保存 `{ "source_path": ".onestorage-ci.json", "enabled": true }`；页面保存配置则继续使用 `{ "config": { ... }, "enabled": true }`。配置文件最多 128 KiB UTF-8 JSON，路径必须在仓库内部。

- Push 从事件记录的固定 SHA 读取配置；手动运行先解析分支，随后读取该 SHA 的文件。
- MR 使用目标提交的配置来检查固定的源提交，来源 Fork 不能替换目标选择的执行规则。记录同时显示代码 SHA、配置路径和配置 SHA。
- 普通重试保留原始代码 SHA 和解析后的配置快照，不读取当前配置文件。
- 文件缺失、编码/JSON/结构无效或 HTTP 目的地址不获批准时，自动触发生成可查看的失败记录。此类记录不能作为普通任务重试，修复配置后须新建运行。
- 「自动触发」控制 push；维护者仍可手动运行已保存的配置。自动分支过滤来自该版本的 `branches`。

仓库 DO 的持久事件先投影到 D1 `ci_events`，Queue 消费者才读取配置；避免 DO 持有自身串行队列时回调自身。队列发送失败保留事件/运行记录，Cron 负责重投。事件 ID、任务唯一键及状态条件更新使重投不会重复创建同一批任务。

## 工作流格式

```json
{
  "name": "Build and publish",
  "runner": "workflow",
  "branches": ["main"],
  "timeout_seconds": 300,
  "jobs": [
    {
      "id": "build",
      "pipeline": {
        "runner": "worker",
        "steps": [
          { "type": "javascript", "entry": "build.js", "files": ["build.js"] }
        ]
      }
    },
    {
      "id": "lint",
      "pipeline": {
        "runner": "worker",
        "steps": [{ "type": "file", "path": "package.json", "format": "json" }]
      }
    },
    {
      "id": "publish",
      "needs": ["build", "lint"],
      "pipeline": {
        "runner": "worker",
        "steps": [
          {
            "type": "javascript",
            "entry": "publish.js",
            "files": ["publish.js"]
          }
        ],
        "deploy": {
          "kind": "static",
          "entry": "index.html",
          "files": ["index.html"],
          "environment": "preview"
        }
      }
    }
  ]
}
```

任务最多 10 个；ID 必须匹配 `[a-z][a-z0-9_-]{0,39}`。空 `needs` 表示可立即执行；声明的所有任务成功才启动下游。重复 ID、重复/不存在的依赖、自依赖、环以及嵌套工作流均拒绝。每个任务中的 `pipeline` 沿用单流水线格式，可以选择 Worker 或 external Runner，不能在 Worker 中运行 shell。

就绪任务批量投递到 Queues。每个消费批次最多同时执行两个 CI 消息；不同批次还受 Cloudflare 队列并发与账户限额影响，系统不保证任务立即启动。每仓库最多 20 条活动顶层流水线，调度子任务时限制该仓库总活动运行数为 100。

## 产物传递

Worker 脚本收到 `dependencies`，仅包含当前任务直接声明的、同一父工作流内已经成功的任务产物。结构为 `dependencies[任务ID][文件名] = { content, binary }`。二进制 `content` 为 Base64；产物名是原始相对路径。它们不混入当前任务的输出，需要脚本显式返回要保留或部署的内容。

```js
// build.js
export default async ({ sha }) => ({
  artifacts: { "index.html": `<h1>Build ${sha}</h1>` }
});

// publish.js
export default async ({ dependencies }) => ({
  artifacts: { "index.html": dependencies.build["index.html"].content }
});
```

Worker 输入产物总量最多 4 MiB，external 输入最多 16 MiB，编码后还有限额。普通 JS/WASM 源码、步骤输出与部署包仍受原有预算控制。只有已经成功发布到产物索引的文件可传递；不扫描其他任务的 R2 前缀，不读取未声明任务或另一工作流的产物。

随源码提供的 Runner 在独立临时目录下载这些文件，设置 `ONESTORAGE_DEPENDENCIES`，命令可读取 `$ONESTORAGE_DEPENDENCIES/build/result.txt`；`ONESTORAGE_JOB` 为任务 ID。输入路径检查、源码解包与输出上传的限制继续生效，任务完成后清理临时目录。

## 状态、取消与发布

父工作流只在全部子任务成功后成功。任一子任务失败/取消或工作流超时会结束父运行；D1 触发器同步撤销尚在运行/排队的子任务租约，下游不再创建。取消父运行同样处理整个工作流。外部 Runner 在后续心跳发现租约失效后停止命令，Worker 步骤可能运行到自身超时，但不能再发布产物或成功状态。

Worker 单任务仍最多 110 秒，隔离 JS 单步骤 20 秒，CPU 预算独立。父工作流 `timeout_seconds` 在调度时检查，长时间无任务完成时由每五分钟 Cron 唤醒，因此超时回收存在调度延迟，不是精确计时器。租约失效不自动重跑外部部署，须维护者显式重试整个工作流。

MR 的最新 CI 结果只选择顶层运行；一个成功子任务不能掩盖父工作流未完成或失败。部署任务可以产生不可变版本，但必须等父工作流成功才能在「应用发布」激活它；失败工作流的版本不能作为发布或回滚目标。产物和子任务日志保留用于排错。归档、项目转移、删除与 Runner 撤销继续沿用已有生命周期屏障。

## 验证与部署状态

类型检查及 153 项单元测试通过。新增用例覆盖 DAG 校验、重复协调、依赖等待、合并门禁、失败/超时/取消、过期租约的输出拒绝、输入作用域/二进制/预算、固定版本配置、推送事件恢复，以及读取 R2 输入期间取消租约的权限竞态。

本地 `test:workflows` 通过 23 项语义检查、97 次 HTTP 断言，实际运行隔离 JS 和随源码提供的外部 Runner；协作与平台回归分别通过 82 和 64 次 HTTP 断言。`test:workflow-ui` 通过 18 项浏览器检查，包含配置模式、依赖任务导航、固定版本重试、390px 手机布局和只读成员权限。

`test:workflow-git` 使用原生 Git CLI push，验证提交中的配置自动启动两级任务，随后 clone 并执行 `git fsck --full --strict`；本地 21 项、生产 22 项检查通过。该测试与 `test:workflows` 中通过提交 API 产生的 Git 引用事件分开记录。临时仓库、空间和凭据均已清理。

生产完整工作流通过 23 项语义检查、98 次 HTTP 断言，覆盖真实隔离 JS、依赖产物、外部 Runner、配置快照重试、取消/发布门禁及 Fork MR 使用目标配置。两个独立的 4 秒任务实际重叠约 3.7 秒；此单次观察不是并发或性能 SLA。手机首页等待项目数据展示且骨架屏消失后通过检查，未发现横向溢出或脚本异常。

首次生产执行在提交 API 返回一次 503 后失败并完成清理；后续完整工作流和独立原生 Git 验收通过，但这不足以确定或排除该写入异常的根因。此前版本也观察过写入失败，此问题仍需定位，不能把一次成功重试当作修复。

迁移 `0014_ci_workflows.sql` 已应用于本地和生产 D1。迁移前导出生产备份并在独立 SQLite 中恢复，完整性和外键检查通过。部署不改变应用运行 Worker，也不修改 `1s.hk` 的 Cubelink 服务。

部署需要先应用 `0014_ci_workflows.sql`。正式部署前按项目指南备份 D1；本轮不改变应用网关的 Worker 代码。

参考：[Cloudflare Queues 消费者限制](https://developers.cloudflare.com/queues/platform/limits/)、[Dynamic Worker 自定义资源限制](https://developers.cloudflare.com/dynamic-workers/usage/limits/)。
