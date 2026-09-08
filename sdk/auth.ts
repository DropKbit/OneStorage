/** WebCrypto JWT signing and webhook verification. Private keys never leave the client. */
export type Scope = "git:read" | "git:write" | "repo:write" | "org:read";
export type RefPolicy = [
  string,
  ("no-push" | "no-force-push" | "verify-sig")[],
];
export type Algorithm = "ES256" | "ES384" | "ES512" | "RS256";
const encoder = new TextEncoder();
export function toBase64(data: Uint8Array) {
  let value = "";
  for (let i = 0; i < data.length; i += 8192)
    value += String.fromCharCode(...data.subarray(i, i + 8192));
  return btoa(value);
}
const url64 = (data: Uint8Array) =>
  toBase64(data).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
export interface Signer {
  issuer: string;
  key: string | CryptoKey;
  algorithm?: Algorithm;
  keyId?: string;
  subject?: string;
  ttl?: number;
  refs?: RefPolicy[];
}
export async function createToken(
  options: Signer & { repo?: string; scopes: Scope[] },
) {
  const alg = options.algorithm || "ES256",
    rsa = alg === "RS256",
    bits = alg.slice(2),
    hash = rsa ? "SHA-256" : alg === "ES512" ? "SHA-512" : "SHA-" + bits;
  const params = rsa
    ? { name: "RSASSA-PKCS1-v1_5", hash }
    : { name: "ECDSA", namedCurve: alg === "ES512" ? "P-521" : "P-" + bits };
  let key = options.key;
  if (typeof key === "string") {
    const raw = atob(key.replace(/-----[^-]+-----|\s/g, ""));
    key = await crypto.subtle.importKey(
      "pkcs8",
      Uint8Array.from(raw, (x) => x.charCodeAt(0)),
      params,
      false,
      ["sign"],
    );
  }
  const now = Math.floor(Date.now() / 1000),
    ttl = options.ttl || 3600;
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 365 * 86400)
    throw Error("Invalid JWT TTL");
  const header = {
      alg,
      typ: "JWT",
      ...(options.keyId ? { kid: options.keyId } : {}),
    },
    claims = {
      iss: options.issuer,
      sub: options.subject || "onestorage-sdk",
      iat: now,
      exp: now + ttl,
      scopes: options.scopes,
      ...(options.repo ? { repo: options.repo } : {}),
      ...(options.refs ? { refs: options.refs } : {}),
    };
  const value =
    url64(encoder.encode(JSON.stringify(header))) +
    "." +
    url64(encoder.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign(
    rsa ? { name: "RSASSA-PKCS1-v1_5" } : { name: "ECDSA", hash },
    key,
    encoder.encode(value),
  );
  return value + "." + url64(new Uint8Array(signature));
}
export async function validateWebhook(
  payload: string | Uint8Array,
  headers: Headers,
  secret: string,
  tolerance = 300,
) {
  const timestamp = headers.get("x-onestorage-timestamp") || "",
    signature = headers.get("x-onestorage-signature") || "";
  if (
    !/^\d+$/.test(timestamp) ||
    Math.abs(Date.now() / 1000 - Number(timestamp)) > tolerance ||
    !/^sha256=[0-9a-f]{64}$/.test(signature)
  )
    return { valid: false, event: null };
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const data = typeof payload === "string" ? encoder.encode(payload) : payload,
    prefix = encoder.encode(timestamp + "."),
    input = new Uint8Array(prefix.length + data.length);
  input.set(prefix);
  input.set(data, prefix.length);
  const sig = Uint8Array.from(signature.slice(7).match(/../g)!, (x) =>
    parseInt(x, 16),
  );
  const valid = await crypto.subtle.verify("HMAC", key, sig, input);
  return {
    valid,
    event: valid ? JSON.parse(new TextDecoder().decode(data)) : null,
  };
}
