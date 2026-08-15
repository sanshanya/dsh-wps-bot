/**
 * Markdown 分段（长度上限契约）。
 *
 * 逐行迁移 ksbot_ga/src/ga_wps/client.py:97-112 的 _split(text, limit=4500)：
 *  - CRLF 归一为 LF
 *  - 按 \n\n 切自然段，strip 去空段
 *  - 单段超限：先结清在装段，再把超限段按 limit 硬切
 *  - 多段贪心装填
 *  - 全文空 → [""]
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
      for (let start = 0; start < block.length; start += limit) {
        chunks.push(block.slice(start, start + limit));
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
