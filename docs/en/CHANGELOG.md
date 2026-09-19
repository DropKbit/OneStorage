# Changelog

[简体中文](../CHANGELOG.md) · **English**

- **v0.40**: Relative file/directory update times in Chinese and English, with exact-date tooltips. Batched first-parent history reads use a fixed commit without delaying the initial directory listing.

- **v0.39**: Durable root/README cache, post-push prewarming, live ref validation and Server-Timing. [Details](PERFORMANCE.md).

- **v0.38**: Primary domain and Simplified Chinese/English interface and documentation. [Guide](DEPLOYMENT.md).
- **v0.37**: Read-only Jupyter Notebook cells, safe outputs, source switching, and pagination. [Guide](NOTEBOOK-v37.md).
- **v0.36**: Selected tsconfig/JSONC inheritance, aliases, JSX, and source extension resolution. [Guide](CI-TSCONFIG-v36.md).
- **v0.35**: Integrity-checked public npm downloads cached in dedicated R2 storage. [Guide](CI-NPM-CACHE-v35.md).
- **v0.34**: Repository-local code-index content reuse for unchanged, renamed, and copied files. [Guide](CODE-CONTENT-v34.md).
- **v0.33**: GitHub/GitLab OAuth with explicit identity linking, MFA, and credential revocation. [Guide](OAUTH-v33.md).
- **v0.32**: Default-branch code index, path/extension filters, fixed-commit results, and rebuilds. [Guide](CODE-SEARCH-v32.md).
- **v0.31**: Durable merge queue with exact-candidate CI, reapproval, cancellation, and recovery. [Guide](MERGE-QUEUE-v31.md).
- **v0.30**: One-use offline password recovery with MFA and atomic credential revocation. [Guide](PASSWORD-RECOVERY-v30.md).
- **v0.29**: Atomic Git ref/audit intent and idempotent D1 receipt delivery. [Guide](GIT-RECEIPTS-v29.md).
- **v0.28**: Cross-project collaboration search with live authorization and stable pagination. [Guide](SEARCH-v28.md).
- **v0.27**: Explicitly authorized private npm dependencies in native WASM builds. [Guide](CI-PRIVATE-PACKAGES-v27.md).
- **v0.26**: Independent project/space deploy tokens with scoped access, expiry, and rotation. [Guide](DEPLOY-TOKENS-v26.md).
- **v0.25**: Native npm and generic package registry with immutable versions and asynchronous cleanup. [Guide](PACKAGES-v25.md).
- **v0.24**: Space CI variable inheritance, project overrides, and cross-project revocation. [Guide](CI-WORKSPACE-VARIABLES-v24.md).
- **v0.23**: Administrator-configured OIDC, linking, controlled registration, MFA, and revocation. [Guide](OIDC-v23.md).
- **v0.22**: Native TypeScript/TSX/npm compilation, JS/CSS artifacts, application activation/rollback. [Guide](CI-BUILDS-v22.md).
- **v0.21**: R2 CI caches with scoped keys, success gates, generations, and cleanup. [Guide](CI-CACHES-v21.md).
- **v0.20**: Encrypted project variables, explicit selection, snapshots, and log masking. [Guide](CI-VARIABLES-v20.md).
- **v0.19**: Durable timezone-aware schedules and permission-aware dispatch/cancellation. [Guide](CI-SCHEDULES-v19.md).
- **v0.18**: Bounded page snapshots during native Git transfers. [Guide](GIT-READS-v18.md).
- **v0.17**: Disposable complete pack cache with validation and corruption fallback. [Guide](GIT-PACK-CACHE-v17.md).
- **v0.16**: Streaming incoming packs, R2 staging, and recoverable cleanup. [Guide](GIT-RECEIVE-v16.md).
- **v0.15**: Bounded transient R2 recovery and private Git incident diagnostics. [Guide](GIT-RELIABILITY-v15.md).
- **v0.14**: Fixed-commit JSON configuration, dependency workflows, parallel jobs, and artifacts. [Guide](CI-WORKFLOWS-v14.md).
- **v0.13**: Size-aware four-way Git prefetch with backpressure and draining. [Guide](GIT-PREFETCH-v13.md).
- **v0.12**: Durable object-closure indexing and streaming outbound packs. [Guide](GIT-SCALE-v12.md).
- **v0.11**: Project transfers/renames, stable UUIDs, current permissions, and protected aliases. [Guide](TRANSFER-v11.md).
- **v0.10**: Recoverable project archive with Git/LFS/collaboration/CI write barriers. [Guide](ARCHIVE-v10.md).
- **v0.9**: Issue filters/pagination, label boards, bulk actions, and revision checks. [Guide](ISSUES-v09.md).
- **v0.8**: CODEOWNERS, default-branch issue-closing merges, and bounded R2 concurrency. [Guide](REVIEWS-v08.md).
- **v0.7**: Fork merge requests, line discussions, resolution gates, and target-config CI. [Guide](REVIEWS-v07.md).
- **v0.6**: TOTP/recovery codes, sessions, profiles/activity, Markdown and private raster previews. [Guide](ACCOUNT-v06.md).
- **v0.5**: Isolated cloud JS/WASM CI, application releases, review protection, and collaboration. [Guide](CLOUD-NATIVE-v05.md).
- **v0.4**: Spaces/roles, administration, highlighting, and external-runner CI. [Guide](PLATFORM-v04.md).
- **v0.3**: Code Storage behavior mapping, expanded Git APIs, SDKs, and MCP. [Guide](VERIFICATION.md).
- **v0.2**: Container-free JavaScript Git engine and native protocol acceptance. [Guide](VERIFICATION-v0.2.md).

Versioned guides and verification reports describe their own release scope. Subsequent additions do not turn historical test results into new acceptance evidence. The current scope is listed in [limits](LIMITS.md).
