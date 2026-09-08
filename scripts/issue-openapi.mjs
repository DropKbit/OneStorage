export function addIssuePaths(paths) {
  const base = "/api/repos/{namespace}/{repo}",
    string = { type: "string" },
    integer = { type: "integer", minimum: 0 },
    object = (properties, required = []) => ({
      type: "object",
      properties,
      required,
      additionalProperties: false,
    }),
    labelIds = {
      type: "array",
      items: { type: "string", format: "uuid" },
      maxItems: 20,
      uniqueItems: true,
    };
  const selection = object(
      { id: { type: "integer", minimum: 1 }, revision: integer },
      ["id", "revision"],
    ),
    change = object({
      state: { enum: ["open", "closed"] },
      title: { type: "string", minLength: 1, maxLength: 240 },
      body: { type: "string", maxLength: 20000 },
      assignee: { type: ["string", "null"] },
      milestone_id: { type: ["string", "null"], format: "uuid" },
      labels: labelIds,
      add_labels: labelIds,
      remove_labels: labelIds,
    });
  function add(method, path, id, body, description) {
    const url = base + path,
      op = {
        operationId: id,
        tags: ["Issue workflows"],
        summary: description,
        parameters: [...url.matchAll(/\{([^}]+)\}/g)].map((m) => ({
          name: m[1],
          in: "path",
          required: true,
          schema: string,
        })),
        responses: {
          200: { description: "Successful operation" },
          400: { description: "Invalid input" },
          401: { description: "Sign in required" },
          403: { description: "Insufficient permission or read-only token" },
          404: { description: "Not found or inaccessible" },
          409: {
            description:
              "Stale issue/board revision or changed authorization; no partial update",
          },
        },
        security: [{ bearerAuth: [] }],
      };
    if (body)
      op.requestBody = {
        required: true,
        content: { "application/json": { schema: body } },
      };
    (paths[url] ||= {})[method] = op;
    return op;
  }
  const list = add(
    "get",
    "/issues",
    "list_issues",
    null,
    "Filter and paginate project issues; return total/open counts, revisions, assignee, milestone and labels",
  );
  for (const [name, schema] of Object.entries({
    state: { enum: ["all", "open", "closed"] },
    q: { type: "string", maxLength: 200 },
    author: string,
    assignee: string,
    milestone: string,
    labels: {
      type: "string",
      description: "Comma-separated label UUIDs, all must match",
    },
    sort: { enum: ["newest", "oldest", "updated"] },
    limit: { type: "integer", minimum: 1, maximum: 100 },
    cursor: string,
  }))
    list.parameters.push({ name, in: "query", schema });
  const detail = add(
    "get",
    "/issues/{id}",
    "get_issue",
    null,
    "Read an issue and its first 200 comments; use comments_next as comments_after for subsequent pages",
  );
  detail.parameters.push({
    name: "comments_after",
    in: "query",
    schema: integer,
  });
  add(
    "post",
    "/issues/bulk",
    "bulk_update_issues",
    object(
      {
        issues: { type: "array", items: selection, minItems: 1, maxItems: 50 },
        changes: change,
      },
      ["issues", "changes"],
    ),
    "Atomically update 1–50 versioned issues; developer required; any stale or foreign issue rejects the entire batch",
  );
  add(
    "patch",
    "/issues/{id}",
    "edit_issue",
    object({
      state: { enum: ["open", "closed"] },
      title: string,
      body: string,
      revision: integer,
    }),
    "Edit an issue with optional revision; author with current read access or target developer required",
  );
  add(
    "put",
    "/issues/{id}/planning",
    "assign_issue",
    object({
      assignee: { type: ["string", "null"] },
      milestone_id: { type: ["string", "null"] },
      labels: labelIds,
      revision: integer,
    }),
    "Replace issue planning fields with version checking; developer required",
  );
  const board = object(
    {
      name: { type: "string", minLength: 1, maxLength: 80 },
      labels: { ...labelIds, maxItems: 12 },
      revision: integer,
    },
    ["name", "labels"],
  );
  add(
    "get",
    "/issue-boards",
    "list_issue_boards",
    null,
    "List the built-in state board and up to 20 saved label boards",
  );
  add(
    "post",
    "/issue-boards",
    "create_issue_board",
    board,
    "Create a saved label board; maintainer required",
  ).responses[201] = { description: "Board created" };
  add(
    "get",
    "/issue-boards/{board}",
    "get_issue_board",
    null,
    "Read the board revision and available label columns; default is a read-only built-in view",
  );
  add(
    "put",
    "/issue-boards/{board}",
    "update_issue_board",
    { ...board, required: ["name", "labels", "revision"] },
    "Update saved board configuration using its current revision; maintainer required",
  );
  add(
    "delete",
    "/issue-boards/{board}",
    "delete_issue_board",
    null,
    "Delete the view while retaining all issues; maintainer required",
  );
  const cards = add(
    "get",
    "/issue-boards/{board}/cards",
    "list_issue_board_cards",
    null,
    "Paginate a board column with the same issue filters; open excludes this board’s labels, closed retains all labels",
  );
  cards.parameters.push(
    ...list.parameters.filter((p) => p.in === "query" && p.name !== "state"),
    {
      name: "column",
      in: "query",
      schema: {
        type: "string",
        description: "open, closed, or a configured label UUID",
      },
    },
  );
  add(
    "post",
    "/issue-boards/{board}/move",
    "move_issue_board_card",
    object(
      { issue: selection, from: string, to: string, board_revision: integer },
      ["issue", "from", "to", "board_revision"],
    ),
    "Move an issue using issue and board revisions; validate its source column and mutate labels/state atomically",
  );
}
