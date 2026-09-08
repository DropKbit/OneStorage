import test from "node:test";
import assert from "node:assert/strict";
import { loadBuildTSConfig, tsconfigCandidates } from "../src/build-tsconfig";
import { BuildFileSystem } from "../src/build-packages";
import { buildStep } from "../src/ci-build-schema";

test("JSONC inheritance keeps defining path roots, replaces paths maps and applies later parents", () => {
  const files = {
    "tsconfig.json":
      '// comment\n{"extends":["./config/base","./config/extra.json"],"compilerOptions":{"strict":true,},}',
    "config/base.json":
      '{"compilerOptions":{"paths":{"@/*":["../src/*"]},"useDefineForClassFields":false}}',
    "config/extra.json":
      '{"compilerOptions":{"jsx":"react-jsx","jsxImportSource":"preact"}}',
  };
  const c = loadBuildTSConfig(files)!;
  assert.deepEqual(tsconfigCandidates(c, "@/foo"), ["src/foo"]);
  assert.equal(c.options.strict, true);
  assert.equal(c.options.useDefineForClassFields, false);
  assert.equal(c.options.jsxImportSource, "preact");
  const override = loadBuildTSConfig({
    ...files,
    "tsconfig.json":
      '{"extends":"./config/base","compilerOptions":{"paths":{"exact":["src/main.ts"]}}}',
  });
  assert.deepEqual(tsconfigCandidates(override, "@/foo"), []);
  assert.deepEqual(tsconfigCandidates(override, "exact"), ["src/main.ts"]);
});

test("alias exact matches, longest prefixes, ordered targets and baseUrl resolve only selected source files", async () => {
  const files = {
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        paths: {
          "@/*": ["fallback/*"],
          "@/app/*": ["missing/*", "src/*"],
          "@/app/value.js": ["exact.ts"],
        },
      },
    }),
    "src/main.ts": "",
    "src/label.ts": "export const label=1",
    "exact.ts": "",
    "fallback/value.ts": "",
    "local.ts": "",
    "preact.ts": "",
  };
  const c = loadBuildTSConfig(files),
    fs = new BuildFileSystem(
      files,
      "worker",
      undefined,
      undefined,
      {},
      undefined,
      c,
    );
  assert.deepEqual(tsconfigCandidates(c, "@/app/label.js"), [
    "missing/label.js",
    "src/label.js",
    "@/app/label.js",
  ]);
  assert.equal(
    await fs.resolve("@/app/label.js", "src/main.ts"),
    "src/label.ts",
  );
  assert.equal(await fs.resolve("@/app/value.js", "src/main.ts"), "exact.ts");
  assert.equal(await fs.resolve("local", "src/main.ts"), "local.ts");
  assert.equal(
    await fs.resolve("local", "src/my_node_modules/main.ts"),
    "local.ts",
  );
  assert.equal(await fs.resolve("preact", "src/main.ts"), "preact.ts");
  await assert.rejects(
    fs.resolve("preact", "node_modules/vendor/index.js"),
    /lockfile/,
  );
  await assert.rejects(fs.resolve("node:fs", "src/main.ts"), /Unsupported/);
  await assert.rejects(fs.resolve("@/app/../secret", "src/main.ts"));
});

test("missing, cyclic, external, malformed and escaping configurations fail explicitly", () => {
  assert.equal(loadBuildTSConfig({}), undefined);
  assert.throws(() => loadBuildTSConfig({}, "config.json"), /missing/);
  for (const text of [
    '{"extends":"./tsconfig.json"}',
    '{"extends":"@vendor/config"}',
    '{"extends":"../outside.json"}',
    '{"references":[]}',
    '{"compilerOptions":null}',
    '{"compilerOptions":{"paths":{"a":["../secret"]}}}',
    '{"compilerOptions":{"baseUrl":"node_modules"}}',
    '{"compilerOptions":{"paths":{"a**":["src/*"]}}}',
    '{"compilerOptions":{"jsx":"preserve"}}',
    "{broken",
  ])
    assert.throws(() => loadBuildTSConfig({ "tsconfig.json": text }), text);
  assert.throws(
    () => loadBuildTSConfig({ "tsconfig.json": " ".repeat(65537) }),
    /64 KiB/,
  );
  assert.throws(() =>
    buildStep.parse({
      type: "build",
      entry: "src/main.ts",
      tsconfig: "../config.json",
    }),
  );
});

test("bounded configuration graph and TS source extension substitution preserve modern imports", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 11; i++)
    files[`config${i}.json`] = JSON.stringify(
      i === 10 ? {} : { extends: `./config${i + 1}.json` },
    );
  assert.throws(() => loadBuildTSConfig(files, "config0.json"), /deep/);
  const fs = new BuildFileSystem(
    { "src/module.ts": "", "src/esm.mts": "", "src/common.cts": "" },
    "worker",
  );
  assert.equal(await fs.resolve("./module.js", "src/main.ts"), "src/module.ts");
  assert.equal(await fs.resolve("./esm.mjs", "src/main.ts"), "src/esm.mts");
  assert.equal(
    await fs.resolve("./common.cjs", "src/main.ts"),
    "src/common.cts",
  );
});

test("repeated diamond inheritance parses each selected config once", () => {
  const data: Record<string, string> = {};
  for (let i = 0; i < 8; i++)
    data[`config${i}.json`] = JSON.stringify(
      i === 7
        ? { compilerOptions: { strict: true } }
        : { extends: Array(8).fill(`./config${i + 1}.json`) },
    );
  let reads = 0;
  const files = new Proxy(data, {
    get(target, key) {
      if (typeof key === "string" && key in target) reads++;
      return Reflect.get(target, key);
    },
  });
  const c = loadBuildTSConfig(files, "config0.json")!;
  assert.equal(c.options.strict, true);
  assert.equal(c.files.length, 8);
  assert.equal(reads, 8);
});
