// Keep native Git/API clients working on the previous host. Only browser pages move.
export function canonicalPageURL(
  request: Request,
  canonical: string,
  legacy?: string,
): string | null {
  if (!legacy || !["GET", "HEAD"].includes(request.method)) return null;
  const url = new URL(request.url);
  if (url.origin !== legacy || canonical === legacy) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (/^\/(api|mcp|webhooks)(\/|$)/.test(pathname) || pathname.includes(".git"))
    return null;
  const destination = new URL(canonical);
  destination.pathname = url.pathname;
  destination.search = url.search;
  return destination.href;
}
