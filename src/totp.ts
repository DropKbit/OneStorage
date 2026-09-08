import { equal } from "./security";
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32(data: Uint8Array) {
  let bits = 0,
    value = 0,
    out = "";
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += alphabet[(value >>> bits) & 31];
    }
  }
  if (bits) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}
export function decodeBase32(input: string) {
  if (!/^[A-Z2-7]+$/.test(input)) throw Error("Invalid TOTP secret");
  let bits = 0,
    value = 0;
  const bytes = [];
  for (const c of input) {
    value = (value << 5) | alphabet.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 255);
    }
  }
  return new Uint8Array(bytes);
}
export async function hotp(secret: string, counter: number, digits = 6) {
  const key = await crypto.subtle.importKey(
    "raw",
    decodeBase32(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const input = new ArrayBuffer(8);
  new DataView(input).setBigUint64(0, BigInt(counter));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, input)),
    offset = mac[mac.length - 1] & 15,
    value = new DataView(mac.buffer).getUint32(offset) & 0x7fffffff;
  return String(value % 10 ** digits).padStart(digits, "0");
}
export async function totpCounter(
  secret: string,
  code: string,
  lastCounter = -1,
  now = Date.now(),
) {
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(now / 30000);
  for (const delta of [0, -1, 1]) {
    const counter = current + delta;
    if (
      counter >= 0 &&
      counter > lastCounter &&
      equal(await hotp(secret, counter), code)
    )
      return counter;
  }
  return null;
}
