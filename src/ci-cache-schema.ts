import { z } from "zod";
export const cachePath = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !p.includes("\\") &&
      !/[\x00-\x1f\x7f]/.test(p) &&
      p
        .split("/")
        .every(
          (s) => s && s !== "." && s !== ".." && s.toLowerCase() !== ".git",
        ),
    "Unsafe cache path",
  );
const key = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9_.-]+$/);
export const cacheSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
    key,
    key_files: z.array(cachePath).max(5).default([]),
    fallback_keys: z.array(key).max(3).default([]),
    paths: z.array(cachePath).min(1).max(10),
    scope: z.enum(["branch", "protected"]).default("branch"),
    policy: z.enum(["pull-push", "pull", "push"]).default("pull-push"),
  })
  .strict()
  .superRefine((v, c) => {
    if (
      new Set(v.paths).size !== v.paths.length ||
      v.paths.some((p, i) =>
        v.paths.some((q, j) => i !== j && p.startsWith(q + "/")),
      )
    )
      c.addIssue({ code: "custom", message: "Cache paths must not overlap" });
  });
export const cacheSelectionSchema = z.object({
  runner: z.enum(["worker", "external"]),
  caches: z.array(cacheSchema).max(4).optional(),
});
export type CacheSpec = z.infer<typeof cacheSchema>;
export const cacheFilesSchema = z.record(
  cachePath,
  z.object({ content: z.string(), binary: z.boolean().optional() }).strict(),
);
export const CACHE_LIMIT = 64 * 1024 * 1024;
export const CLOUD_CACHE_LIMIT = 4 * 1024 * 1024;
export const CACHE_QUOTA = 512 * 1024 * 1024;
export const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
export function cacheContains(spec: CacheSpec, path: string) {
  return spec.paths.some((p) => path === p || path.startsWith(p + "/"));
}
