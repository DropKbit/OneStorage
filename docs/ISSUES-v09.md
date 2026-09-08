# v0.9 Issue 列表、批量操作与标签看板

**简体中文** · [English](en/ISSUES-v09.md)

本轮实现项目内的完整筛选/分页和版本化修改，以及可保存的标签看板。数据保存在 D1；没有新增容器或外部服务。项目归档、转移及跨项目协作仍属于持续目标，见 [生命周期实现门槛](PROJECT-LIFECYCLE-PLAN.md)。

## 列表与详情

`GET /api/repos/{namespace}/{repo}/issues` 支持：

| 参数      | 行为                                                        |
| --------- | ----------------------------------------------------------- |
| state     | `all`（默认）、`open`、`closed`                             |
| q         | 标题或描述包含的文本，最多 200 字符；`%`、`_` 按字面搜索    |
| author    | 作者用户名，`me` 表示当前登录用户                           |
| assignee  | 负责人用户名，`me` 或 `none`（未分配）                      |
| milestone | 里程碑 UUID，`none` 表示未分配                              |
| labels    | 逗号分隔的标签 UUID，最多 20 个，同时匹配                   |
| sort      | `newest`、`oldest`、`updated`；最近更新按字段和标签修改时间 |
| limit     | 1–100，API 默认 100，网页固定每页 50                        |
| cursor    | 上一页返回的 `next_cursor`，绑定仓库、用户和本次筛选        |

返回 `issues`、`total`、`open`、`has_more`、`next_cursor`。总数涵盖全部匹配项，不是当前页数量。每项包含负责人、里程碑、标签、`revision` 与 `updated_at`。使用创建 ID 或更新时间/ID 的游标；持续修改中的数据不构成跨请求的固定快照。

详情页面提供标题/描述编辑、关闭/重新打开和讨论。详情 API 接受 `comments_after`，每页最多 200 条评论，以 `comments_next` 继续，避免旧评论永远隐藏。网页上的「更多评论」沿用此游标。读权限在每次请求重新检查，创建 Issue/评论也在插入时再次检查当前权限与账户状态。

## 版本与批量操作

`POST .../issues/bulk`：

```json
{
  "issues": [
    { "id": 123, "revision": 4 },
    { "id": 124, "revision": 1 }
  ],
  "changes": {
    "state": "closed",
    "assignee": "alice",
    "milestone_id": null,
    "add_labels": ["11111111-1111-4111-8111-111111111111"],
    "remove_labels": []
  }
}
```

- 最多 50 个不重复 Issue，要求目标仓库 developer 及以上角色。批量仅修改状态、负责人、里程碑和标签，避免统一覆盖不同 Issue 的描述。
- `labels` 完整替换标签，不能与 `add_labels` / `remove_labels` 同时使用。增量修改每次最多添加/移除各 20 个标签，总数不超过每 Issue 50 个。完整替换最多 20 个，与旧规划接口保持一致。
- 不提供字段表示保持原值；负责人/里程碑传 `null` 清空。标签及里程碑必须属于当前项目，负责人必须是当前项目可读取的有效成员。
- D1 同一事务先检查所有 Issue 的仓库和版本、当前用户权限、标签和里程碑归属，再修改并写审计及 Webhook 待投递记录。任一版本过期、项目不匹配或检查期间被撤权时，返回 409，整个批次不部分生效。事务中的临时校验记录在成功时移除，失败时回滚。
- 状态、标题、描述、分配及标签变更增加 revision；合并自动关闭 Issue 也受同一数据库触发器覆盖。评论本身不使编辑版本过期。
- 单条 `PATCH .../issues/{id}` 及 `PUT .../issues/{id}/planning` 接受可选 `revision`，旧客户端未传时使用本次读取版本。网页始终发送版本号。Issue 作者保留编辑自己的权限，但必须仍有读权限；现有 developer 及以上可编辑其他 Issue。

单条规划保留 `issue.assign` 事件，状态修改保留 `issue.open` / `issue.closed`，文字修改使用 `issue.update`；批量操作为 `issue.bulk_update`，看板移动为 `issue.move`。已配置的匹配 Webhook 在事务提交后由队列投递，事务失败不会留下待投递记录。

## 看板

- `GET/POST .../issue-boards`：列出或创建看板。内建 `default` 只有「待处理/已关闭」列；项目可保存最多 20 个自定义看板，每个最多 12 个标签列。
- `GET/PUT/DELETE .../issue-boards/{board}`：读取、按 revision 更新或删除视图。maintainer 及以上管理看板；删除视图不删除 Issue。
- `GET .../issue-boards/{board}/cards?column=...`：列为 `open`、`closed` 或已配置的标签 UUID。复用列表的文字、作者、负责人、里程碑和标签筛选；每列独立分页，网页每次 20 张卡片，最多并发请求三列。
- `POST .../issue-boards/{board}/move`：传 `issue: {id,revision}`、`from`、`to`、`board_revision`。检查卡片确实还在来源列，再以版本化事务更新。

标签列只显示开放 Issue；一张卡片可同时出现在多个标签列。转移到另一标签列移除来源列标签、添加目标标签，保留其他标签；移至「待处理」移除本看板标签，保留看板之外的标签；移至「已关闭」保留标签。关闭的卡片移回任一开放列会重新打开。

界面支持拖放，也提供下拉移动操作。当前列内按创建/更新时间排序，尚未实现自由纵向排序、泳道、跨项目看板、负责人/里程碑专用列和迭代看板。自定义列的 API 顺序按配置数组保存，网页勾选按规划标签列表顺序保存。

## 部署与验收

新增 migration `0010_issue_workflows.sql`：Issue 版本/时间、索引、事务校验表和看板表。先备份 D1，再 apply，再发布 Worker。没有修改 Git 协议或应用托管网关。

```sh
npm run db:local
npm run check
npm run test:issues
npm run test:collaboration
npm run test:codeowners
```

生产验收使用显式 `TEST_ORIGIN`、`ALLOW_REMOTE_ACCEPTANCE=1` 和本地令牌文件；只创建隔离的临时项目。Mac 锁定时可以验证 HTTP、数据库和纯渲染逻辑，但不能据此宣称实际拖放/表单交互已验证。

行为研究参考：[GitLab Issue boards](https://docs.gitlab.com/user/project/issue_board/)、[Issue 管理](https://docs.gitlab.com/user/project/issues/managing_issues/)。上述描述是 OneStorage 的实现契约及边界，不是完整 GitLab API 兼容声明。
