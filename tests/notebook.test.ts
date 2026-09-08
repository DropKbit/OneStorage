import test from "node:test";
import assert from "node:assert/strict";
import {
  parseNotebook,
  notebookText,
  notebookImage,
  NOTEBOOK_LIMITS as limits,
} from "../src/browser/notebook-model";
import { renderMarkdown } from "../src/browser/markdown.js";
const nb = (cells: unknown[], extra = {}) =>
  JSON.stringify({
    nbformat: 4,
    metadata: { language_info: { name: "python" } },
    cells,
    ...extra,
  });
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=";
test("notebook normalizes multiline source and tolerates malformed cells without interpreting HTML", () => {
  const m = parseNotebook(
    nb([
      {
        cell_type: "code",
        source: ["print(1)\n", "# done"],
        execution_count: 0,
        outputs: [null],
      },
      null,
      {
        cell_type: "markdown",
        source: "<script>bad</script>",
        execution_count: -1,
      },
    ]),
  );
  assert.equal(m.language, "python");
  assert.equal(m.cells[0].source, "print(1)\n# done");
  assert.equal(m.cells[0].execution, 0);
  assert.equal(m.cells[0].outputs[0].output_type, "invalid");
  assert.equal(m.cells[1].warnings.length, 1);
  assert.equal(m.cells[2].execution, null);
  assert.equal(notebookText(["a", 3]), null);
  assert.equal(notebookText({}), null);
  assert.throws(() => parseNotebook("{"), /JSON/);
  assert.throws(() => parseNotebook(nb([], { nbformat: 3 })), /nbformat 4/);
  assert.throws(() => parseNotebook(nb([], { cells: {} })), /nbformat 4/);
});
test("notebook bounds UTF-8 input, source, cells, and aggregate output", () => {
  assert.throws(() => parseNotebook(" ".repeat(limits.bytes + 1)), /2 MiB/);
  assert.throws(
    () => parseNotebook(nb([], { extra: "中".repeat(800000) })),
    /2 MiB/,
  );
  const m = parseNotebook(
    nb(
      Array.from({ length: 1003 }, () => ({
        cell_type: "code",
        source: "x",
        outputs: Array.from({ length: 41 }, () => ({
          output_type: "stream",
          text: "x",
        })),
      })),
    ),
  );
  assert.equal(m.total, 1003);
  assert.equal(m.cells.length, 1000);
  assert.equal(m.omitted, 3);
  assert.equal(
    m.cells.reduce((n, c) => n + c.outputs.length, 0),
    1000,
  );
  assert.equal(m.cells[0].outputs.length, 40);
  assert.ok(m.cells.at(-1)!.warnings.some((w) => w.includes("省略")));
  const long = parseNotebook(nb([{ source: "x".repeat(limits.text + 1) }]));
  assert.equal(long.cells[0].source.length, limits.text);
  assert.ok(long.cells[0].warnings[0].includes("截断"));
});
test("notebook inline images require raster signatures and bounded decoded dimensions", () => {
  assert.equal(
    notebookImage({ "image/png": [png.slice(0, 20), "\n", png.slice(20)] }),
    "data:image/png;base64," + png,
  );
  for (const value of [
    "https://example.invalid/x.png",
    btoa("<svg/>"),
    "!!!!",
    png.slice(1),
  ])
    assert.equal(notebookImage({ "image/png": value }), null);
  assert.equal(notebookImage({ "image/svg+xml": "<svg/>" }), null);
  const huge = Buffer.from(png, "base64");
  huge.writeUInt32BE(10001, 16);
  assert.equal(notebookImage({ "image/png": huge.toString("base64") }), null);
  huge.writeUInt32BE(5000, 16);
  huge.writeUInt32BE(5000, 20);
  assert.equal(notebookImage({ "image/png": huge.toString("base64") }), null);
  assert.equal(
    notebookImage({ "image/png": "a".repeat(limits.imageBytes * 2) }),
    null,
  );
  const jpeg = Buffer.from([
    255, 216, 255, 192, 0, 11, 8, 0, 1, 0, 1, 1, 1, 17, 0, 255, 217,
  ]).toString("base64");
  assert.ok(
    notebookImage({ "image/jpeg": jpeg })?.startsWith("data:image/jpeg"),
  );
});
test("notebook Markdown attachments and heading prefixes do not allow active protocols or external image fetches", () => {
  const html = renderMarkdown(
    "# Results\n[heading](#results)\n![chart](attachment:chart%20one.png)\n![external](https://example.invalid/pixel.png)\n[bad](javascript:alert(1))\n[attachment](attachment:thing)",
    {
      idPrefix: "nb-c1-",
      resolveAttachment: (name) =>
        name === "chart%20one.png" ? "data:image/png;base64," + png : null,
    },
  );
  assert.match(html, /id="nb-c1-results"/);
  assert.match(html, /href="#nb-c1-results"/);
  assert.match(html, /src="data:image\/png;base64,/);
  assert.doesNotMatch(html, /<img[^>]+src="https:/);
  assert.doesNotMatch(html, /href="(?:javascript|attachment):/);
  assert.doesNotMatch(renderMarkdown("![x](attachment:file)"), /<img/);
});
