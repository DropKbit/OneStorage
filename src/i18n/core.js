import english from "./en.json" with { type: "json" };
import errors from "./errors.json" with { type: "json" };
export function translateError(source, locale) {
  return locale === "zh-CN" && Object.hasOwn(errors, source)
    ? errors[source]
    : source;
}
// Only call this with application-owned literals, never user data or completed HTML.
// The message catalog can reorder placeholders without touching interpolated values.
export function translateLiteral(source, locale) {
  if (locale !== "en") return source;
  return source.replace(/[^<>"'`\n]+/g, (part) => {
    const key = part.trim();
    if (!Object.hasOwn(english, key)) return part;
    const start = part.length - part.trimStart().length;
    const end = part.length - part.trimEnd().length;
    return part.slice(0, start) + english[key] + (end ? part.slice(-end) : "");
  });
}
export function translateTemplate(strings, values, locale) {
  const template = strings
    .map((part, i) => part + (i < values.length ? `⟦${i}⟧` : ""))
    .join("");
  return translateLiteral(template, locale).replace(
    /⟦(\d+)⟧/g,
    (marker, index) =>
      Number(index) < values.length ? String(values[Number(index)]) : marker,
  );
}
