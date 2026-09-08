# HTTP API 与 Git 协议

**简体中文** · [English](en/API.md)

基础地址：`https://1s.hk/api`，本地为 `http://localhost:8787/api`。使用 `Authorization: Bearer <token>` 传递短期 PAT；不要把令牌放进 URL、查询参数或命令历史。浏览器会话写请求还必须携带与配置一致的 `Origin`。

本文介绍基础 Git API；完整机器可读契约为 [`/openapi.json`](https://1s.hk/openapi.json)。后续协作与平台接口见各功能指南。响应一般为 JSON；错误含 `error`，校验错误可含 `details`。400 表示参数错误，401 未认证，403 权限不足，404 不存在或隐藏，409 冲突，413 超限，429 限流，5xx 为运行时或存储错误。写请求失败不一定代表未提交，重试前先读取远端引用。

## 账户与项目

| 方法                 | 路径                      | 用途                                                             |
| -------------------- | ------------------------- | ---------------------------------------------------------------- |
| GET / POST           | `/setup`                  | 查询初始化状态；提交 `{username,password,secret}` 创建首个管理员 |
| POST                 | `/login`                  | `{username,password,otp?}`，签发会话 Cookie                      |
| POST                 | `/logout`                 | 撤销当前会话                                                     |
| POST                 | `/password`               | 会话提交 `{current_password,new_password}`，撤销旧会话和 PAT     |
| GET                  | `/me`                     | 当前用户或 null                                                  |
| POST                 | `/users`                  | 管理员创建用户                                                   |
| GET / POST / DELETE  | `/tokens`、`/tokens/:id`  | 列出、创建及撤销自己的 PAT                                       |
| GET / POST           | `/repos`                  | 查询或创建项目                                                   |
| GET / PATCH / DELETE | `/repos/:namespace/:repo` | 元数据、设置、软删除并异步回收                                   |

PAT 创建接受 `{name,scope:"read"或"write",days:1..365}`，明文只返回一次，需浏览器会话；启用 MFA 时遵守二次验证。密码为 12–128 字符。用户标识最多 48 个小写字母、数字、下划线或连字符，以字母/数字开头；系统路由名保留。

项目默认私有、分支 `main`。名称最多五个 `/` 分段、总长 200 字符；完整名称编码为一个路径段，如 `/api/repos/alice/team%2Fproject`。列表接受 `q`、`page`、`limit`（1–100）、`cursor`；原样使用 `next_cursor`。创建可指定名称、描述、可见性、默认分支与 `base_repo`。团队空间与继承权限见[平台指南](PLATFORM-v04.md)。

以下路径均相对于 `/api/repos/:namespace/:repo`。

## 文件、历史与搜索

- `/tree?ref=main&path=src` 返回固定引用及目录条目；`/blob` 返回 UTF-8 内容、二进制标记、大小与解析后的引用。
- `/files`、`/files/metadata` 接受 `ref,path,recursive,limit,cursor`，后者包含最近修改信息。分页必须保留原筛选和固定版本。
- `GET/HEAD /file?ref=main&path=README.md` 返回原始字节，支持 ETag、Last-Modified、If-Match、If-None-Match、If-Modified-Since、If-Unmodified-Since、If-Range 和单字节区间 Range；不可满足时返回 416。
- `/commit?sha=版本` 返回父提交、树、作者与签名等元数据；`/commits?ref=main&path=src&limit=20` 查询路径历史。版本支持完整/无歧义短 SHA、引用、`~n` 和 `^n`，受遍历预算限制。
- `/diff?ref=新版本&base=旧版本` 返回原生文本/二进制 diff；省略 base 使用第一父提交。`/branches/diff?source=feature&target=main` 使用唯一合并基点；多个基点需显式指定。
- `/blame?ref=main&path=src/app.ts` 返回行归属；重复 `ranges` 支持数字、正则和函数范围，具体规则见 `src/git/blame-range.ts`。
- `POST /archive` 接受 `{ref?,include_globs?,exclude_globs?,max_blob_size?,archive?:{prefix?}}`，流式返回 gzip tar，保留模式、链接和 PAX 长路径，不解引用链接。
- `/search?ref=main&q=keyword` 为项目内字面搜索，最多 200 匹配。`POST /grep` 使用 RE2，接受 `ref`、`query:{pattern,case_sensitive?}`、`paths`、`file_filters`、上下文、结果预算与游标；不支持的正则或预算耗尽明确失败。跨项目[协作搜索](SEARCH-v28.md)与[代码索引](CODE-SEARCH-v32.md)另有接口。

## 引用与提交

`GET /branches` 列表、`GET /branch` 单项；`POST /branches/create` 接受 `{target_branch,base_ref?|base_branch?,base_is_ephemeral?,ephemeral?}`。删除 `/branches` 提交 `{branch,expected_sha?,ephemeral?}`。`GET /tags`、`GET /tag` 查询标签；`POST /tags` 接受 `{name,ref?|sha?,ephemeral?}` 创建轻量标签；删除 `/tags/:tag` 时编码完整标签名。原生 Git 支持附注标签。

`GET /notes` 接受 `sha,notes_ref?`；POST 接受 `{sha,note,operation?,notes_ref?,expected_ref_sha?}`，operation 为 create/append；DELETE 接受 `{sha,notes_ref?,expected_ref_sha?}`。`/notes/refs` 列出 Notes 引用，可与原生 `git notes` 互操作。

`POST /commit` 是简单文件编辑：`{branch,expected_sha,message,files:[{path,content}]}`。`content:null` 删除；`expected_sha:null` 要求分支不存在。`POST /commit-files` 支持更完整的 `{target_branch,commit_message,author?,committer?,expected_target_sha?,base_ref?,base_branch?,ephemeral_base?,ephemeral?,files}`。文件可使用文本/Base64、已有 blob SHA，或 null 递归删除；模式支持 `100644,100755,120000,160000`。陈旧预期 SHA 返回 409。

`/commit-pack`、`/diff-commit`、`/restore-commit`、`/reset-commits` 使用 `application/x-ndjson`，首行 metadata，流式接口必须提供作者。文件描述为 `{path,content_id,operation:"upsert"或"delete",mode?}`；后续行为 `{blob_chunk:{content_id,data:BASE64,eof:boolean}}`。每个 upsert 必须完整结束，未完成流不能发布引用。Diff 使用 `{diff_chunk:{data:BASE64,eof:boolean}}`，支持严格上下文的原生文本、binary literal/delta、模式、重命名/复制和引号路径，不模糊应用。Restore/reset 只需 metadata，会以当前分支为父提交创建所选树的新提交，不抹除历史。

## 合并与协作

`GET /merge/preview?source_ref=feature&target_branch=main&include_content=true` 只预览。`POST /merge` 接受 source_ref、target_branch、expected_target_sha、strategy（merge/ff_only/ff_prefer）、squash、allow_unrelated_histories、临时命名空间、提交消息和作者等选项。用预览的源 SHA 和目标 SHA 固定输入；冲突不发布，源分支保留，多个合并基点明确报冲突。

`/issues`、`/issues/:id`、`/issues/:id/comments` 提供 Issue/评论；`/merges`、`/merges/:id`、`/merges/:id/merge` 提供合并请求与审阅操作。数字 ID 为实例级，不是项目内序号。`/members` 与 `/members/:username` 管理成员；`/audit` 供维护者读取审计。版本控制、权限和字段详见[Issue](ISSUES-v09.md)、[审阅](REVIEWS-v07.md)、[CODEOWNERS](REVIEWS-v08.md)、[合并队列](MERGE-QUEUE-v31.md)。

## Git 与 LFS

```sh
git clone https://1s.hk/alice/project.git
# 用户名为 alice；密码使用 PAT，而非账户密码
```

支持 HTTPS smart HTTP、v0/v2、info/refs、upload-pack、receive-pack、OFS_DELTA、REF_DELTA 和 thin pack；输出为完整 zlib 对象。公开仓库允许匿名克隆，私有仓库需有效凭据。PAT 默认禁止改写历史；JWT 可由引用策略限制。默认分支不能删除，批量引用更新全成或全败。不支持 SSH、dumb HTTP、压缩请求体、SHA-256 Git、shallow/partial clone。资源预算见[限制](LIMITS.md)。

LFS 基址为 `https://1s.hk/alice/project.git/info/lfs`。`POST /objects/batch` 接受 operation 与 `{oid,size}` 列表；PUT `/objects/:sha256` 上传并校验 SHA-256（16 MiB），GET 授权流式下载。Action 使用可信实例地址和请求的认证头；缺失对象单项 404。相同 OID 仍按仓库隔离。不支持 LFS 锁和可选 verify action。

## 委托身份与引用隔离

浏览器会话管理 `/api/api-keys` 和 `/api/signing-keys`，支持 GET、POST `{name,public_key,algorithm?}`、DELETE `/:id`，每类最多 20 项。API 公钥为 SPKI，支持 ES256/384/512、RS256（RSA 至少 2048 位）；提交签名公钥为 SSH/OpenPGP。私钥保留在客户端。

JWT 包含算法、可选 kid、iss 用户名、sub、iat、exp、repo 与 scopes。`git:read`、`git:write`、`repo:write`、`org:read` 相互独立，写不隐含读。每次请求检查公钥撤销。引用策略按顺序首次匹配，支持精确名称、末尾 `/*` 或 `*`，限制 `no-push`、`no-force-push`、`verify-sig`。签名要求核验新引入提交，未签名的 API 提交不能绕过。

Git Basic 密码可用 PAT/JWT；`+ephemeral.git` 使用独立临时引用，API 通过 `ephemeral=true` 选择。`+import.git` 仅推送，不能写入已配置上游的仓库。逻辑引用仅 heads/tags/notes，客户端不能寻址内部命名空间。独立[部署令牌](DEPLOY-TOKENS-v26.md)仅提供授权范围内的 Git/LFS 读取和包操作。

## 生命周期与上游

`base_repo:{id,ref?}` 创建独立 Fork；源授权仍需检查。上游描述支持 provider、owner、name、upstream_host、mode、default_branch，提供方含 GitHub/GitLab/Bitbucket/Gitea/Forgejo/Codeberg/SourceHut。GitHub public 模式支持单向拉取；App 和通用连接可上游优先推送，通用连接需先配置凭据。

PUT `/upstream` 设置描述或 null，DELETE `/base` 解绑；POST `/pull-upstream` 返回 202 持久任务，GET `/sync-status` 查看状态、次数和安全错误。只同步普通 heads/tags，临时引用和本地 Notes 不外传；未确认上游结果保留恢复屏障，不伪造成功。`/git-credentials` POST/PUT `{username,password}`，GET 只返回 ID/时间，DELETE `/:id`；AES-GCM 保存密文。

浏览器管理 `/api/integrations/github`，PUT `{app_id,installation_id,private_key,webhook_secret}`；App 需 Contents 读写与 push webhook。`/webhooks/github/:username` 核验 HMAC、安装身份和去重后触发真实同步。未配置私有 App 明确失败。GitHub App LFS 区分安装认证与获准存储 action 头；通用/公开上游 LFS 不支持。归档、转移和旧地址权限见[归档](ARCHIVE-v10.md)、[转移](TRANSFER-v11.md)。

## Webhook 与 MCP

维护者管理项目 `/webhooks`（最多 10 项）、DELETE `/webhooks/:id`、GET `/deliveries`（最近 100 条）。URL 必须为 `WEBHOOK_ALLOWED_HOSTS` 明确允许的 HTTPS 主机。创建只显示一次 secret，可指定 events。已发布 push 事件与 refs 原子保存，拒绝/无变化探针不发成功事件；同步事件含 started/succeeded/failed，协作事件使用 D1 outbox。至少一次投递，接收方按 ID 去重。

载荷 `{id,event,repository_id,actor,detail,timestamp}`；头为 X-OneStorage-Delivery、X-OneStorage-Timestamp（秒）、X-OneStorage-Signature（sha256=hex）。对 `timestamp + "." + rawBody` 计算 HMAC-SHA256，常量时间比较，检查新鲜时间并去重。10 秒内返回 2xx，不跟随跳转。

POST `/mcp` 实现无状态 Streamable HTTP JSON-RPC，支持协议 2025-03-26、2025-06-18、2025-11-25，initialize、ping、tools/list/call、resources/list/read。GET 返回 405，无 SSE 会话。客户端通过 Authorization 传 PAT/JWT，每个工具复用 REST 权限。`/llms.txt` 提供机器入口。SDK 使用方法见[三语言 SDK](SDK.md)。
