# tsconfig in Workers builds

[简体中文](../CI-TSCONFIG-v36.md) · **English**

`build` reads selected `tsconfig.json`, or the file named by `tsconfig`. It supports JSONC comments/trailing commas, relative `extends` (including parent arrays), `baseUrl`, `paths`, and selected transpilation options. Configuration/source must belong to the pinned Git commit and selected `sources`; no deployment-machine files or external configuration downloads are read.

```json
{
  "runner": "worker",
  "steps": [
    {
      "type": "build",
      "entry": "src/index.tsx",
      "sources": [
        "src",
        "config",
        "tsconfig.json",
        "package.json",
        "package-lock.json"
      ],
      "tsconfig": "tsconfig.json",
      "outfile": "dist/index.js"
    }
  ]
}
```

For a root configuration extending `./config/base.json`, the parent can contain:

```json
{
  "compilerOptions": {
    "baseUrl": "..",
    "paths": { "@app/*": ["src/*"] },
    "jsx": "react-jsx",
    "jsxImportSource": "preact"
  }
}
```

`@app/label.js` can resolve to `src/label.ts`; `.mjs`→`.mts` and `.cjs`→`.cts` source substitutions also work. Exact aliases take precedence, otherwise the longest wildcard prefix wins, trying targets in order, then `baseUrl`, then existing lockfile resolution. Project aliases do not alter dependency-internal resolution or bypass the lockfile into `node_modules`.

Later parents override earlier ones; the child overrides parents. Child `paths` replaces the inherited mapping entirely. Relative `baseUrl` is relative to its defining configuration; without it, `paths` targets are relative to the mapping's defining directory. Escaping the source root, external URLs, package-based inheritance, missing files, cycles, and budget excess fail. Limits: 64 KiB/config, 16 distinct configurations, eight inheritance levels, 128 aliases, 16 targets/alias, one wildcard.

Runtime options passed to esbuild: `alwaysStrict`, `strict`, `experimentalDecorators`, `useDefineForClassFields`, `verbatimModuleSyntax`, `preserveValueImports`, `importsNotUsedAsValues`, `jsxFactory`, `jsxFragmentFactory`, `jsxImportSource`, and `jsx` values `react`, `react-jsx`, `react-jsxdev`. Explicit step `jsx`/`jsx_import_source` wins. Without either, automatic/react remains the default. Remove explicit JSX fields from older pipelines to use corresponding tsconfig settings.

This remains WASM transpilation/bundling, not tsc type checking. Output remains ES2022/ESM regardless of `target`, `module`, or type-checking options. `include`/`exclude`/`files` cannot change selected sources. Project-reference build graphs, package `extends`, Vite/Next configuration, and lifecycle scripts are unsupported. Source/dependency/artifact budgets, private-package authorization, and public R2 caching remain unchanged.

## Historical verification

v0.36 passed type checking and 363 tests, including real DO regression, inheritance/path isolation, cycle/escape/missing rejection, and parsing repeated parents once. Initial local real-Worker builds passed 24 checks/49 API requests; initial production 24/71. After correcting false rejection of ordinary directory names containing `node_modules`, final compiler `dc3c65bc-9566-4e88-8117-60222ab9e124` passed 24/88, including a further alias import from that directory. JSX inheritance, extension substitution, release/rollback, static JS/CSS, SRI rejection, native-module rejection, and cyclic configuration failure passed. Local/production fixtures were removed; D1 confirmed zero associated spaces, projects, runs, versions, and code-index records. No migration; schema remained 0027.

Run `npm run check` and `npm run test:tsconfig`; remote tests use explicit authorization and isolated projects. References: [TypeScript paths](https://www.typescriptlang.org/docs/handbook/modules/reference.html#paths), [esbuild tsconfigRaw](https://esbuild.github.io/api/#tsconfig-raw), [JSONC parser](https://github.com/microsoft/node-jsonc-parser).
