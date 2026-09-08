import { z } from "zod";
import { branch } from "./security";
export const variableKey = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]{0,79}$/)
  .refine(
    (k) =>
      !/^(ONESTORAGE_|GIT_|LD_|DYLD_|__)/.test(k) &&
      ![
        "HOME",
        "PATH",
        "SHELL",
        "ENV",
        "BASH_ENV",
        "IFS",
        "CDPATH",
        "SHELLOPTS",
        "NODE_OPTIONS",
        "CI",
      ].includes(k),
    "Reserved runner variable",
  );
export const jobEnvironment = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
export const variableSchema = z
  .object({
    key: variableKey,
    environment: z.union([z.literal("*"), jobEnvironment]).default("*"),
    value: z
      .string()
      .min(1)
      .max(8192)
      .refine((s) => !s.includes("\0"), "NUL is not allowed")
      .optional(),
    secret: z.boolean().default(true),
    protected: z.boolean().default(true),
    refs: z
      .array(z.union([z.literal("*"), branch]))
      .min(1)
      .max(20)
      .default(["main"]),
    enabled: z.boolean().default(true),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.secret && v.value && v.value.length < 8)
      c.addIssue({
        code: "custom",
        message: "Masked secrets require at least eight characters",
      });
  });

export const variableSelectionSchema = z.object({
  variables: z.array(variableKey).max(30).optional(),
  environment: jobEnvironment.optional(),
  deploy: z.object({ environment: jobEnvironment }).optional(),
});
