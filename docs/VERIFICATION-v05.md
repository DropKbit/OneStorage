# v0.5 Cloudflare 原生协作验收

**简体中文** · [English](en/VERIFICATION-v05.md)

日期：2026-09-08。总目标继续保持 active；本版不是 GitLab 全量兼容完成声明，持续差距见 CLOUD-NATIVE-v05.md。

## 已执行

- TypeScript 与单元测试：73 项通过。包含现有对象、协议、签名、持久化、同步和平台测试；新增审阅双 SHA 绑定/撤权、评论分页不能隐藏阻塞审阅、受保护引用、WASM 字节、云产物租约/事务、Wiki 历史与通知、应用网关凭据隔离及删除后拒绝访问。
- `test:e2e`：43 项 API + 原生 Git v0/v2、薄包、并发写入、LFS、持久化和认证回归通过。
- `test:features`：76 项进阶 HTTP 检查通过（JWT、引用策略、撤销、命名空间、流式提交、Notes、范围请求、Fork、生命周期）。
- `test:collaboration`：本地 79 次 HTTP/Git 断言通过。真实 Git clone/fsck、普通分支 push、受保护分支 push 和删除拒绝；独立批准、移除审阅人后立即失效、云端 WASM 执行和网络拒绝、CI 门禁与三方合并、自动推送触发、产物和两版部署/回滚、故意失败作业、静态产物版本、Issue 规划、Wiki CAS、发布、收藏和关注。
- 浏览器 DOM 验证：CI 模板与运行结果、合并列表和审阅详情、标签与里程碑管理、导航与收藏/关注入口。
- 生产 Workers 与独立应用网关已部署；首轮临时私有仓库 84 次 HTTP/Git 断言通过，包括真实应用 v1→v2→v1 回滚和停止公开访问。最终版本再通过 80 次 HTTP/Git 断言，包括 R2 生成产物的静态站点访问、路径隔离及撤销公开；两轮均清理生成仓库和空间。计数包含轮询断言，随运行速度变化。
- 主 Worker 与应用网关 dry-run 构建通过。OpenAPI 102 个操作（40 Git + 62 平台/协作）。
- D1 已导出 `.data/pre-v05-d1.sql`，0600；0006 migration 已在本地与生产应用。备份、令牌和运行状态不包含在开源包。

## 验证中发现并修复

隔离脚本包装的括号、WASM 测试使用错误的 base64 提交字段、旧测试夹具未应用新 migration、部分更新里程碑重置截止日期、已合并请求仍显示刷新提示、审阅历史分页可能遗漏未解决要求修改、同秒 CI UUID 排序不代表最新创建顺序。相应路径已加入回归或直接验证。

## 实际边界

云端执行由 Dynamic Workers 完成，无本机 Runner 参与上述 JS/WASM 流程。通用 OS/npm CLI 构建仍需要可选外部 Runner；本版不宣称 Workers 内具备完整 Linux 环境。原生托管应用无网络出口及平台私有绑定，默认需要维护者显式公开。代码/产物大小、CPU 与执行时长有明确上限。审批是源提交测试门禁，并不等同 GitLab merged-results pipelines 或 merge trains。Wiki 当前是版本化文本，Markdown 富渲染仍在持续目标中。
