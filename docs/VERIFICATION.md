# v0.3.0 历史验证记录

**简体中文** · [English](en/VERIFICATION.md)

日期 2026-09-08，Asia/Singapore，基线 v0.2/e72e52d。服务在本地 workerd 与 Cloudflare 运行相同无容器 JavaScript Git 引擎；原生 Git 仅作客户端和独立验证。此处记录当时结果，不是当前版本测试次数。

## 对照与本地验证

研究 Code Storage 的公开索引、101 个独立 Markdown 页面和 OpenAPI，parity.json 将 40 个首选操作与 11 项横向能力映射到实现和证据。test:parity 只检查映射，不代替行为或云端验收；API 路径、SDK、存储与容量并非完全兼容。

类型检查及57项测试通过；核心43次HTTP断言加原生v0/v2、二进制/模式/标签/thin pack、CAS、LFS、权限、Issue、固定MR、CSRF/撤销通过。高级65项真实workerd/D1/R2/DO检查覆盖scope/策略/隔离/NDJSON/Notes/Range/Fork/生命周期/凭据/MCP。

真实SSH签名推送成功，未签名和撤销公钥拒绝；分段项目名、临时/import远程与Notes互操作通过。TypeScript/Python/Go SDK通过短期签名密钥执行流式二进制、Notes、临时引用、Fork、UUID解析、归档sink和七类Agent示例，结束后撤销密钥。使用Python3.12.14/cryptography50.0.1及Go1.27.1，无外部私有凭据。

原生Git接受文本/二进制literal/delta补丁、模式/重命名/复制/UTF-8路径；合并覆盖三方/冲突/重命名编辑/多基点拒绝，blame覆盖范围/移动复制。公开octocat/Hello-World经本地Queue与JS Git客户端真实导入；一次热更新中断后的超时未计成功，清理后重跑通过。浏览器实际创建并删除临时ui-check分支、核对SHA和清空结果，没有完整无障碍/跨浏览器审计声明。

## 故障与外部服务

注入R2/ref失败不能发布缺失对象。SQLite覆盖同步任务、租约、事件重放、删除回收；Fork持有目标队列避免晚到复制越过删除。上游优先写入在后续同步任务持久前保留恢复标记，不确定结果关闭普通操作并实际重拉。

本地原生Git HTTP后端验证双向协议；GitHub App令牌/webhook使用真实RSA/HMAC与模拟提供方，LFS转发/摘要同样模拟。没有提供真实私有GitHub App安装或私有上游凭据，因此不宣称这部分云端实测。Webhook仅受控接收端，无真实第三方消息。

## 发布证据

历史主Worker096eea88-8894-42e2-ae86-a0b6c8920240部署于git.1s.hk。D1导出后应用0004；原1shk/nb镜像备份并严格fsck，保留账号/仓库身份。新32字节加密密钥仅上传secret，不进源码。

verify-cloud通过14组检查，使用操作者所属临时私有项目覆盖40项映射REST操作：分段名称/ID地址/列表、二进制流提交、GET/HEAD/Range/ETag、归档/元数据/历史/grep/blame、分支/临时引用、diff/merge/restore/reset、Notes/标签、默认分支/Fork、加密凭据/解绑/上游拉取。MCP发现与匿名拒绝、llms/OpenAPI通过。公开GitHub导入在真实远端Queue、JS pack解析、R2和DO完成。临时项目删除并验证隐藏，未用源码项目做破坏测试。

随后修正有界grep游标，新增回归和实际云端两页查询。源码908c916b95a3a87e4782c731ffec41ae13b288d8推送到原私有仓库，独立HTTPS镜像得到相同SHA并严格fsck，线上源码归档SHA-256与本地一致。

两次初始全源码推送失败且远端保留e72e52d，之后未改内容重试成功。结构化诊断后未复现，记作恢复成功而非定位/修复根因。后续提交补充诊断和报告。当时Cubelink仍200且根域名资源未变。允许列表排除.data/.wrangler/依赖/缓存/PAT/私钥。

cloud_verified仅表示列出的云端用例通过，不代表所有本地安全/提供方测试都重复到生产；JWT/签名策略、通用双向/App保留本地或模拟范围。旧初始化状态见[v0.2历史记录](VERIFICATION-v0.2.md)。未做负载/区域故障/联合灾备、独立审计、SHA1DC等价、原生git-lfs CLI或TB规模承诺。当前功能和预算见[路线图](ROADMAP.md)、[限制](LIMITS.md)。
