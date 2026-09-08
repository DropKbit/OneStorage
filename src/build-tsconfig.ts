import { parse, type ParseError } from "jsonc-parser";
import { z } from "zod";
import { configRelative } from "./build-aliases";
export { tsconfigCandidates } from "./build-aliases";
import { buildPath } from "./ci-build-schema";

const runtimeOptions = z.object({
  alwaysStrict: z.boolean().optional(),
  strict: z.boolean().optional(),
  experimentalDecorators: z.boolean().optional(),
  useDefineForClassFields: z.boolean().optional(),
  verbatimModuleSyntax: z.boolean().optional(),
  preserveValueImports: z.boolean().optional(),
  importsNotUsedAsValues: z.enum(["remove", "preserve", "error"]).optional(),
  jsx: z.enum(["react", "react-jsx", "react-jsxdev"]).optional(),
  jsxFactory: z
    .string()
    .regex(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/)
    .optional(),
  jsxFragmentFactory: z
    .string()
    .regex(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/)
    .optional(),
  jsxImportSource: z
    .string()
    .regex(/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/)
    .optional(),
});
type Options = z.infer<typeof runtimeOptions>;
export interface BuildTSConfig {
  options: Options;
  baseUrl?: string;
  paths?: Record<string, string[]>;
  pathsRoot?: string;
  files: string[];
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
export function loadBuildTSConfig(
  files: Record<string, string>,
  selected?: string,
): BuildTSConfig | undefined {
  const entry =
    selected ||
    (Object.hasOwn(files, "tsconfig.json") ? "tsconfig.json" : undefined);
  if (!entry) return;
  const memo = new Map<string, BuildTSConfig>();
  const active = new Set<string>(),
    seen = new Set<string>();
  const visit = (path: string, depth: number): BuildTSConfig => {
    if (!buildPath.safeParse(path).success || depth > 8 || active.has(path))
      throw Error("Invalid, cyclic or too deep tsconfig inheritance");
    if (memo.has(path)) return memo.get(path)!;
    seen.add(path);
    if (seen.size > 16) throw Error("Too many tsconfig files");
    if (!Object.hasOwn(files, path))
      throw Error("tsconfig missing from build sources: " + path);
    const source = files[path];
    if (new TextEncoder().encode(source).length > 65536)
      throw Error("tsconfig exceeds 64 KiB");
    const errors: ParseError[] = [],
      data = parse(source.replace(/^\uFEFF/, ""), errors, {
        allowTrailingComma: true,
      });
    if (errors.length || !object(data))
      throw Error("Invalid tsconfig JSONC: " + path);
    if (data.references !== undefined)
      throw Error("tsconfig project references are unsupported");
    const options =
      data.compilerOptions === undefined ? {} : data.compilerOptions;
    if (!object(options)) throw Error("Invalid tsconfig compilerOptions");
    const root = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    let result: BuildTSConfig = { options: {}, files: [] };
    active.add(path);
    const parents =
      data.extends === undefined
        ? []
        : Array.isArray(data.extends)
          ? data.extends
          : [data.extends];
    if (parents.length > 8) throw Error("Too many tsconfig parents");
    for (const parent of parents) {
      if (typeof parent !== "string" || !/^\.\.?\//.test(parent))
        throw Error("Only relative local tsconfig extends are supported");
      let target = configRelative(root, parent);
      if (!Object.hasOwn(files, target) && !target.endsWith(".json"))
        target += ".json";
      const inherited = visit(target, depth + 1);
      result = {
        ...result,
        ...inherited,
        options: { ...result.options, ...inherited.options },
      };
    }
    result.options = { ...result.options, ...runtimeOptions.parse(options) };
    if (options.baseUrl !== undefined) {
      if (typeof options.baseUrl !== "string")
        throw Error("Invalid tsconfig baseUrl");
      result.baseUrl = configRelative(root, options.baseUrl);
    }
    if (options.paths !== undefined) {
      if (!object(options.paths) || Object.keys(options.paths).length > 128)
        throw Error("Invalid tsconfig paths");
      result.paths = Object.create(null);
      result.pathsRoot = root;
      for (const [key, targets] of Object.entries(options.paths)) {
        if (
          !key ||
          key.length > 240 ||
          key.startsWith("/") ||
          /[:\\\x00-\x1f]/.test(key) ||
          key.split("*").length > 2 ||
          key.split("/").some((p) => p === "." || p === "..") ||
          !Array.isArray(targets) ||
          !targets.length ||
          targets.length > 16
        )
          throw Error("Invalid tsconfig alias");
        result.paths![key] = targets.map((target) => {
          if (
            typeof target !== "string" ||
            target.length > 240 ||
            target.split("*").length > 2
          )
            throw Error("Invalid tsconfig alias target");
          // Validate in its defining context, then validate again after inherited baseUrl resolution.
          configRelative(
            result.baseUrl ?? root,
            target.replace("*", "wildcard"),
          );
          return target;
        });
      }
    }
    active.delete(path);
    memo.set(path, result);
    return result;
  };
  const config = visit(entry, 0);
  config.files = [...seen];
  for (const targets of Object.values(config.paths || {}))
    for (const target of targets)
      configRelative(
        config.baseUrl ?? config.pathsRoot ?? "",
        target.replace("*", "wildcard"),
      );
  return config;
}
