import test from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error Browser module: exercise pure card rendering.
import { issueCard } from "../public/issues.js";
const esc = (s: unknown) =>
  String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
test("issue cards escape untrusted content, constrain label colors and expose versioned accessible move controls", () => {
  const html = issueCard(
    {
      id: 3,
      revision: 9,
      title: "<img onerror=alert(1)>",
      author: "<script>",
      assignee: "dev",
      state: "open",
      milestone: "<b>",
      labels: [{ name: "<svg>", color: '" onmouseover="x' }],
    },
    "/owner/repo",
    esc,
    true,
    {
      writable: true,
      column: "open",
      columns: [
        { id: "open", name: "Open" },
        { id: "closed", name: "<Close>" },
      ],
    },
  );
  assert.doesNotMatch(html, /<img|<script>|<svg>|onmouseover=/);
  assert.match(html, /data-revision="9"/);
  assert.match(html, /data-move-issue="3"/);
  assert.match(html, /选择 Issue 3/);
  assert.match(html, /border-color:#64748b/);
});
