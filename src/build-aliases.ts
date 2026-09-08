import { normalizePath } from "./build-path";
import { buildPath } from "./ci-build-schema";
import type { BuildTSConfig } from "./build-tsconfig";
export function configRelative(root: string, path: string) {
  if (path.startsWith("/") || /[:\\\x00-\x1f]/.test(path))
    throw Error("Invalid tsconfig path");
  const result = normalizePath((root ? root + "/" : "") + path);
  if (result && !buildPath.safeParse(result).success)
    throw Error("Invalid tsconfig path");
  return result;
}
export function tsconfigCandidates(
  config: BuildTSConfig | undefined,
  specifier: string,
) {
  if (!config) return [];
  const paths = config.paths || {},
    result: string[] = [];
  let key = Object.hasOwn(paths, specifier) ? specifier : undefined,
    capture = "";
  if (!key) {
    let prefixLength = -1;
    for (const pattern of Object.keys(paths)) {
      const star = pattern.indexOf("*");
      if (star < 0) continue;
      const prefix = pattern.slice(0, star),
        suffix = pattern.slice(star + 1);
      if (
        specifier.length >= prefix.length + suffix.length &&
        specifier.startsWith(prefix) &&
        specifier.endsWith(suffix) &&
        prefix.length > prefixLength
      ) {
        key = pattern;
        capture = specifier.slice(
          prefix.length,
          specifier.length - suffix.length,
        );
        prefixLength = prefix.length;
      }
    }
  }
  if (key)
    for (const target of paths[key])
      result.push(
        configRelative(
          config.baseUrl ?? config.pathsRoot ?? "",
          target.replace("*", capture),
        ),
      );
  if (config.baseUrl !== undefined)
    result.push(configRelative(config.baseUrl, specifier));
  return result;
}
