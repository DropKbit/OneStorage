/** Only public registry tarballs belong here; never source or authorized private packages. */
export interface PublicPackageCache {
  get(url: string, integrity: string): Promise<Response | null>;
  put(url: string, integrity: string, bytes: Uint8Array): Promise<void>;
}
export const NPM_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
export async function packageCacheKey(url: string, integrity: string) {
  const u = new URL(url);
  if (
    u.origin !== "https://registry.npmjs.org" ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    !u.pathname.endsWith(".tgz") ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)
  )
    throw Error("Invalid public package cache identity");
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(u.href + "\0" + integrity),
    ),
  );
  return (
    "npm-v1/" +
    Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("") +
    ".tgz"
  );
}
export class R2PublicPackageCache implements PublicPackageCache {
  constructor(
    private bucket: R2Bucket,
    private now = Date.now,
    private timeoutMs = 3000,
  ) {}
  private deadline<T>(
    pending: Promise<T>,
    late?: (value: T) => void,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      let expired = false;
      const timer = setTimeout(() => {
        expired = true;
        reject(Error("npm cache timeout"));
      }, this.timeoutMs);
      pending.then(
        (value) => {
          clearTimeout(timer);
          if (expired) late?.(value);
          else resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          if (!expired) reject(error);
        },
      );
    });
  }
  async get(url: string, integrity: string) {
    const object = await this.deadline(
      this.bucket.get(await packageCacheKey(url, integrity)),
      (object) => {
        void object?.body.cancel().catch(() => {});
      },
    );
    if (!object) return null;
    const expires = Number(object.customMetadata?.expires);
    if (
      !Number.isFinite(expires) ||
      expires <= this.now() ||
      expires > this.now() + NPM_CACHE_TTL
    ) {
      await object.body.cancel();
      return null;
    }
    return new Response(object.body, {
      headers: { "Content-Length": String(object.size) },
    });
  }
  async put(url: string, integrity: string, bytes: Uint8Array) {
    await this.deadline(
      this.bucket.put(await packageCacheKey(url, integrity), bytes, {
        customMetadata: { expires: String(this.now() + NPM_CACHE_TTL) },
        httpMetadata: { contentType: "application/gzip" },
      }),
    );
  }
}
