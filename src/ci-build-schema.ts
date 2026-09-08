import { z } from "zod";
import { variableKey } from "./ci-variable-schema";
export const buildPath = z
  .string()
  .min(1)
  .max(240)
  .regex(/^[a-zA-Z0-9_@.\-/]+$/)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !p
        .split("/")
        .some(
          (s) =>
            !s ||
            s === "." ||
            s === ".." ||
            s === "node_modules" ||
            s === ".git",
        ) &&
      !p.startsWith("__onestorage"),
  );
export const buildStep = z
  .object({
    type: z.literal("build"),
    private_registries: z
      .array(
        z
          .object({
            project_id: z.uuid(),
            token_variable: variableKey,
          })
          .strict(),
      )
      .max(8)
      .refine(
        (a) => new Set(a.map((r) => r.project_id)).size === a.length,
        "Duplicate registry project",
      )
      .optional(),
    entry: buildPath,
    sources: z
      .array(buildPath)
      .min(1)
      .max(32)
      .default(["src", "package.json", "package-lock.json"]),
    outfile: buildPath
      .refine((p) => p.endsWith(".js"))
      .default("dist/index.js"),
    platform: z.enum(["worker", "browser"]).default("worker"),
    minify: z.boolean().default(true),
    sourcemap: z.boolean().default(false),
    jsx: z.enum(["transform", "automatic"]).default("automatic"),
    jsx_import_source: z
      .string()
      .regex(/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/)
      .default("react"),
  })
  .strict();
export type BuildStep = z.infer<typeof buildStep>;
export const BUILD_LIMIT = {
  source: 4 * 1024 * 1024,
  files: 256,
  packages: 64,
  compressed: 4 * 1024 * 1024,
  expanded: 8 * 1024 * 1024,
  packageFiles: 10000,
  output: 2 * 1024 * 1024,
  request: 12 * 1024 * 1024,
};
export const buildRequest = z
  .object({
    step: buildStep,
    files: z.record(buildPath, z.string().max(1024 * 1024)),
    packages: z
      .record(z.string().url().max(2000), z.string().max(5592408))
      .default({}),
  })
  .strict();
