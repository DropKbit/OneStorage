import { HTTPException } from "hono/http-exception";

export type GitStage =
  | "metadata"
  | "object-read"
  | "object-write"
  | "object-verify"
  | "object-index"
  | "ref-publish";
const stages = new WeakMap<object, GitStage>();
/** Preserve the original exception and the innermost failed operation. */
export async function gitStage<T>(
  stage: GitStage,
  operation: () => Promise<T>,
) {
  try {
    return await operation();
  } catch (error) {
    if (error && typeof error === "object" && !stages.has(error))
      stages.set(error, stage);
    throw error;
  }
}
/** R2 documents a numeric suffix on binding error messages. */
export function r2Code(error: unknown): number | null {
  if (!(error instanceof Error)) return null;
  const match = error.message.match(/^(?:get|put): [\s\S]*\((\d{5,6})\)$/);
  return match ? Number(match[1]) : null;
}
export function gitFailureDetails(error: unknown) {
  const object = error && typeof error === "object" ? error : undefined;
  const stage = object ? stages.get(object) : undefined;
  const cause = error instanceof Error ? error : undefined;
  // Never log provider messages, headers, user paths, bodies, SQL or arbitrary error names.
  const name = [
    "Error",
    "TypeError",
    "RangeError",
    "SyntaxError",
    "AbortError",
  ].includes(cause?.name || "")
    ? cause!.name
    : "UnknownError";
  const flags = object as
    { retryable?: unknown; overloaded?: unknown; remote?: unknown } | undefined;
  const frames = (cause?.stack || "")
    .split("\n")
    .slice(1)
    .map((line) => line.match(/(?:index\.js|worker\.js):(\d+):(\d+)\)?$/))
    .filter((match) => match !== null)
    .slice(0, 5)
    .map((match) => `${match[1]}:${match[2]}`);
  return {
    stage: stage || "repository",
    name,
    r2Code: stage?.startsWith("object-") ? r2Code(error) : null,
    d1: cause?.message.startsWith("D1_") || false,
    retryable: flags?.retryable === true,
    overloaded: flags?.overloaded === true,
    remote: flags?.remote === true,
    frames,
  };
}
export function reportGitFailure(
  error: unknown,
  repoId: string,
  operation: "repository" | "receive-pack" | "gateway-receive",
) {
  const incident = crypto.randomUUID();
  console.error("Git operation failed", {
    incident,
    repoId: /^[0-9a-f-]{36}$/.test(repoId) ? repoId : null,
    operation,
    ...gitFailureDetails(error),
  });
  return incident;
}
/** Shared ObjectStore budget for idempotent R2 reads and conditional writes only. */
export class GitIO {
  retries = 0;
  constructor(
    private sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
    private observe: (detail: {
      stage: string;
      code: number;
      retry: number;
    }) => void = () => {},
  ) {}
  async run<T>(
    stage: "object-read" | "object-write",
    operation: () => Promise<T>,
  ): Promise<T> {
    return gitStage(stage, async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await operation();
        } catch (error) {
          const code = r2Code(error);
          if (
            error instanceof HTTPException ||
            ![10001, 10043, 10054, 10058].includes(code || 0) ||
            attempt >= 2 ||
            this.retries >= 4
          )
            throw error;
          this.retries++;
          this.observe({ stage, code: code!, retry: this.retries });
          await this.sleep(
            (code === 10058 ? 1100 : 150) * 2 ** attempt +
              Math.floor(Math.random() * 100),
          );
        }
      }
    });
  }
}
