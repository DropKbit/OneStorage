# v0.37 verification: Notebook preview

[简体中文](../VERIFICATION-v37.md) · **English**

Historical release evidence; these are not current-release test counts.

The release added nbformat-4 read-only cells/outputs/attachments, highlighting/Markdown/static HTML/raster/JSON/text/errors, pagination, source, and fixed-SHA links. Only main deployed; D1 schema 0027, R2/DO/Queues, compiler, and gateway were unchanged.

Type checking/367 tests, production dry run, static-route/cache regression, local 33 and production 32 API/browser checks passed. The one-count difference is local admin login. Actual private repositories held a 30-cell notebook/PNG: 25 initially, 30 after load-more, with Python highlight, tables, output/attachment images. Malicious scripts/events/SVG/iframe/forms/styles/links/external images were removed; JS/SVG MIME did not execute. External requests and page errors were zero; script sentinels stayed unchanged.

JSON matched raw source, #L10/#nb-cell-30 worked, mobile had no horizontal overflow, invalid JSON/nbformat3 explained fallback, and later HEAD changes did not alter pinned previews/images. Readers could view; revocation returned 404 for JSON/images and removed preview on refresh; anonymous private reads returned 401. An initial test wrongly expected anonymous 404, then was corrected after cleanup and fully rerun without changing authorization.

Cleanup deleted repositories, disabled users/revoked sessions, and checked zero repositories/credentials/enabled users/code documents/state/content in D1. Disabled audit identities remained. Online bytes/source/health/auth/Cubelink checks passed and private state stayed outside the archive. No Python/Jupyter kernel, executable charts/MathJax/widgets, or rerun of every prior cloud stress suite was claimed. The agreed development scope ended at v0.37, not full GitLab parity.

See [feature contract](NOTEBOOK-v37.md) and [current limits](LIMITS.md).
