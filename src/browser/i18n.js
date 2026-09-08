import {
  translateLiteral,
  translateTemplate,
  translateError,
} from "../i18n/core.js";
import {
  supportedLocale,
  negotiateLocale,
  cookieLocale,
  LOCALE_COOKIE,
} from "../i18n/locale.ts";
const storageKey = "onestorage.locale";
let saved;
try {
  saved = localStorage.getItem(storageKey);
} catch {}
const inBrowser =
  typeof document !== "undefined" && typeof location !== "undefined";
const locale = inBrowser
  ? supportedLocale(new URL(location.href).searchParams.get("lang")) ||
    supportedLocale(saved) ||
    cookieLocale(document.cookie) ||
    negotiateLocale(navigator.languages?.join(",") || navigator.language)
  : "zh-CN";
export const getLocale = () => locale;
export const text = (source) => translateLiteral(source, locale);
export const errorText = (source) => translateError(source, locale);
export const html = (strings, ...values) =>
  translateTemplate(strings, values, locale);
export const docsURL = (page = "index") =>
  `/docs/${locale}/${encodeURIComponent(page)}.html`;
export const languageControl = () =>
  `<label class="language-control"><span class="sr-only">Language / 语言</span><select data-language aria-label="Language / 语言"><option value="zh-CN" ${locale === "zh-CN" ? "selected" : ""}>简体中文</option><option value="en" ${locale === "en" ? "selected" : ""}>English</option></select></label>`;
function persist(value) {
  try {
    localStorage.setItem(storageKey, value);
  } catch {}
  document.cookie = `${LOCALE_COOKIE}=${value}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
}
if (inBrowser) {
  persist(locale);
  document.documentElement.lang = locale;
  document.addEventListener("change", (event) => {
    if (!event.target.matches?.("select[data-language]")) return;
    const next = supportedLocale(event.target.value);
    if (!next || next === locale) return;
    persist(next);
    const url = new URL(location.href);
    url.searchParams.set("lang", next);
    // Reload also refreshes module-level labels and async widgets in the new locale.
    location.replace(url.href);
  });
}
