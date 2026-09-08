# Public npm download cache (v0.35)

[简体中文](../CI-NPM-CACHE-v35.md) · **English**

Native `build` steps reuse public npm tarballs across builds through the compiler's dedicated R2 bucket, `onestorage-npm-cache`. Git objects, project source, private packages, and CI secrets never enter it. It stores disposable derived downloads, not artifacts or the package registry.

Keys combine normalized registry URL and lockfile SHA-512 SRI. Only credential-free, query-free, fragment-free `.tgz` HTTPS URLs on `registry.npmjs.org` are accepted. Different integrity values produce different keys; floating versions never replace lockfile entries.

Every cache read recalculates SHA-512 and repeats gzip/tar, path, manifest-version, expanded-size, and file-count validation. Only fully validated public packages are cached. Hits still count toward the four-MiB compressed step budget. Private packages retain control-plane authorization and bypass this cache entirely.

Entries expire logically after seven days; R2 lifecycle handles eventual physical deletion. Missing/expired entries are misses. Cache failure or corruption falls back to the fixed registry URL; failed downloads or integrity errors still fail the build. R2 reads/writes and stream reads each have a three-second wait budget. Late writes can only store validated public bytes; late reads cancel their response body. Build cancellation aborts cache streams.

Concurrent misses can download/write identical content; there is no global lock or guaranteed hit rate. Existing [compiler limits](CI-BUILDS-v22.md) remain. No lifecycle scripts, Vite/Next, pnpm, or yarn support is added.

## Operations

Successful compile logs report cache enabled/disabled, hits, misses, writes, errors, and public-registry downloaded bytes. No credentials or signed object URLs appear. Without a binding, downloads work as before; older compiler responses remain compatible.

```sh
npx wrangler r2 bucket create onestorage-npm-cache
npx wrangler r2 bucket lifecycle add onestorage-npm-cache public-npm-seven-days npm-v1/ --expire-days 7
npm run deploy:build
npm run deploy
```

Skip creation for an existing bucket and preserve the expiry rule. Rename the bucket in `wrangler.build.jsonc` if desired, retaining binding `NPM_CACHE`. Keep the bucket private and compiler without a public entry point. This grants no main D1, Git R2, DO, or account credentials.

To clear downloads, delete only the dedicated bucket's `npm-v1/` objects; future builds download again. Do not delete the Git bucket. Remove `NPM_CACHE` and redeploy the compiler to disable caching. Monitor actual cost/latency; physical cleanup depends on lifecycle scheduling.

Run `npm run check` and `npm run test:npm-cache`. Remote tests require explicit opt-in, private credentials, and isolated projects. Do not modify/deploy during acceptance or cleanup. See [verification](VERIFICATION-v35.md), [R2 API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/), and [lifecycle rules](https://developers.cloudflare.com/r2/buckets/object-lifecycles/).
