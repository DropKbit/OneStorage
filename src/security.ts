import { HTTPException } from "hono/http-exception";
import { z } from "zod";
export const slug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,47}$/)
  .refine(
    (s) =>
      ![
        "api",
        "assets",
        "auth",
        "admin",
        "health",
        "new",
        "settings",
        "spaces",
        "login",
        "mcp",
        "webhooks",
      ].includes(s),
    "Reserved name",
  );
export const repoName = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (value) =>
      value.split("/").length <= 5 &&
      value.split("/").every((part) => slug.safeParse(part).success),
    "Invalid repository name or group path",
  );
export const branch = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (s) =>
      !s.startsWith("-") &&
      !s.startsWith("/") &&
      !s.endsWith("/") &&
      !/[\s~^:?*\[\\\x00-\x1f\x7f]/.test(s) &&
      !s.includes("..") &&
      !s.includes("@{") &&
      !s.includes("//") &&
      s
        .split("/")
        .every(
          (p) => !p.startsWith(".") && !p.endsWith(".lock") && !p.endsWith("."),
        ),
    "Invalid branch",
  );
export const sha = z.string().regex(/^[0-9a-f]{40}$/);
export function fail(
  status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 503,
  message: string,
): never {
  throw new HTTPException(status, { message });
}
export function hex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function digest(value: string | Uint8Array) {
  return hex(
    await crypto.subtle.digest(
      "SHA-256",
      typeof value === "string"
        ? new TextEncoder().encode(value)
        : (value as BufferSource),
    ),
  );
}
export function randomToken() {
  return "os_" + hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
}
export async function passwordHash(
  password: string,
  salt = hex(crypto.getRandomValues(new Uint8Array(16)).buffer),
) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const hash = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: new TextEncoder().encode(salt),
      iterations: 100000,
      hash: "SHA-256",
    },
    key,
    256,
  );
  return `pbkdf2:100000:${salt}:${hex(hash)}`;
}
export function equal(a: string, b: string) {
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    mismatch |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return mismatch === 0;
}
export async function verifyPassword(password: string, stored: string) {
  return equal(await passwordHash(password, stored.split(":")[2]), stored);
}
export async function boundedBody(
  request: Request,
  max: number,
): Promise<Uint8Array> {
  if (Number(request.headers.get("content-length") || 0) > max)
    fail(413, "Request too large");
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      fail(413, "Request too large");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let pos = 0;
  for (const chunk of chunks) {
    body.set(chunk, pos);
    pos += chunk.length;
  }
  return body;
}
