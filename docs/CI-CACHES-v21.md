# 共享构建缓存（v0.21）

**简体中文** · [English](en/CI-CACHES-v21.md)

OneStorage 将可重建的依赖和中间文件保存在 R2，通过 D1 管理不可变缓存版本、运行来源、配额和清理进度。缓存不会替代构建产物或版本发布。隔离 JS/WASM 任务和可选外部 Runner 都可使用；两种格式互相隔离。

## 外部构建

在任务配置中增加 `caches`（工作流中放在子任务的 `pipeline` 内）：

```json
{
  "name": "Build",
  "runner": "external",
  "caches": [
    {
      "id": "npm",
      "key": "npm-v1",
      "key_files": ["package-lock.json"],
      "paths": [".npm"],
      "scope": "branch",
      "policy": "pull-push"
    }
  ],
  "steps": [
    {
      "type": "run",
      "name": "Install",
      "command": "npm ci --cache .npm --prefer-offline"
    },
    { "type": "run", "name": "Test", "command": "npm test" }
  ]
}
```

使用本版本 `scripts/runner.mjs` 和同目录 `runner-cache.mjs`。Runner 检出固定提交后恢复缓存，在所有步骤和产物上传成功后保存；失败或取消的运行不会产生可复用缓存。归档经过 SHA-256、大小、tar 解压安全限制及完整目录检查，路径必须在 `paths` 下，禁止 `.git`、路径穿越、符号链接、硬链接和设备文件。恢复前验证整个归档以及目标路径的父目录，防止越过检出目录。建议缓存包管理器下载目录，不要缓存包含链接的 `node_modules`。

缓存读写失败、过期、配额不足或清空导致旧运行失效时，日志记录 MISS/SKIP，任务可继续正常构建。因此构建脚本必须能在没有缓存时运行。

## 云端 JS/WASM 构建

```json
{
  "name": "Cloud build",
  "runner": "worker",
  "caches": [
    {
      "id": "build",
      "key": "compiler-v1",
      "paths": [".cache"],
      "key_files": ["lock.json"]
    }
  ],
  "steps": [{ "type": "javascript", "entry": "ci.js", "files": ["ci.js"] }]
}
```

```js
export default async ({ caches }) => {
  const previous = caches.build[".cache/result"]?.content;
  const output = previous || "rebuild-on-miss";
  return {
    logs: [previous ? "Reused cached output" : "Built output"],
    caches: { build: { ".cache/result": { content: output } } },
    artifacts: { "result.txt": output },
  };
};
```

`input.caches[slot]` 是 `{relativePath: {content, binary?}}` 文件集合；二进制内容用 Base64。任务通过返回 `caches` 保存更新，多步骤可读到前一步返回的更新。空集合不覆盖已有缓存。隔离 Worker 不获得文件系统、网络或 Cloudflare 账户绑定；云端 npm/TypeScript 工具链仍是后续目标。

## 键、隔离与成功门禁

- 每个任务最多四个槽位，ID 唯一；每个槽位最多十个不重叠路径。`paths` 为精确的相对目录或文件，不展开 glob。环境名称和任务 ID 不自动加入键，需要隔离不同环境的构建输出时应使用不同的 `key`。
- `key_files` 最多五个，内容来自任务固定提交，每个最多 1 MiB。服务端将文件名及 SHA-256 加入主键；首次解析固定到本次运行。
- `fallback_keys` 最多三个，按顺序查找显式静态键，不附加本次锁文件哈希。可由使用对应静态 `key`、不设置 `key_files` 的任务填充；仍受相同仓库、作用域、路径及格式限制。
- 默认 `scope: "branch"`，只在同一仓库、同一分支、同一保护状态与相同缓存路径之间共享。MR 使用独立的审阅来源空间，不能读写普通分支缓存。跨 Fork 不共享缓存。
- `scope: "protected"` 可在同仓库受保护分支之间共享，要求原始来源为手动、推送或定时，且启用 `require_mr`；MR 及其重试不可访问。普通分支写入要求运行提交仍是当前分支提交。
- `policy` 为 `pull-push`（默认）、`pull` 或 `push`。配置随原有 CI 快照和重试规则固定。相同槽位一次运行只上传一个不可变版本，重复同一校验和的上传幂等。
- 缓存仅在任务成功、父工作流也成功后可见。失败工作流中已成功的子任务不会污染后续缓存。读取优先最新可用成功版本，未完成上传不会遮挡旧成功版本。

缓存不是可信验证结果，也不是秘密存储。维护者配置可信构建代码和作用域，缓存读取不应代替依赖完整性检查或测试。不要缓存令牌、变量文件或含凭据的构建输出。

## 清空、回收和容量

仓库 CI/CD 页面显示可复用版本、路径、来源任务、到期时间及占用。维护者可以基于当前 `generation` 清空；版本检查、成员权限和审计在同一 D1 事务内完成。新一代立即生效，旧任务不能重新发布旧缓存。归档/恢复、跨空间转移和分支保护变化也会使旧代失效；同空间的项目重命名保留缓存。

每个项目最多 100 个对象、512 MiB，单个外部归档最多 64 MiB 压缩数据、256 MiB 展开数据和 25,000 个条目。云端文件缓存所有槽位合计最多 4 MiB JSON。容量在上传前事务预留，包括未完成、失败或等待回收的对象；删除实际完成后才释放配额。缓存保留七天。

清空会发送 Queues 回收任务，失败时由每五分钟的 Cron 补偿。每批最多回收 100 个无效、失败、过期或被更新版本替代的对象。未完成上传保留十分钟，上传请求有九十秒截止时间；R2 所有权记录不会随仓库/运行删除丢失，避免中断上传不可追踪。项目删除复用 `ci/<repo>/` 的对象回收路径。R2 删除失败时保留记录供下次重试。

## API 与迁移

- `GET /api/repos/:namespace/:repo/ci/caches`：项目成员读取元数据和配额，不返回缓存内容或 R2 键。
- `POST .../ci/caches/clear`：维护者提交 `{generation}`，返回新一代。
- `GET /api/runner/runs/:id/caches/:slot`：本仓库 Runner 令牌及有效 `X-Run-Lease`；未命中返回 `{hit:false}`，命中返回 gzip 及 `X-Cache-SHA256`、`Content-Length`。
- `PUT .../caches/:slot`：同样的租约和配置范围，必须提供长度和 SHA-256。通过 `FixedLengthStream` 流式写入 R2 并验证校验和，完成后再次检查授权和代号。

迁移 `0017_ci_caches.sql` 增加缓存代号、运行绑定、对象所有权和可见性视图，不重写 Git 对象、现有 CI 历史或配置。迁移前应导出 D1 并验证独立恢复及迁移试跑。所有 Runner 缓存响应禁用 HTTP 缓存。

执行 `npm run test:caches` 验证真实云端文件缓存、外部 Runner 的二进制归档、工作流门禁、清空和队列回收；`npm run test:cache-ui` 验证桌面、手机、成员读取与维护者清空。远程验收使用临时项目、独立凭据和显式 opt-in，清理结束前不要重新部署。

提供方接口依据：[R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)。完整平台剩余目标见 [ROADMAP](ROADMAP.md)。

## 本地验证

238 项单元测试及 TypeScript 检查通过；缓存验收 22 项（包含 2 MiB 二进制 R2 往返、错误校验和、成功门禁、清空与队列回收）、缓存界面 10 项、通用界面 42 项、工作流界面 18 项、基础 API 43 项与 Git/LFS、工作流 23 项（实际外部 Runner）、Git 推送→版本化 DAG→克隆/fsck 21 项通过。测试夹具均完成清理。生产迁移前的独立 D1 恢复和迁移试跑通过完整性、外键及数据数量验证。

生产候选版在 `git.1s.hk` 通过 22 项缓存验收，实际使用 Dynamic Workers、R2 和 Queues，包含 2 MiB 二进制归档恢复、错误校验和拒绝、工作流门禁、清空和配额释放。原生 Git 推送→版本化 DAG→克隆/fsck 的 37 次检查通过。线上资源、源码指纹及健康检查一致，Cubelink 保持可用。上述大小是本次实际传输验证规模，配置上限不是吞吐或 SLA 承诺。
