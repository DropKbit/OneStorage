# Native builds with private npm dependencies

[简体中文](../CI-PRIVATE-PACKAGES-v27.md) · **English**

The v0.27 `build` step can mix public npmjs dependencies with private packages from this OneStorage instance. The main Worker reads the fixed lockfile, authorizes R2 package access, verifies integrity, and sends bounded package bytes to the WASM compiler. The compiler receives no deploy tokens or CI variable values and no private-storage bindings. No container or external runner is required.

## Setup

1. Create a package-project or space deploy token with `read_package_registry`.
2. Store it as a **secret** CI variable such as `PACKAGE_TOKEN`, with appropriate branch/protection rules; space inheritance is supported. Never commit the token.
3. Install using npm and commit package.json plus an npm v2/v3 lockfile containing the current project URL, exact version, and SHA-512 integrity.
4. Choose the private npm build template. For another project, replace `project_id` with the package project's UUID from `GET /api/repos/:namespace/:repo`.

```json
{
  "runner": "worker",
  "variables": ["PACKAGE_TOKEN"],
  "timeout_seconds": 110,
  "steps": [
    {
      "type": "build",
      "entry": "src/index.ts",
      "private_registries": [
        {
          "project_id": "00000000-0000-4000-8000-000000000001",
          "token_variable": "PACKAGE_TOKEN"
        }
      ]
    }
  ],
  "deploy": {
    "kind": "worker",
    "entry": "dist/index.js",
    "files": ["dist/index.js"],
    "environment": "production"
  }
}
```

Replace the example UUID. At most eight distinct project registries; each credential name must also appear in the task's `variables`. Only secret variables holding OneStorage deploy tokens are accepted. Sessions/PATs and implicit whole-space access are not used. A space token may cover multiple explicitly listed projects. See [deploy-token client setup](DEPLOY-TOKENS-v26.md). Successful builds retain fixed-SHA, environment CAS, and workflow activation gates.

## Authorization

The main Worker validates current `APP_ORIGIN`, current project path, configured UUID, token scope, filename, package/version, and SHA-512. It reads internal R2 bytes rather than sending credentials to lockfile URLs. Old-path redirects, URL credentials, query tokens, third-party private registries, and Git/file/link dependencies are rejected. Regenerate lockfile URLs after renaming a project or changing its canonical origin.

CI secrets first pass branch, protection, current-commit, MR-origin, lease, and owner checks. Untrusted MR code cannot use builds to read private packages. Deploy-token authorization is checked before and after package reads. The compiler only gets validated source/options/package bytes and never runs lifecycle scripts.

`ci_run_packages` records dependency file, lifecycle, and token hash/version snapshots, not plaintext. Rotation, revocation, expiry, package withdrawal/deletion, or project transfer prevents unfinished jobs/workflows from publishing artifacts, applications, or caches. Final D1 writes recheck authorization. A successful child still constrains an unfinished parent and sibling jobs. Active revocation cancels work; natural expiry is checked during reads/publication independently of Cron.

Already successful pipeline outputs remain historical, and active applications are not automatically taken offline by later credential revocation. Disable/switch the application environment separately. Bytes already delivered cannot be recovered.

## Budgets and deployment

All private lock entries are preloaded, even if not imported; public packages remain demand-loaded. Maximum 64 private entries and 4 MiB compressed private bytes/step; duplicate URLs transfer once. Supplied private and fetched public packages share the compiler's 4 MiB compressed budget. Other [build limits](CI-BUILDS-v22.md) apply. The bounded main-to-compiler JSON request is at most 12 MiB.

Private downloads bypass the public npm cache. Tags do not resolve versions; arbitrary npm commands, aliases, extended tar headers, native modules, and unsupported toolchains remain excluded. Registry upload limits can exceed compiler limits; upload success does not imply build compatibility.

Apply `0022_ci_private_packages.sql` after backup/rehearsal, then deploy compiler and main. Public-package requests remain compatible. `npm run test:private-builds` covers actual npm publish/lockfiles, mixed TSX compilation, R2 outputs, activation/rollback, templates, invalid/unauthorized inputs, rotation, recovery, and revocation. Remote acceptance requires `ALLOW_REMOTE_ACCEPTANCE=1` and a private `ONESTORAGE_TOKEN_FILE`. See [verification](VERIFICATION-v27.md).
