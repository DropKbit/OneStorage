# v0.12：持久化 Git 对象索引与流式下载

此版本消除原生 Git 下载时整仓库对象与 pack 必须驻留内存的路径，同时使增量推送能够跳过已验证历史。它是大仓库能力的一步，单次大导入、Fork/上游同步与全部历史算法仍有独立限制。

## 完整性与可见性

每个仓库 UUID 对应的 SQLite Durable Object 保存对象类型、长度和带预期类型的边。R2 对象先经 SHA-1/长度校验并条件写入；索引按子节点到父节点的顺序建立，只有全部子对象的持久闭包已验证，才在同步事务中写入父对象标记及所有边。已有索引边界可直接复用。新代码第一次遇到旧仓库时按需建立索引；中断前完成的子闭包可在重试时复用。

索引写入或引用发布失败均不推进 refs。失败操作可能留下完整但未发布的对象与索引，这些记录不是授权：fetch 的 want/have 必须从当前请求可见的 refs 计算可达集合；普通与 ephemeral 引用继续隔离。仓库索引带 UUID 归属检查，不能跨仓库复用。索引不改变现有不可达对象保留策略，删除仓库的 GC 同时删除 R2 对象及索引表。

## 有界内存与 HTTP 协议

请求内读取缓存改为 8 MiB/1,024 项 LRU，入站未持久化暂存仍限制 32 MiB；成功 flush 会释放暂存对象。原生 Git pack 输出按对象、16 KiB 压缩输入块生成，使用增量 SHA-1，不再拼接整个 pack。响应遵循背压，不提前读取下一个对象；v0 的原始/sideband 输出和 v2 packfile 分段均使用相同生成器。

流响应结束、错误、取消后才释放仓库队列。20 秒空闲计时用于终止无人消费的流；已开始的 I/O 在释放队列前排空。转移、归档、删除以及下一个 Git 操作按同一队列排序。已有 D1 请求授权快照和 DO 生命周期版本检查保留。

v2 在有共同 have 时返回 ACK/ready 与增量 pack；v0 广告 `multi_ack_detailed` 和 HTTP `no-done`，确认共同提交后直接发送 pack。未发布或不可见对象不会得到 ACK，也不能作为下载 want。

## 当前预算及未完成部分

- 每个对象 8 MiB；原生入站 pack 仍为 16 MiB/2,000 对象/32 MiB 展开。可以分批推送累积更大的仓库，但已有大仓库的单次首次推送仍可能失败；不能宣称已支持任意大型仓库迁入。
- 索引可达规划每次最多 100,000 个对象，流式出站 pack 最多 512 MiB。这是操作预算，不是已实测可承诺的仓库容量。完整 refs 图超过规划预算仍须继续改进分页/持久计划。
- 主 Worker 的子请求上限配置为 250,000，匹配冷索引建立和 pack 读取的理论双遍预算；生产验收远小于该值，账户 CPU、内存及部署套餐仍适用。
- 冷克隆仍逐对象读取 R2，未提供出站 delta 或 pack 缓存，不能把本地耗时等同于生产耗时。
- 非 DO 的 Fork/MR 导入、上游客户端、目录/历史/签名/合并/blame/归档等算法仍有各自预算；当前未全部改为索引与流式处理。大型 Fork 的复制暂存也仍受 32 MiB 限制。
- 流式入站 pack（含 delta 基对象暂存与校验后发布）、更大规模/恢复/跨服务备份验收继续列入总目标。

日志 `Git transfer drained` 记录本次 R2 读取次数、读取字节数、缓存及暂存峰值，不记录对象内容或凭据。缓存指标不是整个 isolate 的峰值内存。

参考：[Cloudflare SQLite DO API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)、[Workers Streams](https://developers.cloudflare.com/workers/runtime-apis/streams/)、[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)、[Git v2 协商](https://git-scm.com/docs/gitprotocol-v2)、[Git HTTP no-done](https://git-scm.com/docs/gitprotocol-capabilities#_no_done)。
