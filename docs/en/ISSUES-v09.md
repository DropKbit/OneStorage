# v0.9 issue lists, bulk updates, and label boards

[简体中文](../ISSUES-v09.md) · **English**

Project-level filtering, pagination, versioned edits, and saved label boards use D1 without new containers or external services. At this release, lifecycle and cross-project collaboration remained separate goals; see the [lifecycle requirements](PROJECT-LIFECYCLE-PLAN.md).

## Lists and details

`GET /api/repos/{namespace}/{repo}/issues` supports:

| Parameter | Behavior                                                             |
| --------- | -------------------------------------------------------------------- |
| state     | all (default), open, closed                                          |
| q         | Text in title/description, up to 200 characters; % and _ are literal |
| author    | Username or me                                                       |
| assignee  | Username, me, or none                                                |
| milestone | Milestone UUID or none                                               |
| labels    | Up to 20 comma-separated label UUIDs; match all                      |
| sort      | newest, oldest, updated; updates include fields and labels           |
| limit     | 1–100; API default 100, UI 50                                        |
| cursor    | Returned next_cursor, bound to repository, user, and filters         |

Responses contain issues, total, open, has_more, and next_cursor. Counts include all matching items, not just this page. Items include assignee, milestone, labels, revision, and updated_at. Cursors use creation ID or update-time/ID; concurrent edits do not form a fixed cross-request snapshot.

Details support title/body edits, close/reopen, and discussions. comments_after pages up to 200 comments; comments_next continues. More comments uses this cursor. Every read checks access; issue/comment insertion rechecks current access and account state.

## Versions and bulk operations

`POST .../issues/bulk`:

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

- Up to 50 distinct issues; target developer access or higher is required. Bulk edits cover state, assignee, milestone, and labels, not different issue descriptions.
- labels replaces the set and cannot be combined with add_labels/remove_labels. Incremental updates add/remove up to 20 each, with at most 50 labels per issue. Full replacement remains capped at 20 for legacy planning compatibility.
- Omitted fields stay unchanged; null clears assignee/milestone. Labels/milestones must belong to the project, and assignees must be active readable members.
- A single D1 transaction validates every repository/revision, current permissions, and planning ownership before editing and writing audit/outbox. Stale versions, wrong projects, or revoked access return 409 without partial changes. Temporary validation records are removed on success or rolled back on failure.
- State, title, description, assignments, and labels increment revision, including merge-driven closure through shared triggers. Comments do not invalidate edit revisions.
- Single PATCH issues/{id} and PUT issues/{id}/planning accept optional revision; legacy clients use the version read in that request. The UI always sends a revision. Authors retain editing rights while they retain read access; developers and above can edit other issues.

Planning uses issue.assign; state changes use issue.open/issue.closed; text uses issue.update; bulk uses issue.bulk_update; board moves use issue.move. Matching webhooks deliver after commit; failed transactions leave no outbox work.

## Boards

- GET/POST issue-boards lists/creates boards. Built-in default has Backlog/Closed columns. Up to 20 custom boards per project, with at most 12 label columns each.
- GET/PUT/DELETE issue-boards/{board} reads, updates by revision, or deletes the view. Maintainers manage boards; deleting a view preserves issues.
- GET issue-boards/{board}/cards?column=... accepts open, closed, or a configured label UUID, sharing text/author/assignee/milestone/label filters. Columns paginate independently; UI loads 20 cards with at most three concurrent columns.
- POST issue-boards/{board}/move accepts issue:{id,revision}, from, to, and board_revision. It verifies current source-column membership before a versioned transaction.

Label columns contain open issues; a card may appear in several. Moving between labels replaces only the source-column label and preserves others. Backlog removes this board’s labels, keeping labels outside it. Closing keeps labels; moving a closed card to an open column reopens it.

The UI supports drag/drop and a dropdown alternative. Ordering uses creation/update time, without free vertical ordering, swimlanes, cross-project boards, dedicated assignee/milestone columns, or iteration boards. API column order follows its array; UI checkbox order follows planning labels.

## Deployment and acceptance

Apply `0010_issue_workflows.sql` after backing up D1, then deploy the Worker. It adds issue revisions/timestamps, indexes, validation, and board tables. Git protocol and app gateway are unchanged.

```sh
npm run db:local
npm run check
npm run test:issues
npm run test:collaboration
npm run test:codeowners
```

Remote acceptance requires explicit TEST_ORIGIN, ALLOW_REMOTE_ACCEPTANCE=1, and a local token file, using isolated projects. HTTP/database/rendering checks while a Mac is locked do not prove actual drag/drop or form interaction.

References: [GitLab boards](https://docs.gitlab.com/user/project/issue_board/), [issue management](https://docs.gitlab.com/user/project/issues/managing_issues/). This describes OneStorage behavior and limits, not full GitLab API compatibility.
