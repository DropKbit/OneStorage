import { RE2JS } from "re2js";
import { fail } from "../security";
/** Bounded -L-style selectors; RE2 semantics prevent pathological regex backtracking. */
export function blameRanges(
  lines: { line: number; content: string }[],
  ranges: string[],
) {
  if (ranges.length > 16) fail(400, "At most 16 blame ranges");
  const indexes = new Set<number>();
  let previous = 0;
  const regex = (pattern: string) => {
    if (pattern.length > 200) fail(400, "Blame regex exceeds 200 characters");
    try {
      return RE2JS.compile(pattern);
    } catch {
      fail(400, "Invalid blame regex");
    }
  };
  const anchor = (value: string, start: number, fallback: number) => {
    if (!value) return fallback;
    if (/^\d+$/.test(value)) return Number(value);
    if (value.startsWith("/") && value.endsWith("/")) {
      const re = regex(value.slice(1, -1));
      const i = lines.findIndex(
        (l, i) => i >= start && re.matcher(l.content).find(),
      );
      if (i < 0) fail(400, "Blame range anchor not found");
      return i + 1;
    }
    fail(400, "Invalid blame range anchor");
  };
  for (const spec of ranges) {
    if (typeof spec !== "string" || !spec || spec.length > 256)
      fail(400, "Invalid blame range");
    let start: number, end: number;
    if (spec.startsWith(":")) {
      const re = regex(spec.slice(1));
      const declaration =
        /^\s*(?:(?:export|async|pub|public|private|static)\s+)*(?:def\s|func\s|fn\s|function\s|[\w:*<>]+\s+[\w:*<>]+\s*\()/;
      const at = lines.findIndex(
        (l, i) =>
          i >= previous &&
          declaration.test(l.content) &&
          re.matcher(l.content).find(),
      );
      if (at < 0) fail(400, "Blame function not found");
      start = at + 1;
      const next = lines.findIndex(
        (l, i) => i > at && declaration.test(l.content),
      );
      end = next < 0 ? lines.length : next;
    } else {
      let inside = false,
        escaped = false,
        split = -1;
      for (let i = 0; i < spec.length; i++) {
        const c = spec[i];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (c === "\\") {
          escaped = true;
          continue;
        }
        if (c === "/") inside = !inside;
        else if (c === "," && !inside) {
          split = i;
          break;
        }
      }
      if (inside) fail(400, "Unclosed blame regex");
      const a = split < 0 ? spec : spec.slice(0, split),
        b = split < 0 ? null : spec.slice(split + 1);
      start = anchor(a, previous, 1);
      if (b === null) end = start;
      else if (/^[+-]\d+$/.test(b)) {
        const n = Number(b);
        if (!n) fail(400, "Zero-length blame range");
        if (n < 0) {
          end = start;
          start += n + 1;
        } else end = start + n - 1;
      } else end = anchor(b, start - 1, lines.length);
    }
    if (start < 1 || end < start || end > lines.length)
      fail(400, "Blame range out of bounds");
    for (let i = start; i <= end; i++) indexes.add(i);
    previous = end;
  }
  return lines.filter((l) => indexes.has(l.line));
}
