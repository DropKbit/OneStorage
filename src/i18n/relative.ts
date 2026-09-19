export function relativeTime(
  value: string,
  language = "zh-CN",
  now = Date.now(),
) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "—";
  const seconds = (timestamp - now) / 1000;
  const magnitude = Math.abs(seconds);
  const [unit, size]: [Intl.RelativeTimeFormatUnit, number] =
    magnitude >= 31536000
      ? ["year", 31536000]
      : magnitude >= 2592000
        ? ["month", 2592000]
        : magnitude >= 86400
          ? ["day", 86400]
          : magnitude >= 3600
            ? ["hour", 3600]
            : magnitude >= 60
              ? ["minute", 60]
              : ["second", 1];
  return new Intl.RelativeTimeFormat(language, { numeric: "auto" }).format(
    Math.trunc(seconds / size),
    unit,
  );
}
