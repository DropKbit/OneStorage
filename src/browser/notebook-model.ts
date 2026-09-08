export const NOTEBOOK_LIMITS = {
  bytes: 2 * 1024 * 1024,
  cells: 1000,
  outputs: 1000,
  cellOutputs: 40,
  text: 100000,
  imageBytes: 1024 * 1024,
};
export function notebookText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((v) => typeof v === "string"))
    return value.join("");
  return null;
}
const record = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
export function parseNotebook(source: string) {
  if (
    source.length > NOTEBOOK_LIMITS.bytes ||
    new TextEncoder().encode(source).length > NOTEBOOK_LIMITS.bytes
  )
    throw Error("笔记本超过 2 MiB 预览上限，请查看源码或通过 Git 下载。");
  let data: any;
  try {
    data = JSON.parse(source);
  } catch {
    throw Error("笔记本不是有效的 JSON，请查看源码。");
  }
  if (!record(data) || data.nbformat !== 4 || !Array.isArray(data.cells))
    throw Error("目前支持 nbformat 4 笔记本，请查看源码。");
  const language =
    typeof data.metadata?.language_info?.name === "string"
      ? data.metadata.language_info.name.slice(0, 80)
      : typeof data.metadata?.kernelspec?.language === "string"
        ? data.metadata.kernelspec.language.slice(0, 80)
        : "";
  let outputCount = 0;
  const cells = data.cells
    .slice(0, NOTEBOOK_LIMITS.cells)
    .map((raw: unknown, index: number) => {
      const cell = record(raw) ? raw : {},
        original = notebookText(cell.source),
        warnings: string[] = [];
      if (original === null) warnings.push("单元源码格式无效");
      if ((original?.length || 0) > NOTEBOOK_LIMITS.text)
        warnings.push("单元内容已截断，请查看 JSON 源码");
      const allOutputs = Array.isArray(cell.outputs) ? cell.outputs : [];
      const take = Math.min(
        NOTEBOOK_LIMITS.cellOutputs,
        NOTEBOOK_LIMITS.outputs - outputCount,
      );
      const outputs = allOutputs
        .slice(0, take)
        .map((o) => (record(o) ? o : { output_type: "invalid" }));
      outputCount += outputs.length;
      if (allOutputs.length > outputs.length)
        warnings.push(
          `已省略 ${allOutputs.length - outputs.length} 个超限输出`,
        );
      return {
        index: index + 1,
        type: typeof cell.cell_type === "string" ? cell.cell_type : "unknown",
        source: (original || "").slice(0, NOTEBOOK_LIMITS.text),
        execution:
          Number.isSafeInteger(cell.execution_count) &&
          cell.execution_count >= 0
            ? cell.execution_count
            : null,
        outputs,
        attachments: record(cell.attachments) ? cell.attachments : {},
        warnings,
      };
    });
  return {
    language,
    cells,
    total: data.cells.length,
    omitted: data.cells.length - cells.length,
  };
}
/** Inline raster images only. No SVG, URLs, MIME guessing or metadata-controlled dimensions. */
export function notebookImage(bundle: unknown): string | null {
  if (!record(bundle)) return null;
  for (const mime of ["image/png", "image/jpeg"]) {
    const raw = notebookText(bundle[mime]);
    if (!raw || raw.length > NOTEBOOK_LIMITS.imageBytes * 1.4) continue;
    const encoded = raw.replace(/\s/g, "");
    if (encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) continue;
    let b: string;
    try {
      b = atob(encoded);
    } catch {
      continue;
    }
    if (b.length > NOTEBOOK_LIMITS.imageBytes) continue;
    const byte = (i: number) => b.charCodeAt(i),
      u16 = (i: number) => byte(i) * 256 + byte(i + 1);
    let w = 0,
      h = 0;
    if (mime === "image/png") {
      if (
        b.length < 24 ||
        b.slice(0, 8) !== "\x89PNG\r\n\x1a\n" ||
        b.slice(12, 16) !== "IHDR"
      )
        continue;
      const u32 = (i: number) =>
        byte(i) * 16777216 +
        byte(i + 1) * 65536 +
        byte(i + 2) * 256 +
        byte(i + 3);
      w = u32(16);
      h = u32(20);
    } else {
      if (b.slice(0, 3) !== "\xff\xd8\xff") continue;
      for (let p = 2; p + 8 < b.length && p < 65536;) {
        if (byte(p++) !== 255) break;
        while (byte(p) === 255) p++;
        const marker = byte(p++);
        if (marker === 0xda || marker === 0xd9) break;
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        const length = u16(p);
        if (length < 2 || p + length > b.length) break;
        if (
          [
            0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd,
            0xce, 0xcf,
          ].includes(marker) &&
          length >= 8
        ) {
          h = u16(p + 3);
          w = u16(p + 5);
          break;
        }
        p += length;
      }
    }
    if (w > 0 && h > 0 && w <= 10000 && h <= 10000 && w * h <= 16000000)
      return `data:${mime};base64,${encoded}`;
  }
  return null;
}
