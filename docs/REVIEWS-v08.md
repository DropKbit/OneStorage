# v0.8 代码负责人、Issue 联动与 Git I/O

**简体中文** · [English](en/REVIEWS-v08.md)

## CODEOWNERS

在仓库「分支保护」勾选「CODEOWNERS 指定的负责人必须批准」。也可向 `PUT /api/repos/{namespace}/{repo}/protections` 传入 `require_codeowners: true`。该规则独立生效，即使普通批准人数为零、`require_mr` 为 false，也不能通过普通 push、网页编辑或直接合并接口绕过 MR。

依次查找目标已审阅提交中的 `CODEOWNERS`、`.gitlab/CODEOWNERS`、`docs/CODEOWNERS`、`.github/CODEOWNERS`，只使用找到的第一个文件。贡献分支修改规则不会改变本次门禁；源或目标刷新后旧批准失效。规则文件缺失、非普通文件、无效 UTF-8、格式错误时明确阻止合并。规则应覆盖 CODEOWNERS 文件自身，以便规则修改也需要负责人批准。

```text
# 默认负责人覆盖配置自身
* @project-owner

[Backend][2] @alice @bob @carol
/src/

[Docs] @docs-workspace
/docs/**/*.md

[Security] @@maintainer @@owner
/auth/

^[Advice] @alice
*.md
```

- `@username` 指定用户；`@workspace` 仅指目标项目所属空间的现有开发者及以上成员。未实现嵌套空间、外部团队邀请或邮箱身份。
- `@@developer`、`@@maintainer`、`@@owner` 对应用户在目标仓库的**最高有效角色**，支持空间继承；角色精确匹配，maintainer 不自动满足 `@@developer`。此处与 GitLab 的直接角色规则不同。
- 作者不能批准自己的 MR；停用、移除或降权后立即不再计数。CODEOWNERS 中的名字本身不会赋予访问权限；管理员也没有隐式代码审批资格。
- 支持根路径 `/src/`、任意层级文件名 `README.md`、`*`、`?`、`**`、`**/`、目录后代以及路径中的转义空格。RE2 匹配避免回溯型正则耗尽 CPU。
- 每个分节取最后匹配规则。不同分节及不同匹配规则分别计数，多名 owners 是候选人集合；`[Section][2]` 每条命中的规则需要两名独立批准者。一个人可同时满足多个规则。重复节名忽略大小写并合并，采用较高必需人数。
- `^[Section]` 是可选节，`!path` 清除当前节对该路径的要求。无显式 owners 的路径使用节的默认 owners；默认也为空时可显式取消覆盖。
- 仅支持整行 `#` 注释。行尾注释、字符类、邮箱、嵌套组等未支持语法会报错，不会静默跳过。
- 对比源/目标快照的树条目，涵盖删除、重命名两端、执行位、符号链接及子模块变化；不需要读取所有 blob。目标分支独有变化也可能要求审批，这是保守的双快照比较。

MR 详情的 `gate.codeowners` 返回文件位置、目标 SHA、错误和逐条要求；界面显示负责人、批准数和文件。计数覆盖全部匹配，展示每条最多 20 个路径、50 名候选人、10 名已批准者，另有 `path_count`、`eligible_count`、`approved_count`。限制：128 KiB/1000 行规则、1000 名候选成员、250000 次路径与规则比较；超限明确失败。原有 Git 对象/深度限额继续适用。

## 合并关闭 Issue

合并到**当时的默认分支**后，识别 MR 描述和本次新增提交消息中的 `Closes #123`、`Fixes #123`、`Resolves #123` 及其单复数/时态形式，支持逗号和 `and` 列表。只接受同一目标仓库的数字 Issue ID；跨项目编号、URL、普通提及、代码块、行内代码、引用和 HTML 注释不触发关闭。当前不处理直接 Git push 的关闭指令，也不提供自定义正则或跨项目自动关闭。

MR 详情返回 `closing_issues` 并显示链接。网页提交合并时携带当前 MR `revision`，描述或快照被他人修改后返回 409，要求重新加载；API 也可传此字段。非默认目标不关闭 Issue；已在目标历史中的提交消息不会再次执行。每次最多 100 个 Issue 引用和 1 MiB 新提交消息。无代码变化的 MR 合并也会记录结果并处理描述中的指令。

DO 在同一笔持久化写入保存 refs、合并结果、Issue 计划和待投影标记。随后 D1 事务更新 MR，并通过唯一 `(mr_id,issue_id)` 记录触发 Issue 关闭、系统评论、审计及站内通知。如果 D1 失败，DO alarm 或客户端重试可修复。已处理记录不会重复评论，也不会再次关闭用户手动重开的 Issue。后台补偿沿用合并当时记录的默认分支条件和 actor，不依据后来的项目设置重新推断。

## Git I/O

图遍历和不可变对象写入改为最多两路并发；单请求相同 OID 的并行读取合并为一个 R2 请求。每一条对象引用仍检查预期类型，重复写入仍比较完整字节，SHA-1、图规模、单对象 8 MiB 和展开 32 MiB 限额保留。任一路出错时等待另一条已开始的 I/O 结束，再向调用者返回失败；未验证完毕不发布 refs。

这减少独立对象在冷缓存时的串行等待，不保证所有请求快一倍：历史链、同仓库 DO 排队、网络和大对象仍可能主导延迟。浏览器交互与真实大仓库吞吐需要分别测量。

## 部署与验收

新增 `0009_codeowners.sql`，按原流程先备份 D1，再 apply migration，再发布 Worker。应用托管网关未变更。测试命令：

```sh
npm run check
node scripts/e2e-codeowners.mjs
npm run test:reviews
npm run test:collaboration
```

生产脚本要求 `TEST_ORIGIN=https://git.1s.hk`、`ALLOW_REMOTE_ACCEPTANCE=1` 及仅本地保存的 `ONESTORAGE_TOKEN_FILE`。脚本只操作新建的隔离空间和测试仓库，结束后清理仓库、空间、用户凭证。

行为研究参考：[GitLab CODEOWNERS](https://docs.gitlab.com/user/project/codeowners/reference/)、[GitLab Issue 自动关闭](https://docs.gitlab.com/user/project/issues/managing_issues/)。上文描述 OneStorage 自身实现及明确差异，不是完整 GitLab API/语法兼容声明。
