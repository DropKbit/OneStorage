# Cloudflare-native TypeScript and npm builds

[简体中文](../CI-BUILDS-v22.md) · **English**

A `build` step runs esbuild 0.28.2 WASM in the private `onestorage-build` Worker. The control plane reads a fixed Git commit, invokes a Service Binding, stores artifacts/application versions in R2, and retains D1 leases, workflow gates, revocation, and environment CAS activation/rollback. No container, Node server, or external runner is needed for this supported compiler path.

It bundles JS/TS/JSX/TSX, JSON, and CSS. It does not run arbitrary `npm run build`, lifecycle scripts, Vite/Next configuration, shell, native plugins, or TypeScript type checking; use a trusted external runner for those. The compiler does not execute input source or receive CI secret values. Initially it had no storage bindings; [v0.35](CI-NPM-CACHE-v35.md) adds only a dedicated public-npm R2 cache. Deployed applications remain isolated Dynamic Workers without outbound network/account bindings.

## Configuration

Choose the TypeScript/npm template in CI/CD, save inline JSON or `.onestorage-ci.json`, or use a Worker child job in a DAG. Later JavaScript steps receive compiled `input.artifacts`; dependent jobs and deployments can also use them.

```json
{
  "runner": "worker",
  "timeout_seconds": 110,
  "steps": [
    {
      "type": "build",
      "entry": "src/index.ts",
      "sources": ["src", "package.json", "package-lock.json"],
      "outfile": "dist/index.js",
      "platform": "worker",
      "minify": true,
      "sourcemap": false
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

`sources` selects exact files or recursive directories at the run SHA, without globbing, symlinks, or submodules. The default is shown above. Dependency-free builds can omit package files; declared npm dependencies require a matching selected lockfile. The entry must be selected.

Use `platform: browser` for browser code. CSS imports produce a sibling `.css` file. Static deployments must list the source HTML and generated JS/CSS, using relative asset URLs. Output is ES2022 ESM. JSX defaults to automatic/react; `jsx_import_source` can select Preact. Optional inline source maps increase size and include source. [v0.36 tsconfig support](CI-TSCONFIG-v36.md) supersedes the original lack of tsconfig/path aliases.

Unresolved imports or compilation warnings fail the run. Unsupported: package browser-object mappings, computed dependencies, Node/Cloudflare built-ins, native modules, and binary asset loaders.

## Locked dependencies and budgets

npm lockfile v2/v3 `packages` layouts are supported. Root dependency/devDependency/optionalDependency declarations must match package.json. Public packages are fetched on demand for actual imports, including nested versions and conditional exports. Versions are never floated and missing dependencies are not installed automatically.

Entries require an exact version, approved HTTPS tarball URL, and SHA-512 SRI. Redirects, Git/file/workspace/link dependencies are rejected. Public packages use npmjs; current-instance private packages require [explicit authorization](CI-PRIVATE-PACKAGES-v27.md). Compressed bytes are verified before in-memory tar extraction, with checksum, path, package-version, size, and count checks. No filesystem writes or archive links. Only standard tar file/directory entries are supported; PAX/GNU extension headers fail.

Per step: 256 source files, 1 MiB/file, 4 MiB total source; 64 imported packages; 10,000 tar entries; 4 MiB compressed and 8 MiB expanded including tar headers/padding. Artifacts: 1 MiB/file, ten files/job, 2 MiB total encoded JSON. WASM compilation has 60 seconds; the Service Binding request 75 seconds; the Worker job remains within 110 seconds/lease. Reads and publication consume that same job time.

One compiler instance processes one build at a time; the control plane retries busy responses up to ten times to avoid shared peak WASM memory. Failed builds cannot publish activatable versions. Account scheduling controls concurrency; limits are not throughput promises. [Public download caching](CI-NPM-CACHE-v35.md) now avoids some repeated downloads without increasing budgets.

## Deployment and acceptance

Deploy the compiler before the main Worker: `npm run deploy:build`, then `npm run deploy`. The compiler disables workers.dev/preview URLs and is called through `BUILDER`. v0.22 required no database migration.

`npm run dev` starts main/compiler together; a separately running main process can use `dev:build` on 8788. Application acceptance uses a gateway bound to the same local D1/R2, normally `TEST_APPS_ORIGIN=http://localhost:8789`.

Run `npm run check` and `npm run test:builds`. Remote tests require `ALLOW_REMOTE_ACCEPTANCE=1`, `TEST_ORIGIN`, and a mode-600 `ONESTORAGE_TOKEN_FILE`. Do not edit/deploy until cleanup finishes.

Historical v0.22 verification on 2026-09-08: 245 unit tests/type checking; local builds 23 checks/47 API requests, production 23/61. Actual Preact 10.29.3 TSX compilation, SHA-512 verification, R2 output, Dynamic Worker execution, two releases, CAS rollback, stale activation rejection, static HTML/JS/CSS, wrong SRI, and `node:fs` rejection passed. Core 43 assertions/Git/LFS, workflows 23/97, local Git/DAG/fsck 22 and production 21, general UI 43 and workflow UI 19 passed. Fixtures/credentials were cleaned. An initial shared-state `SQLITE_BUSY` was resolved for testing with isolated compiler state; multi-Worker single-process development was separately checked. These small real applications do not establish compatibility with the entire npm ecosystem or maximum resource budgets.
