import test from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error The browser ES module is JavaScript; this test exercises its pure diff renderer.
import { reviewDiff, codeownersPanel } from "../public/collaboration.js";
const escape = (s: unknown) =>
  String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
test("review diff anchors distinguish header-like source lines and escape hostile filenames and code", () => {
  const path = 'quoted"<file>.txt',
    diff = `diff --git ${JSON.stringify("a/" + path)} ${JSON.stringify("b/" + path)}\n--- ${JSON.stringify("a/" + path)}\n+++ ${JSON.stringify("b/" + path)}\n@@ -1,2 +1,2 @@\n--- old content\n-ordinary\n+++ new content\n+<script>alert(1)</script>\n`;
  const html = reviewDiff(diff, escape, true);
  assert.equal((html.match(/data-review-line=/g) || []).length, 4);
  assert.match(html, /data-review-line="2" data-review-side="old"/);
  assert.match(html, /data-review-line="2" data-review-side="new"/);
  assert.doesNotMatch(html, /<script>|<file>/);
  assert.doesNotMatch(reviewDiff(diff, escape, false), /data-review-line=/);
});

test("codeowners summary escapes rule/identity/path text and displays complete counts with bounded lists", () => {
  const html = codeownersPanel(
    {
      file: "<script>",
      target_sha: "a".repeat(40),
      allowed: false,
      requirements: [
        {
          section: "<img onerror=x>",
          pattern: "<b>",
          owners: ["<owner>"],
          eligible: ["<dev>"],
          approved: [],
          required: 2,
          path_count: 999,
          eligible_count: 123,
          approved_count: 0,
          paths: ["<file>"],
        },
      ],
    },
    escape,
  );
  assert.doesNotMatch(html, /<script>|<img|<owner>|<file>/);
  assert.match(html, /999 个文件/);
  assert.match(html, /123 人/);
});
