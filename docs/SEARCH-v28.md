# 跨项目协作搜索

v0.28 的 `/search` 页面和 `GET /api/search` 在 Cloudflare Workers/D1 中搜索当前可访问的项目、Issue、合并请求与 Wiki。标题/项目名称、描述和正文均可匹配，结果显示所在项目、类型、状态、归档标识及命中附近最多 320 字符的正文。入口在侧边栏；空间切换保留关键词和筛选，重置分页。

## API

```http
GET /api/search?q=中文检索&type=all&namespace=team&state=all&archived=include&limit=30
```

- `q`：去除首尾空格后 1–128 UTF-16 代码单元，单行字面子串；ASCII 大小写不敏感，其他 Unicode 精确匹配。`%`、`_`、反斜杠和引号无通配符或表达式含义。
- `type`：`all`、`project`、`issue`、`merge`、`wiki`。
- `namespace`：当前空间标识；空值搜索所有有权访问的空间。
- `state`：`all`、`open`、`closed`、`merged`。非 `all` 时只保留匹配的 Issue/MR，项目和 Wiki 不具备此状态。
- `archived`：`include`（默认）、`exclude`、`only`。
- `limit`：1–50，默认 30。响应包含 `results`、`has_more`、`next_cursor`；下一页保留原筛选并附加 `cursor`。

按类型、项目 UUID 和字符串条目 ID 稳定排序，按最后一条键继续，而非 offset。它不是相关度或时间排序；十进制 ID 按字符串排列。游标绑定查询、筛选及用户身份，限长并验证结构；它不是凭据，不能赋予权限。新增、修改、转移和撤权采用每次请求的实时状态，不承诺跨页数据库快照；刷新搜索可获得新出现在游标之前的记录。

## 权限与数据

搜索使用同一 D1 批次读取当前有效 session/PAT 和结果。SQL 中检查未禁用账户、未到期凭据、未删除项目及当前成员关系。个人项目所有者、直接项目成员、继承空间成员以及公开可见性分别判定；空间项目创建者若已移出空间且无直接成员资格，不再拥有隐式访问。站点管理员无全站私有内容读取豁免。匿名仅搜索公开项目；只读 PAT 可使用，Git 委托 JWT 和部署令牌不可使用。

项目转移后结果使用当前地址与权限，不泄露旧地址或旧空间内容。归档保留读取。删除、成员撤销、可见性改变无需等待搜索索引刷新；凭据撤销也在搜索自身的批次中重验。响应 `Cache-Control: no-store`。页面对标题和正文进行 HTML 转义后标注匹配，不执行正文 HTML/Markdown。跳转到具体内容时仍由原有接口执行权限检查。

## 覆盖范围和性能边界

这是跨项目**协作内容**搜索。代码仍使用项目内搜索；项目结果提供跳转链接。评论、审阅讨论、Wiki 历史版本、附件与 Git 提交历史未加入全局搜索。Wiki 修改后立即仅搜索当前版本。

实现没有只查前 N 个项目的截断，也没有逐项目 Git/R2/DO RPC。页面先显示可操作表单，再读取一页数据；旧导航请求无法覆盖当前页面。查询使用现有成员/项目关联索引和 D1 字面子串过滤，仍需扫描可访问内容，**不是全文索引或大规模搜索性能承诺**。生产验收中的小夹具耗时不代表大量项目/长正文规模。

后续代码索引需单独设计可重建索引存储、异步提交版本投影、覆盖状态及权限重验。Cloudflare 支持 FTS5，但其官方文档说明含虚拟表的 D1 数据库不能直接导出。为保留主库备份能力，本版本不在主库添加 FTS 虚拟表、数据迁移或额外云资源。参考：[D1 SQL 扩展](https://developers.cloudflare.com/d1/sql-api/sql-statements/)、[D1 索引](https://developers.cloudflare.com/d1/best-practices/use-indexes/)、[D1 导入导出限制](https://developers.cloudflare.com/d1/best-practices/import-export-data/)。

验收脚本：`npm run test:search`；远程使用已有测试授权环境变量与 `ONESTORAGE_TOKEN_FILE`，浏览器检查可设置 `PLAYWRIGHT_MODULE`。脚本创建隔离工作空间和项目，退出前删除夹具、禁用临时账户并撤销其凭据。
