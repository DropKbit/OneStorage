# Jupyter Notebook preview (v0.37)

[简体中文](../NOTEBOOK-v37.md) · **English**

Opening `.ipynb` in the code browser shows a read-only preview using existing Git/R2 reads and repository authorization. It requires no Python/Jupyter server, container, or third-party preview site. It never executes notebooks, provides kernels, reruns cells, or edits outputs. Try the [example notebook](../../examples/notebook.ipynb).

Supported: nbformat 4; string/string-array source and text; Markdown, highlighted code, and raw cells; execution counts, stdout/stderr, tracebacks; PNG/JPEG, sanitized static HTML/table, Markdown, JSON, and plain-text outputs, in that preference order. Markdown supports raster attachments and same-repository images pinned to the preview commit. External images become links and do not load automatically.

Preview/JSON switching, 25 cells/page, `#nb-cell-N` links, and source `#LN` links are supported. The module loads on demand; Markdown/highlight modules share existing caches and content-versioned imports.

## Boundaries

Source/streams/errors use text nodes; Markdown forbids HTML. DOMPurify 3.4.15 filters HTML through explicit static tags/attributes, removing scripts, SVG, iframes, forms, styles, handlers, links, and external images. CSP is unchanged. JavaScript MIME, interactive widgets, Plotly/Bokeh scripts, LaTeX/MathJax, and SVG do not execute/load. Without a static representation, an unsupported notice appears.

Preview limits: 2 MiB UTF-8 input, 1,000 cells, 40 outputs/cell and 1,000 overall; 100,000 characters/text; 1,500 static HTML elements. Embedded raster signatures must match PNG/JPEG, with at most 1 MiB decoded bytes, 10,000 pixels/side, and 16 million pixels. Decode failure shows a notice; these checks are not full image-format validation.

Invalid JSON, older formats, and oversized input explain the issue and retain source access. Source preview shows at most 10,000 lines or 2,097,152 characters; use Git for the full file. Existing repository read limits apply. Private JSON/images require current authorization; revocation blocks new reads but cannot recover bytes already downloaded.

## Verification

`npm run check` includes normalization, budgets, image checks, Markdown attachment safety, and static routing. Run `PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs npm run test:notebook` for isolated-browser acceptance covering actual commits, highlighting, tables/charts, no external requests/scripts, pagination, anchors/source, mobile, invalid formats, fixed SHA, and member revocation. Cleanup removes repositories, disables fixture accounts, revokes sessions, and verifies D1. Remote testing requires explicit opt-in, origin, and private token file. See [verification](VERIFICATION-v37.md), [nbformat](https://nbformat.readthedocs.io/en/latest/format_description.html), and [DOMPurify](https://github.com/cure53/DOMPurify).
