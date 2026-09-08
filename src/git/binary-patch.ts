import { deflate } from "pako";
const alphabet =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~";
export function literalPatch(data: Uint8Array) {
  const zipped = deflate(data);
  let result = "literal " + data.length + "\n";
  for (let i = 0; i < zipped.length; i += 52) {
    const line = zipped.subarray(i, i + 52),
      n = line.length;
    result += String.fromCharCode(n <= 26 ? 64 + n : 70 + n);
    for (let j = 0; j < n; j += 4) {
      let v = 0;
      for (let k = 0; k < 4; k++) v = v * 256 + (line[j + k] || 0);
      const chars = Array(5);
      for (let k = 4; k >= 0; k--) {
        chars[k] = alphabet[v % 85];
        v = Math.floor(v / 85);
      }
      result += chars.join("");
    }
    result += "\n";
  }
  return result + "\n";
}
