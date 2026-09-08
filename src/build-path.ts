export function normalizePath(value: string) {
  if (value.startsWith("/") || /[\\\x00-\x1f]/.test(value))
    throw Error("Invalid build path");
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (part === "..") {
      if (!parts.length) throw Error("Build path escapes root");
      parts.pop();
    } else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/");
}
