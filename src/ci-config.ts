import { variableKey, jobEnvironment } from "./ci-variable-schema";
import { z } from "zod";
import { branch } from "./security";
import { cloudStep, deployConfig } from "./cloud-ci";
export const filePath = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (s) =>
      !s.startsWith("/") &&
      !s.split("/").some((x) => x === ".." || x === "." || !x) &&
      !s.includes("\\") &&
      !/[\x00-\x1f]/.test(s),
    "Invalid relative path",
  );
export const executionSchema = z
  .object({
    name: z.string().trim().min(1).max(80).default("Build and deploy"),
    runner: z.enum(["worker", "external"]),
    variables: z
      .array(variableKey)
      .max(30)
      .refine((v) => new Set(v).size === v.length, "Duplicate variable key")
      .optional(),
    environment: jobEnvironment.optional(),
    branches: z.array(branch).min(1).max(20).default(["main"]),
    timeout_seconds: z.number().int().min(10).max(3600).default(900),
    steps: z
      .array(
        z.discriminatedUnion("type", [
          cloudStep,
          z.object({
            type: z.literal("run"),
            name: z.string().min(1).max(80),
            command: z.string().min(1).max(10000),
          }),
          z.object({
            type: z.literal("file"),
            path: filePath,
            format: z.enum(["exists", "json"]).default("exists"),
          }),
          z.object({
            type: z.literal("http"),
            url: z.string().url().max(2000),
            status: z.number().int().min(200).max(599).default(200),
          }),
        ]),
      )
      .min(1)
      .max(20),
    deploy: deployConfig.optional(),
    artifacts: z.array(filePath).max(10).default([]),
  })
  .strict()
  .superRefine((p, c) => {
    if (p.environment && p.deploy && p.environment !== p.deploy.environment)
      c.addIssue({
        code: "custom",
        message: "Job and deployment environment must match",
      });
    if (
      p.runner === "external" &&
      (p.deploy || p.steps.some((s) => s.type === "javascript"))
    )
      c.addIssue({
        code: "custom",
        message:
          "Cloud JavaScript and hosted deployments require Worker runner",
      });
    if (p.runner === "worker" && p.steps.some((s) => s.type === "run"))
      c.addIssue({
        code: "custom",
        message: "Shell commands require an external runner",
      });
    if (p.runner === "worker" && (p.artifacts.length || p.steps.length > 10))
      c.addIssue({
        code: "custom",
        message:
          "Worker pipelines support at most 10 checks and no file artifacts",
      });
  });

const jobId = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/);
export const workflowSchema = z
  .object({
    name: z.string().trim().min(1).max(80).default("Workflow"),
    runner: z.literal("workflow"),
    branches: z.array(branch).min(1).max(20).default(["main"]),
    timeout_seconds: z.number().int().min(10).max(3600).default(900),
    jobs: z
      .array(
        z
          .object({
            id: jobId,
            needs: z.array(jobId).max(10).default([]),
            pipeline: executionSchema,
          })
          .strict(),
      )
      .min(1)
      .max(10),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set(value.jobs.map((j) => j.id));
    if (ids.size !== value.jobs.length)
      context.addIssue({
        code: "custom",
        message: "Duplicate workflow job ID",
      });
    const done = new Set<string>();
    for (const job of value.jobs) {
      if (
        new Set(job.needs).size !== job.needs.length ||
        job.needs.some((id) => !ids.has(id) || id === job.id)
      )
        context.addIssue({
          code: "custom",
          message: "Invalid workflow dependency: " + job.id,
        });
    }
    for (let pass = 0; pass < value.jobs.length; pass++)
      for (const job of value.jobs)
        if (job.needs.every((id) => done.has(id))) done.add(job.id);
    if (done.size !== ids.size)
      context.addIssue({
        code: "custom",
        message: "Workflow dependency cycle",
      });
  });
export const pipelineSchema = z.union([executionSchema, workflowSchema]);
export type Pipeline = z.infer<typeof pipelineSchema>;
export type Workflow = z.infer<typeof workflowSchema>;
