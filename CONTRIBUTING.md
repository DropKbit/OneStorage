# Contributing

OneStorage accepts contributions under AGPL-3.0-only.

1. Read `docs/ARCHITECTURE.md`, particularly R2-before-refs ordering and authorization.
2. Install Node.js 22.13+ and npm. Native Git and tar are required for tests, not the service runtime.
3. Run `npm ci` and `npm run dev`. There is only one local server, Wrangler on port 8787.
4. For protocol/storage/auth changes, run `npm run check`, `npm run test:e2e` and `npm run build:production`. Use native Git as an independent compatibility oracle and add focused failure regressions.
5. Format with `npm run format`. Describe behavior, verification and migration impact. Add numbered SQL migrations instead of editing applied ones.

Do not introduce Containers, shell processes or a native Git dependency into the service runtime. Do not execute repository code/hooks, trust caller-selected storage IDs, acknowledge writes before persistence, bypass role checks or store raw passwords/tokens. Only operator-approved webhook receivers may receive events.

Local E2E creates `e2e_` fixtures and refuses non-loopback hosts. Do not weaken that guard to run against a production database. Cloud acceptance must use a separate, narrowly scoped script and temporary credentials/fixtures. Keep `.data`, `.wrangler`, `.dev.vars` and all credentials out of source control.

For browser changes, run `npm run test:ui` against the local server. This optional suite uses Playwright (`npm install --no-save --package-lock=false playwright`), with `CHROME_EXECUTABLE` pointing to an installed Chrome/Chromium executable, or a browser installed with `npx playwright install chromium`. An existing Playwright installation may instead be selected with the absolute `PLAYWRIGHT_MODULE` path to its `index.mjs`. The suite creates isolated browser contexts and temporary repositories/workspaces, disables its test user during cleanup, and writes screenshots under `.data/v12-ui`. It never uses the operator's browser profile. Wait for cleanup to finish before editing Worker code or rebuilding assets, since Wrangler reload interrupts in-flight acceptance requests.

For cross-fork review changes, first run `KEEP_REVIEW_FIXTURE=1 npm run test:reviews`, then `npm run test:review-ui` with the same Playwright options. This local-only suite exercises source selection, branch loading, creation, both sides of a diff, discussion/reply pagination, review and CI gates, and an actual merge. It retains the main fixture for inspection, closes its pagination request, deletes the extra fork, and logs out its isolated browser sessions. Generate a fresh fixture before re-running: a completed merge is intentionally irreversible. Screenshots are under `.data/v13-review-ui`; fixture credentials stay in ignored `.data` files.
