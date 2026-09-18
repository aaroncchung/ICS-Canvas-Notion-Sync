export type Block = Record<string, unknown>;

/** Notion allows 2000 characters per rich text item; leave a margin. */
export const PARAGRAPH_TEXT_LIMIT = 1900;
/** Notion allows 100 rich text items per block. */
export const RICH_TEXT_ITEM_LIMIT = 100;

export function paragraph(content: string): Block {
  return {
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content } }] },
  };
}

function isSurrogateBoundary(content: string, end: number): boolean {
  const high = content.charCodeAt(end - 1);
  const low = content.charCodeAt(end);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
}

/**
 * Split text into pieces of at most `limit` UTF-16 units. A piece ends at the last whitespace in
 * the second half of its window when there is one, so words stay whole; it never ends between
 * the halves of a surrogate pair.
 */
export function splitText(content: string, limit = PARAGRAPH_TEXT_LIMIT): string[] {
  const pieces: string[] = [];
  for (let offset = 0; offset < content.length;) {
    let end = Math.min(offset + limit, content.length);
    if (end < content.length) {
      const window = content.slice(offset, end);
      const boundary = window.search(/\s\S*$/);
      if (boundary > limit / 2) end = offset + boundary + 1;
      else if (isSurrogateBoundary(content, end)) end -= 1;
    }
    pieces.push(content.slice(offset, end));
    offset = end;
  }
  return pieces;
}

/** Split text into paragraph blocks without cutting a surrogate pair in half. */
export function paragraphs(content: string, limit = PARAGRAPH_TEXT_LIMIT): Block[] {
  return splitText(content, limit).map(paragraph);
}

export function toggle(title: string, children?: Block[]): Block {
  return {
    object: "block",
    type: "toggle",
    toggle: {
      rich_text: [{ type: "text", text: { content: title } }],
      color: "default",
      ...(children ? { children } : {}),
    },
  };
}

/** Leave room below Notion's 500 KB request limit for parent/properties/wrappers. */
export function blockBatch(blocks: Block[], offset = 0): Block[] {
  const batch: Block[] = [];
  let bytes = 0;
  for (let index = offset; index < Math.min(offset + 100, blocks.length); index += 1) {
    const block = blocks[index]!;
    const size = Buffer.byteLength(JSON.stringify(block), "utf8") + 1;
    if (bytes + size > 400_000) break;
    batch.push(block);
    bytes += size;
  }
  if (!batch.length && offset < blocks.length) throw new Error("Notion block exceeds batch limit");
  return batch;
}
