import type { Env, Repo } from "./types";
import { upstreamClient } from "./sync";
import { fail, boundedBody, digest } from "./security";
export function githubLFS(repo: Repo) {
  if (!repo.base_repo) return false;
  const base = JSON.parse(repo.base_repo);
  return base.provider === "github" && base.mode === "app";
}
export function lfsAction(action: any) {
  let url: URL;
  try {
    url = new URL(action.href);
  } catch {
    fail(503, "Invalid upstream LFS action");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !(
      url.hostname === "github.com" ||
      url.hostname.endsWith(".githubusercontent.com") ||
      url.hostname === "github-cloud.s3.amazonaws.com" ||
      /^github-[a-z0-9-]+\.s3(?:\.[a-z0-9-]+)?\.amazonaws\.com$/.test(
        url.hostname,
      )
    )
  )
    fail(503, "Unapproved GitHub LFS action host");
  const headers = new Headers();
  for (const [key, value] of Object.entries(action.header || {})) {
    if (
      typeof value !== "string" ||
      ["host", "cookie", "content-length", "transfer-encoding"].includes(
        key.toLowerCase(),
      )
    )
      fail(503, "Invalid upstream LFS header");
    headers.set(key, value);
  }
  return { url: url.href, headers };
}
export async function lfsBatch(
  env: Env,
  repo: Repo,
  operation: "upload" | "download",
  oid: string,
  size: number,
  send: typeof fetch = fetch,
) {
  const client = await upstreamClient(env, repo, send);
  const response = await send(client.url + "/info/lfs/objects/batch", {
    method: "POST",
    headers: {
      ...Object.fromEntries(new Headers(client.headers)),
      Accept: "application/vnd.git-lfs+json",
      "Content-Type": "application/vnd.git-lfs+json",
    },
    body: JSON.stringify({
      operation,
      transfers: ["basic"],
      objects: [{ oid, size }],
    }),
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    fail(503, "GitHub LFS negotiation failed");
  }
  let data;
  try {
    data = JSON.parse(
      new TextDecoder().decode(
        await boundedBody(response as unknown as Request, 1024 * 1024),
      ),
    );
  } catch {
    fail(503, "Invalid GitHub LFS response");
  }
  const object = data.objects?.find((o: any) => o.oid === oid);
  if (!object || object.error)
    fail(
      object?.error?.code === 404 ? 404 : 503,
      "GitHub LFS object unavailable",
    );
  if (object.size !== size || (data.transfer && data.transfer !== "basic"))
    fail(503, "GitHub LFS transfer mismatch");
  return object.actions || {};
}
export async function uploadLFS(
  env: Env,
  repo: Repo,
  oid: string,
  data: Uint8Array,
  send: typeof fetch = fetch,
) {
  const actions = await lfsBatch(env, repo, "upload", oid, data.length, send);
  if (actions.upload) {
    const { url, headers } = lfsAction(actions.upload);
    headers.set("content-type", "application/octet-stream");
    const response = await send(url, {
      method: "PUT",
      headers,
      body: data as BodyInit,
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
    });
    await response.body?.cancel();
    if (!response.ok) fail(503, "GitHub LFS upload failed");
  }
  if (actions.verify) {
    const { url, headers } = lfsAction(actions.verify);
    headers.set("content-type", "application/vnd.git-lfs+json");
    const response = await send(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ oid, size: data.length }),
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    await response.body?.cancel();
    if (!response.ok) fail(503, "GitHub LFS verification failed");
  }
}
export async function downloadLFS(
  env: Env,
  repo: Repo,
  oid: string,
  size: number,
  send: typeof fetch = fetch,
) {
  const actions = await lfsBatch(env, repo, "download", oid, size, send);
  if (!actions.download) fail(404, "GitHub LFS object missing");
  const { url, headers } = lfsAction(actions.download);
  const response = await send(url, {
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    fail(503, "GitHub LFS download failed");
  }
  const data = await boundedBody(
    response as unknown as Request,
    16 * 1024 * 1024,
  );
  if (data.length !== size || (await digest(data)) !== oid)
    fail(503, "GitHub LFS object integrity check failed");
  return data;
}
