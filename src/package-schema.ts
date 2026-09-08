import { z } from "zod";
import { valid as semverValid, validRange } from "semver";
export const PACKAGE_LIMIT = {
  generic: 64 * 1024 * 1024,
  npm: 16 * 1024 * 1024,
  npmBody: 24 * 1024 * 1024,
  expanded: 64 * 1024 * 1024,
  entries: 20000,
  metadata: 65536,
  manifestTotal: 2 * 1024 * 1024,
  quota: 1024 * 1024 * 1024,
  files: 1000,
  versions: 512,
  npmVersions: 256,
  uploadMs: 90000,
  reservationMs: 600000,
  gcRetentionMs: 86400000,
} as const;
export const packageName = z
  .string()
  .max(214)
  .regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/);
export const genericPart = z
  .string()
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/);
export const npmFile = z
  .string()
  .max(350)
  .regex(/^[a-z0-9][a-zA-Z0-9._+-]*\.tgz$/);
export const npmVersion = z
  .string()
  .max(128)
  .refine((v) => semverValid(v) === v, "Canonical npm semver required");
export const npmTag = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z][a-zA-Z0-9._-]*$/)
  .refine((v) => !validRange(v), "Tag must not be a semver range");
export const genericSpec = z.object({
  kind: z.literal("generic"),
  name: genericPart,
  version: genericPart,
  filename: genericPart,
  size: z.number().int().min(1).max(PACKAGE_LIMIT.generic),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export interface PackageSpec {
  kind: "generic" | "npm";
  name: string;
  version: string;
  filename: string;
  size: number;
  sha256: string;
  sha512?: string;
  sha1?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
}
