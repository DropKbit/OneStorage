export type Locale = "zh-CN" | "en";
export const LOCALE_COOKIE = "onestorage_locale";
export function supportedLocale(value?: string | null): Locale | null {
  const language = value?.toLowerCase();
  if (language === "zh" || language === "zh-cn" || language === "zh-hans")
    return "zh-CN";
  if (language === "en" || language?.startsWith("en-")) return "en";
  return null;
}
export function negotiateLocale(accept = ""): Locale {
  const languages = accept
    .split(",")
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.find((p) => p.trim().startsWith("q="));
      const quality = q ? Number(q.trim().slice(2)) : 1;
      return { locale: supportedLocale(tag), quality, index };
    })
    .filter(
      (x) =>
        x.locale &&
        Number.isFinite(x.quality) &&
        x.quality > 0 &&
        x.quality <= 1,
    )
    .sort((a, b) => b.quality - a.quality || a.index - b.index);
  return languages[0]?.locale || "zh-CN";
}
export function cookieLocale(cookie = ""): Locale | null {
  const item = cookie
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(LOCALE_COOKIE + "="));
  return supportedLocale(item?.slice(LOCALE_COOKIE.length + 1));
}
export function requestLocale(request: Request): Locale {
  return (
    supportedLocale(new URL(request.url).searchParams.get("lang")) ||
    cookieLocale(request.headers.get("cookie") || "") ||
    negotiateLocale(request.headers.get("accept-language") || "")
  );
}
