/**
 * Markdown 分段（长度上限契约）。考古锚点见 docs/references.md。
 */

export function splitMarkdown(text: string, limit = 4500): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  const blocks = normalized
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
  if (blocks.length === 0) return [""];

  const chunks: string[] = [];
  let current = "";
  for (const block of blocks) {
    if (block.length > limit) {
      if (current.length > 0) {
        chunks.push(current);
        current = "";
      }
      // UTF-16 硬切守卫：切点若在高代理后，回退 1 位（emoji/增补面不被拦腰）
      const cutEnd = (from: number): number => {
        let end = Math.min(from + limit, block.length);
        if (end < block.length && block.charCodeAt(end - 1) >= 0xd800 && block.charCodeAt(end - 1) <= 0xdbff) end -= 1;
        return end;
      };
      for (let start = 0; start < block.length;) {
        const end = cutEnd(start);
        if (end <= start) { chunks.push(block.slice(start, start + limit)); start += limit; continue; }
        chunks.push(block.slice(start, end));
        start = end;
      }
      continue;
    }
    const candidate = current.length === 0 ? block : `${current}\n\n${block}`;
    if (candidate.length > limit) {
      chunks.push(current);
      current = block;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
