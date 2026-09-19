# OneStorage

[简体中文](README.md) · **English**

**An open-source Git collaboration platform running on Cloudflare.**

Host code, manage teams, and review changes in a GitLab / Gogs-style workspace. The Git server runs as JavaScript in Workers, with data stored in your own Cloudflare account. No server, Docker, or containers required.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2FDropKbit%2FOneStorage%2Ftree%2Fdeploy)

[Live instance](https://1s.hk) · [GitHub](https://github.com/DropKbit/OneStorage) · [Self-hosted repository](https://1s.hk/1shk/nb) · [Deployment guide](https://1s.hk/docs/en/DEPLOYMENT.html) · [Changelog](https://1s.hk/docs/en/CHANGELOG.html)

## Features

- **Code hosting:** public/private repositories, HTTPS clone/push/fetch, branches, tags, forks, Git LFS, and upstream synchronization.
- **Code browsing:** file/directory update times, syntax highlighting, file history, diffs, blame, cross-project search, and Markdown, image, and Jupyter Notebook previews.
- **Collaboration:** multiple workspaces, role-based access, issues/boards/milestones, merge requests, line discussions, CODEOWNERS, and protected branches.
- **CI/CD:** push and scheduled triggers, logs, variables/secrets, caches, and artifacts. Cloud builds support TypeScript/TSX, JS/CSS, and locked npm dependencies, with app publishing and rollback.
- **Project management:** npm/generic package registries, releases, wikis, notifications, audit logs, and administration.
- **Languages and docs:** Simplified Chinese and English, saved language preferences, and [bilingual documentation](https://1s.hk/docs/en/index.html).
- **Accounts and integrations:** access tokens, two-factor authentication, OAuth/OIDC sign-in, webhooks, REST API, MCP, and TypeScript/Python/Go SDKs.

## Architecture

A complete instance has three Workers: the **main service** handles Git, the website, and APIs; the **compiler** builds code with WASM; and the **app gateway** serves published apps on a separate domain.

| Cloudflare service        | Purpose                                                       |
| ------------------------- | ------------------------------------------------------------- |
| Workers + Static Assets   | Website, authentication, Git HTTPS, and APIs                  |
| Durable Objects           | Coordinate repository writes and atomically update references |
| R2                        | Git objects, LFS, packages, build artifacts, and caches       |
| D1                        | Users, permissions, collaboration, indexes, and job state     |
| Queues + Cron + DO Alarms | Background jobs, events, retries, and cleanup                 |
| Worker Loader + WASM      | Isolated cloud tasks, compilation, and app execution          |

A push follows **Git client → main Worker authorization → repository DO coordination → R2 object storage → DO reference publication**. Indexing, CI, and notifications run in the background. See the [architecture guide](https://1s.hk/docs/en/ARCHITECTURE.html).

## Deploy to Cloudflare

Click **Deploy to Cloudflare** above to create an instance from the `deploy` template branch:

1. Connect GitHub and Cloudflare, choose a project name, and select new D1, R2, and Queue resources.
2. Enter `BOOTSTRAP_SECRET` and `CREDENTIAL_ENCRYPTION_KEY`. Service URLs are generated automatically.
3. Open the main Worker URL after deployment and create your administrator using the bootstrap secret.

The template migrates D1, deploys the compiler, gateway, and main Worker in order, and connects storage and service URLs. Appropriate Cloudflare quotas and deployment permissions are required. See the [deployment details and verification status](https://1s.hk/docs/en/DEPLOYMENT.html#one-click-deployment). Preserve resources and encryption keys when upgrading.

The primary domain is `1s.hk`. Browser pages on `git.1s.hk` redirect to it; existing Git HTTPS URLs remain compatible. OneStorage replaces the former Cubelink service.

## Try locally

Requires Node.js 22.13+ and npm:

```sh
git clone https://1s.hk/1shk/nb.git onestorage
cd onestorage
npm ci
npm run dev
```

Open [localhost:8787](http://localhost:8787). Create an administrator with bootstrap secret `local-development-only-change-me` and a password of at least 12 characters. This secret is only for local development. Use a personal access token (PAT) as the password for Git HTTPS authentication.

## Scope

Current release: **v0.40 alpha**. Cloud CI runs JS/WASM, not arbitrary shell commands, Python, or npm lifecycle scripts. General command builds can use a self-managed external runner. SSH Git transport, shallow/partial clones, and full GitLab API compatibility are not supported. See [limits](https://1s.hk/docs/en/LIMITS.html) for repository and capacity boundaries.

[Deployment and recovery](https://1s.hk/docs/en/DEPLOYMENT.html) · [CI/CD](https://1s.hk/docs/en/CI-BUILDS-v22.html) · [API](https://1s.hk/docs/en/API.html) · [SDK](https://1s.hk/docs/en/SDK.html) · [Contributing](CONTRIBUTING.en.md) · [Security](SECURITY.en.md)

Licensed under [AGPL-3.0-only](LICENSE). Modified versions offered as a network service must provide their corresponding source to users. Independently implemented with reference to [Code Storage documentation](https://code.storage/docs/); not affiliated with Code Storage, GitLab, Gogs, or Cloudflare.
