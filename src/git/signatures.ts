import { createMessage, readKey, readSignature, verify } from "openpgp";
import { bytes, concat, text, sameBytes, GitObject, toHex } from "./objects";
import { fail } from "../security";
import { base64 } from "../base64";
export { base64 } from "../base64";
export function unbase64(value: string) {
  if (
    value.length > 24 * 1024 * 1024 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    fail(400, "Invalid base64");
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
const b64url = (v: Uint8Array) =>
  base64(v).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
class WireReader {
  pos = 0;
  constructor(readonly data: Uint8Array) {}
  uint() {
    if (this.pos + 4 > this.data.length) fail(400, "Truncated SSH field");
    const v = new DataView(
      this.data.buffer,
      this.data.byteOffset + this.pos,
      4,
    ).getUint32(0);
    this.pos += 4;
    return v;
  }
  field() {
    const n = this.uint();
    if (n > 65536 || this.pos + n > this.data.length)
      fail(400, "Invalid SSH field length");
    const v = this.data.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
  end() {
    if (this.pos !== this.data.length) fail(400, "Trailing SSH signature data");
  }
}
function field(v: Uint8Array) {
  const size = new Uint8Array(4);
  new DataView(size.buffer).setUint32(0, v.length);
  return concat(size, v);
}
function unsigned(v: Uint8Array) {
  while (v.length > 1 && v[0] === 0) v = v.subarray(1);
  return v;
}
function sshKey(value: string) {
  const parts = value.trim().split(/\s+/);
  if (parts.length < 2) fail(400, "Invalid SSH public key");
  const raw = unbase64(parts[1]),
    r = new WireReader(raw),
    kind = text(r.field());
  if (
    kind !== parts[0] ||
    ![
      "ssh-ed25519",
      "ssh-rsa",
      "ecdsa-sha2-nistp256",
      "ecdsa-sha2-nistp384",
      "ecdsa-sha2-nistp521",
    ].includes(kind)
  )
    fail(400, "Unsupported SSH key");
  return { raw, r, kind };
}
export async function signingKeyInfo(value: string) {
  if (value.length > 65536) fail(413, "Signing key too large");
  if (value.includes("PRIVATE KEY"))
    fail(400, "Only public signing keys may be registered");
  if (value.startsWith("-----BEGIN PGP PUBLIC KEY BLOCK-----")) {
    const k = await readKey({ armoredKey: value });
    if (k.isPrivate()) fail(400, "Private keys are not accepted");
    await k.verifyPrimaryKey();
    return { format: "openpgp", fingerprint: k.getFingerprint() };
  }
  const k = sshKey(value);
  if (k.kind === "ssh-ed25519") {
    if (k.r.field().length !== 32) fail(400, "Invalid Ed25519 key");
  } else if (k.kind === "ssh-rsa") {
    k.r.field();
    if (unsigned(k.r.field()).length < 256)
      fail(400, "RSA signing keys must be at least 2048 bits");
  } else {
    const curve = text(k.r.field());
    if ("ecdsa-sha2-" + curve !== k.kind) fail(400, "SSH curve mismatch");
    const q = k.r.field();
    if (q[0] !== 4) fail(400, "Expected uncompressed EC point");
  }
  k.r.end();
  return {
    format: "ssh",
    fingerprint:
      "SHA256:" +
      base64(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", k.raw as BufferSource),
        ),
      ).replace(/=+$/, ""),
  };
}
/** Preserve the original byte payload, including non-ASCII messages and multiline headers. */
export function commitSignature(o: GitObject) {
  const lines: { start: number; end: number; value: string }[] = [];
  let start = 0;
  while (start < o.data.length) {
    const end = o.data.indexOf(10, start);
    if (end < 0) break;
    const value = text(o.data.subarray(start, end));
    lines.push({ start, end: end + 1, value });
    start = end + 1;
    if (!value) break;
  }
  const at = lines.findIndex((l) => l.value.startsWith("gpgsig "));
  if (at < 0) return { payload: o.data, signature: undefined };
  let stop = at + 1;
  const signature = [lines[at].value.slice(7)];
  while (stop < lines.length && lines[stop].value.startsWith(" ")) {
    signature.push(lines[stop].value.slice(1));
    stop++;
  }
  if (lines.slice(stop).some((l) => l.value.startsWith("gpgsig ")))
    fail(400, "Multiple commit signatures are unsupported");
  return {
    payload: concat(
      o.data.subarray(0, lines[at].start),
      o.data.subarray(lines[stop - 1].end),
    ),
    signature: signature.join("\n") + "\n",
  };
}
async function verifySSH(
  payload: Uint8Array,
  signature: string,
  publicKey: string,
) {
  const armored = signature
    .trim()
    .match(
      /^-----BEGIN SSH SIGNATURE-----\s+([A-Za-z0-9+/=\s]+)\s+-----END SSH SIGNATURE-----$/,
    );
  if (!armored) return false;
  const data = unbase64(armored[1].replace(/\s/g, ""));
  if (text(data.subarray(0, 6)) !== "SSHSIG") return false;
  const r = new WireReader(data);
  r.pos = 6;
  if (r.uint() !== 1) return false;
  const pub = r.field(),
    namespace = r.field(),
    reserved = r.field(),
    hashAlgorithm = r.field(),
    sig = r.field();
  r.end();
  const expected = sshKey(publicKey);
  if (
    !sameBytes(pub, expected.raw) ||
    text(namespace) !== "git" ||
    !["sha256", "sha512"].includes(text(hashAlgorithm))
  )
    return false;
  const hash = text(hashAlgorithm) === "sha256" ? "SHA-256" : "SHA-512",
    digest = new Uint8Array(
      await crypto.subtle.digest(hash, payload as BufferSource),
    ),
    signed = concat(
      bytes("SSHSIG"),
      field(namespace),
      field(reserved),
      field(hashAlgorithm),
      field(digest),
    );
  const sr = new WireReader(sig),
    algorithm = text(sr.field());
  let value = sr.field();
  sr.end();
  let key: CryptoKey, params: AlgorithmIdentifier | EcdsaParams;
  if (expected.kind === "ssh-ed25519") {
    if (algorithm !== expected.kind) return false;
    key = await crypto.subtle.importKey(
      "raw",
      expected.r.field() as BufferSource,
      "Ed25519",
      false,
      ["verify"],
    );
    params = "Ed25519";
  } else if (expected.kind === "ssh-rsa") {
    if (!["rsa-sha2-256", "rsa-sha2-512"].includes(algorithm)) return false;
    const e = unsigned(expected.r.field()),
      n = unsigned(expected.r.field());
    if (n.length < 256) return false;
    key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", e: b64url(e), n: b64url(n), ext: true },
      {
        name: "RSASSA-PKCS1-v1_5",
        hash: algorithm === "rsa-sha2-256" ? "SHA-256" : "SHA-512",
      },
      false,
      ["verify"],
    );
    params = "RSASSA-PKCS1-v1_5";
  } else {
    if (algorithm !== expected.kind) return false;
    const curve = text(expected.r.field()),
      info: Record<string, [string, string, number]> = {
        nistp256: ["P-256", "SHA-256", 32],
        nistp384: ["P-384", "SHA-384", 48],
        nistp521: ["P-521", "SHA-512", 66],
      };
    const conf = info[curve];
    if (!conf) return false;
    key = await crypto.subtle.importKey(
      "raw",
      expected.r.field() as BufferSource,
      { name: "ECDSA", namedCurve: conf[0] },
      false,
      ["verify"],
    );
    const ints = new WireReader(value),
      a = unsigned(ints.field()),
      b = unsigned(ints.field());
    ints.end();
    if (a.length > conf[2] || b.length > conf[2]) return false;
    value = new Uint8Array(conf[2] * 2);
    value.set(a, conf[2] - a.length);
    value.set(b, conf[2] * 2 - b.length);
    params = { name: "ECDSA", hash: conf[1] };
  }
  expected.r.end();
  return crypto.subtle.verify(
    params,
    key,
    value as BufferSource,
    signed as BufferSource,
  );
}
export async function verifyCommitSignature(
  o: GitObject,
  keys: { format: string; public_key: string }[],
) {
  const { signature, payload } = commitSignature(o);
  if (!signature) return false;
  for (const key of keys) {
    try {
      if (
        key.format === "ssh" &&
        signature.startsWith("-----BEGIN SSH SIGNATURE-----")
      ) {
        if (await verifySSH(payload, signature, key.public_key)) return true;
      } else if (
        key.format === "openpgp" &&
        signature.startsWith("-----BEGIN PGP SIGNATURE-----")
      ) {
        const k = await readKey({ armoredKey: key.public_key });
        const result = await verify({
          message: await createMessage({ binary: payload }),
          signature: await readSignature({ armoredSignature: signature }),
          verificationKeys: k,
        });
        for (const s of result.signatures) {
          await s.verified;
          return true;
        }
      }
    } catch {
      /* Unknown, revoked, malformed and invalid signatures fail closed. */
    }
  }
  return false;
}
