export type Block = Record<string, unknown>;

/** Notion allows 2000 characters per rich text item; leave a margin. */
export const PARAGRAPH_TEXT_LIMIT = 1900;

export function paragraph(content: string): Block {
  return {
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content } }] },
  };
}

/** Split text into paragraph blocks without cutting a surrogate pair in half. */
export function paragraphs(content: string, limit = PARAGRAPH_TEXT_LIMIT): Block[] {
  const blocks: Block[] = [];
  for (let offset = 0; offset < content.length;) {
    let end = Math.min(offset + limit, content.length);
    const high = content.charCodeAt(end - 1);
    const low = content.charCodeAt(end);
    if (end < content.length && high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff)
      end -= 1;
    blocks.push(paragraph(content.slice(offset, end)));
    offset = end;
  }
  return blocks;
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
