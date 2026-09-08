export function renderMarkdown(
  source: string,
  env?: {
    base?: string;
    ref?: string;
    path?: string;
    idPrefix?: string;
    resolveAttachment?: (name: string) => string | null;
  },
): string;
