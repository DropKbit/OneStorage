import { base64 } from "./base64";
export function secretPatterns(values: string[]) {
  const patterns = new Set<string>();
  for (const value of values)
    if (value) {
      for (const v of [
        value,
        encodeURIComponent(value),
        JSON.stringify(value).slice(1, -1),
        base64(new TextEncoder().encode(value)),
      ])
        patterns.add(v);
    }
  return [...patterns].sort((a, b) => b.length - a.length);
}
/** Bounded mark buffer; no per-match arrays. Matches can cross HTTP log upload boundaries. */
export function redactChunks(chunks: string[], patterns: string[]) {
  const text = chunks.join("");
  if (!patterns.length) return chunks;
  const masked = new Uint8Array(text.length);
  for (const p of patterns)
    if (p) {
      let at = text.indexOf(p);
      while (at >= 0) {
        masked.fill(1, at, at + p.length);
        at = text.indexOf(p, at + p.length);
      }
    }
  let start = 0;
  return chunks.map((chunk) => {
    const end = start + chunk.length,
      parts: string[] = [];
    let at = start;
    while (at < end) {
      if (masked[at]) {
        if (at === 0 || !masked[at - 1]) parts.push("[MASKED]");
        while (at < end && masked[at]) at++;
      } else {
        const a = at;
        while (at < end && !masked[at]) at++;
        parts.push(text.slice(a, at));
      }
    }
    start = end;
    return parts.join("");
  });
}
export const redact = (content: string, patterns: string[]) =>
  redactChunks([content], patterns)[0];
