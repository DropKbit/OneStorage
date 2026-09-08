# v0.2.0 历史验证记录

**简体中文** · [English](en/VERIFICATION-v0.2.md)

日期 2026-09-08（Asia/Singapore）。开发环境为 macOS、Node 26、原生 Git、Wrangler 4.129.1；服务在本地 workerd 和 Cloudflare Workers/DO 运行同一 JavaScript Git 引擎，没有服务端 Git 子进程或容器。以下为历史结果，不代表当前版本重新执行的次数。

类型检查与 28 项测试通过；核心 E2E 通过 43 次 API 状态断言及原生 Git/内容/并发/LFS 检查，最终夹具 owner/e2e_2b6ac048。生产构建部署通过，包约 998 KiB、gzip 173 KiB，不含静态资源。源码包使用明确允许列表，排除凭据与本地状态。

## 协议与存储

blob/tree ID 与原生 Git 一致；OFS/REF/前向 delta、外部 thin-pack 基对象、附注标签、不可压缩分块、二进制、符号链接和可执行模式均覆盖。原生 index-pack --strict 接受生成 pack。损坏/截断/错误 SHA-1/zlib/类型/长度/尾部、解压超限、delta 越界/零指令/缺失基对象/深度、pkt-line、树排序及重复 author 均拒绝；不宣称 SHA1DC 或完整 fsck 等价。

真实客户端覆盖 v0/v2、clone/push/pull、增量 thin push、标签/分支、强制分块 HTTP；flush-only 探针不修改引用，v2 include-tag 返回附注标签。注入 R2/DO 写失败不能推进 refs，可留孤立上传；原子引用批次、CAS、图缺失、默认分支删除、历史改写、不可达/跨仓库 wants 和不可变内容冲突均覆盖。

真实 v0.1 本地快照在 JavaScript 中迁移，处理 AppleDouble，保留提交 da3fcc97ec2f4a2fab5618c2768fd64cafca06ae 和 README。完整 workerd 重启后内容仍一致，原生 clone 与严格 fsck 通过。

账户/协作测试覆盖密码、scope、公开私有权限、成员/只读拒绝、Issue、固定 SHA 快进 MR/重试、并发/陈旧编辑、路径穿越、字面搜索、CSRF、撤销/改密。Webhook 用受控接收端验证 HMAC、去重、次数、SQLite 租约/outbox/白名单撤销，没有发送真实第三方消息。

## 云端与边界

历史部署为 git.1s.hk 和 onestorage.xbitfun.workers.dev，使用真实 D1/R2/SQLite DO/Queues，三项迁移已应用，没有容器绑定；当时根域名仍为 Cubelink。独立非管理员临时用户验证 HTTPS/私有鉴权、空克隆、分块与增量/标签推送、v0/v2 克隆、SHA/二进制/fsck、竞争 CAS 恰好一成功一409、LFS 字节和公开匿名克隆。

验收撤销凭据、删除临时账号和 D1 项目；当时尚无 GC，少量不可达 R2 对象与 DO refs 留存。初始化密钥仅存 Worker secret 和本地0600文件，管理员尚由操作者认领，这是历史状态。公共 DNS 已解析但本地仍 NXDOMAIN 时，使用公网 IP 和真实主机名且保持 TLS 验证，未改 DNS 或关闭证书验证。

未覆盖负载/耗尽/区域故障、D1/R2/DO 联合恢复、独立安全审计、真实 webhook、原生 git-lfs CLI、shallow/partial/SSH/SHA-256 Git 或 GitLab 全量功能。原界面曾本地手动验证登录/项目/README持久化，本轮没有新做远程/移动端/跨浏览器/无障碍完整审计。当前边界见[限制](LIMITS.md)。
