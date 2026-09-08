# Deploy OneStorage

[简体中文](../DEPLOYMENT.md) · **English**

## Current instance

The canonical URL is **https://1s.hk**. OneStorage replaces Cubelink on the primary domain. Browser pages on `git.1s.hk` redirect to the primary domain; existing Git HTTPS and API URLs remain compatible. The independent Worker URL is `https://onestorage.xbitfun.workers.dev`. Browser sign-in and LFS should use the canonical URL matching APP_ORIGIN.

Resources: main Worker `onestorage`, private compiler `onestorage-build`, D1 `onestorage`, R2 `onestorage-objects` and `onestorage-npm-cache`, Queue `onestorage-events`, and SQLite Durable Object class `Repository`. The separate `onestorage-apps` gateway serves apps. There are no Containers, Docker images, or external Git servers.

The operator chooses the initial administrator username and password in the website. The bootstrap secret is held in the Worker secrets and in an ignored local `.data/production-bootstrap-secret.txt` file with mode 0600. Never add it to source or publish it. Successful setup locks initialization in D1; BOOTSTRAP_SECRET can then be removed from the Worker.

## Primary domain and languages

Use `APP_ORIGIN=https://1s.hk` and `LEGACY_APP_ORIGIN=https://git.1s.hk`. Both domains bind to the main Worker. Only browser page GET/HEAD requests redirect; native Git and API requests do not. Sign in again on the new domain. Change OIDC/OAuth provider callbacks to `https://1s.hk/api/auth/oidc/callback`. Repository UUIDs, D1, R2, DOs, and encryption keys remain unchanged.

The platform supports Simplified Chinese and English. The language menu saves the browser preference; first visits negotiate the browser language. Use `?lang=en` or `?lang=zh-CN` to choose explicitly. `/docs` opens the selected documentation language, and each document links to its counterpart. Code, filenames, issue bodies, and other user content are not translated.

## Deploy a new instance from source

Requires a Cloudflare account with Workers, D1, R2, SQLite Durable Objects, Queues, and sufficient quotas, plus Node.js 22.13+ and npm. Docker and server-side Git are unnecessary. Cloudflare resource charges and quotas depend on the account plan.

```sh
npm ci
npx wrangler login
npx wrangler whoami
npx wrangler d1 create onestorage
npx wrangler r2 bucket create onestorage-objects
npx wrangler r2 bucket create onestorage-npm-cache
npx wrangler queues create onestorage-events
```

Run create commands only for new instances. Existing resources must not be recreated. Put the database UUID in `wrangler.jsonc` and `wrangler.apps.jsonc`. Their DB / OBJECTS bindings must share this instance’s database and Git object bucket. `NPM_CACHE` in `wrangler.build.jsonc` uses a separate cache bucket; see [npm caching](CI-NPM-CACHE-v35.md) for cleanup configuration.

Choose unique resource names if necessary. Replace APP_ORIGIN and custom-domain routes without overwriting other services. For workers.dev-only deployments, remove routes and use the actual Worker URL as APP_ORIGIN. Remove LEGACY_APP_ORIGIN unless migrating your own previous domain. Keep logical binding names DB, OBJECTS, REPOSITORIES, and EVENTS unchanged.

```sh
npm run check
npm run build:production
npm run build:compiler
npm run db:remote
npm run deploy:build
npm run deploy:apps
# Set APPS_ORIGIN to the returned gateway URL before deploying the main service.
npm run deploy
npx wrangler secret put BOOTSTRAP_SECRET
npx wrangler secret put CREDENTIAL_ENCRYPTION_KEY
```

Deploy compiler and gateway before the main Worker. The main BUILDER service name must match `wrangler.build.jsonc`. The compiler binds only the public npm cache bucket, with no Git database, Git object bucket, or sign-in secrets. Its workers.dev and preview URLs are disabled. Compiler upgrades need no D1 migration. See [cloud builds](CI-BUILDS-v22.md).

Keep LOADER in the gateway configuration. Set APPS_ORIGIN to its independent URL before publishing the main Worker. The app domain must be separate from the Git login domain.

Deployment and build commands generate `public/source.tar.gz` from an explicit source allowlist for AGPL source downloads. Keep private files outside these directories. `.data`, `.wrangler`, and environment-secret files are excluded.

Use at least 32 random bytes for BOOTSTRAP_SECRET and enter it at the Wrangler prompt. Without this secret, setup refuses account creation; there is no unprotected registration. Never deploy `wrangler.local.jsonc`, which contains public test secrets, or import local `.wrangler` data.

Check `/api/health`, HTTPS, and static pages. Initialize the administrator, create a private acceptance project and temporary PAT, and exercise real push, clone, fetch, merge, and LFS operations. Revoke test credentials afterward. DNS propagation and local negative caching can differ; do not disable TLS verification to diagnose DNS.

## One-click deployment

[Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2FDropKbit%2FOneStorage%2Ftree%2Fdeploy) uses the [GitHub deploy branch](https://github.com/DropKbit/OneStorage/tree/deploy). It includes complete source and portable configuration, without the current instance’s domain, database ID, or credentials.

The Cloudflare form creates or selects D1, two R2 buckets, and a Queue, then writes real resource identifiers into the configuration. URLs are generated automatically. Worker names must contain 2–50 lowercase letters, digits, or hyphens, begin with a letter, and end with a letter or digit. Reserve the derived `<name>-build` and `<name>-apps` names too. New instances must not reuse existing-instance resources; check whether dropdowns automatically selected matching existing names.

Generate two separate random values: `openssl rand -hex 32` for BOOTSTRAP_SECRET and `openssl rand -base64 32` for CREDENTIAL_ENCRYPTION_KEY. The former initializes the administrator; the latter encrypts credentials and must be securely retained across upgrades.

Build command: `npm run build`. Deploy command: `npm run deploy`. The script applies all D1 migrations, deploys the private compiler and independent gateway, then deploys the main Worker. Main and gateway share DB / OBJECTS; the compiler receives only NPM_CACHE. BUILDER and service URLs are connected automatically. Compiler/gateway deployments remove CI names and tags reserved for the primary Worker to avoid overwriting one another.

This adds orchestration above the official single-Worker button. The build token needs account permissions to manage Workers Scripts, D1, R2, and Queues. If the generated token lacks permissions, choose an appropriate deployment token in Workers Builds and retry. Enable required services/quotas first; resource usage is billed normally. Failure does not delete existing data. Fix configuration and redeploy; cleanup of incomplete instances is separate.

GitHub main and the self-hosted repository contain normal source. The deploy branch contains transformed release configuration. Maintainers update it in a separate checkout using `node scripts/prepare-deploy.mjs <checkout-directory>`, never over an existing instance’s configuration. See [official button requirements](https://developers.cloudflare.com/workers/platform/deploy-buttons/).

Verification status, 2026-09-09: the official form parsed the template. Running the same script with independent resources verified migrations, all three Worker deployments, shared bindings, automatic URLs, and initial administrator setup. The complete browser-triggered build remains unverified: the test account returned `Your GitHub authorization has expired` before creating its repository. This authorization is separate from Wrangler login and repository deploy keys. Restore it using [Cloudflare’s GitHub integration instructions](https://developers.cloudflare.com/pages/configuration/git-integration/github-integration/#reinstall-the-cloudflare-github-app). Reinstalling a shared GitHub App affects other build connections and should be handled by the account administrator.

## Upgrades and v0.1 migration

For v0.24, apply `0019_workspace_ci_variables.sql` before the main Worker. Other Workers need no deployment for that upgrade. Existing project variables and run snapshots stay compatible; shared values use the original encryption key and workspace-specific scope. See [workspace variables](CI-WORKSPACE-VARIABLES-v24.md).

For v0.23, apply `0018_oidc.sql` before the main Worker; gateway/compiler need no redeployment for that upgrade. Passwords and sessions remain compatible. Preserve CREDENTIAL_ENCRYPTION_KEY. Configure providers at `/admin/identity`; callbacks use APP_ORIGIN plus `/api/auth/oidc/callback`. See [OIDC migration](OIDC-v23.md). Test providers are not retained as production defaults.

Keep Worker names, DO classes, migration history, D1 UUIDs, and repository UUID mappings stable. Back up and validate independently before applying numbered migrations and deploying. This deployment originally started with v0.2 and has no remote legacy Container class. Independently deployed older instances must preserve applied DO migration history and explicitly retire Container classes rather than rewriting history.

If a legacy snapshot pointer exists without `refs.v2`, the first request parses its tar in the Worker, imports Git objects into R2, then atomically publishes references. macOS AppleDouble metadata is supported. The old snapshot is retained, but later writes do not update it: rolling back to the old engine hides new changes. Repositories exceeding new budgets need an offline migration plan; do not create an empty repository to conceal import failures.

## Webhooks

WEBHOOK_ALLOWED_HOSTS defaults to empty, disabling outbound delivery. Operators may allow trusted HTTPS hosts such as `build.example.net,hooks.example.net`, excluding tenant-controlled DNS and internal addresses.

Maintainers create `{url}` through the API and receive a signing secret once. Events include event name, repository UUID, actor, detail, and time, not code or credentials. Audit records and outbox rows share a D1 batch. A five-minute Cron retries queue submission failures. Delivery attempts are capped at five and exposed through the deliveries API. Receivers must verify timestamp/HMAC and deduplicate X-OneStorage-Delivery.

Git references and push events are atomically recorded in the DO, then idempotently projected into D1 by alarms. Receivers still handle duplicates/delays and periodically compare references. Git and collaboration metadata do not form a distributed transaction.

## Operations and costs

- APP_ORIGIN must match the browser’s canonical URL; it affects cookie-authenticated writes and LFS action URLs.
- Each repository has one DO, with at most 16 queued requests and serialized operations. There are no container counts or startup delays.
- R2 stores canonical objects individually; packs are generated for transport. Read count and history size affect latency and cost.
- [Application limits](LIMITS.md) coexist with independent Worker/DO CPU, memory, and subrequest limits. Large repositories remain outside the intended scope.
- Repository deletion cleans objects through DO alarms. Active repositories have no unreachable-object GC or total storage quota.
- Monitor Worker errors, saturated DO requests, R2 usage/missing objects, and D1/Queue failures. A health check is not a durability or recovery test.

## Backup and recovery

Back up D1, R2 repos/ and lfs/, and every DO’s refs.v2 and any unmigrated snapshot together. **R2 alone cannot restore all references or accounts.** Cross-service consistent backups, one-click full-site recovery, and reference-export administration are not implemented; production disaster recovery needs implementation and rehearsal.

- Worker restart: normal requests reload DO references and R2 objects; no cache-recovery script is needed.
- Missing referenced object: restore its canonical R2 bytes; do not publish empty references.
- Accidental deletion: stop repository writes and restore required components from a consistent backup.
- Never apply blind expiration to Git objects. GC must enumerate reliable active references, compute reachability, and enforce retention and concurrency protection.

## v0.3 upgrade and connections

Back up D1/objects/references, apply `0004_forge_features.sql`, and deploy the v0.3 Worker. CREDENTIAL_ENCRYPTION_KEY is **32 random bytes encoded as base64**, generated with `openssl rand -base64 32` in a secure terminal and entered through Wrangler. Never log it, commit it, or use local test values. Retain the key if encrypted data already exists; replacement makes credentials unreadable. New instances may configure secrets before or after initial deployment. Missing encryption configuration returns 503 for connection management.

SYNC_ALLOWED_HOSTS optionally allows comma-separated trusted public HTTPS hosts for self-hosted Gitea/Forgejo/GitLab, without ports, paths, or IP addresses. Common public providers are built in. WEBHOOK_ALLOWED_HOSTS remains empty by default.

Configure GitHub App app_id, installation_id, RSA private_key, and a webhook_secret of at least 16 characters under Keys and connections. Grant Contents read/write and subscribe to push at `/webhooks/github/<username>`. Private keys are encrypted in D1. Public GitHub mode needs no App; generic mode needs stored HTTPS credentials before sync. Unconfigured external Apps never report fake success.

The sync page shows durable jobs/errors and supports retries. Uncertain upstream pushes temporarily return 409 for ordinary operations until background pull reconciles them. Automatic retries stop after five attempts; manually pull after fixing access or networking. Do not remove DO reconciliation markers to bypass recovery.

`npm run test:sync` pulls public GitHub into a local instance without modifying that upstream. SDK acceptance requires Python ≥3.10 with cryptography and Go ≥1.24. CI includes local HTTP/native Git/SDK checks. Actual private App installation acceptance requires operator configuration and is distinct from repeatable provider simulations.

See [v0.2 historical verification](VERIFICATION-v0.2.md) and [verification](VERIFICATION.md). Statements such as uninitialized/no deletion GC in old reports apply only to those releases.

## Repeatable cloud acceptance

`scripts/verify-cloud.mjs` refuses to run by default. After confirming a test instance, set ALLOW_REMOTE_ACCEPTANCE=1, ONESTORAGE_ORIGIN, ONESTORAGE_NAMESPACE, and ONESTORAGE_TOKEN, then run `node --import tsx scripts/verify-cloud.mjs`. Inject tokens securely, not through command-line arguments or configuration files. The script creates random accept_v03_ private repositories and deletes them in finally; it reads public GitHub without writing upstream. ACCEPTANCE_REPORT optionally saves a credential-free report in an ignored directory.
