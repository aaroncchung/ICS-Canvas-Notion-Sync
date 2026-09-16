import {
  normalizeRuns,
  parseDescriptionMarkdown,
  type DescriptionNode,
  type InlineRun,
} from "../description-document.ts";
import {
  PARAGRAPH_TEXT_LIMIT,
  RICH_TEXT_ITEM_LIMIT,
  paragraph,
  splitText,
  type Block,
} from "./blocks.ts";

export const EMPTY_DESCRIPTION_TEXT = "No description provided.";
/** Notion rejects link URLs over 2000 characters and cannot open relative ones. */
const LINK_URL = /^(?:https?:\/\/|mailto:)\S{1,1990}$/i;

type RichText = Record<string, unknown>;

function annotations(run: InlineRun): Record<string, true> | undefined {
  const value: Record<string, true> = {
    ...(run.bold ? { bold: true } : {}),
    ...(run.italic ? { italic: true } : {}),
    ...(run.code ? { code: true } : {}),
  };
  return Object.keys(value).length ? value : undefined;
}

/** Drops links Notion cannot hold, then re-merges neighbours so the written form is normal form. */
function notionRuns(runs: InlineRun[]): InlineRun[] {
  return normalizeRuns(
    runs.map((run) =>
      run.link !== undefined && !LINK_URL.test(run.link)
        ? { text: run.text, bold: run.bold, italic: run.italic, code: run.code }
        : run,
    ),
  );
}

function richTextItems(run: InlineRun): RichText[] {
  const link = run.link !== undefined ? { url: run.link } : undefined;
  const styled = annotations(run);
  return splitText(run.text, PARAGRAPH_TEXT_LIMIT).map((content) => ({
    type: "text",
    text: { content, ...(link ? { link } : {}) },
    ...(styled ? { annotations: styled } : {}),
  }));
}

function chunk<T>(items: T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    groups.push(items.slice(offset, offset + size));
  }
  return groups;
}

function blockType(node: DescriptionNode): string {
  switch (node.kind) {
    case "heading":
      return `heading_${node.level}`;
    case "bulleted":
      return "bulleted_list_item";
    case "numbered":
      return "numbered_list_item";
    default:
      return node.kind;
  }
}

/**
 * Renders one node as Notion blocks. A node whose rich text exceeds Notion's 100-item limit
 * continues in further blocks of the same type, so no text is ever dropped or cut mid-word.
 */
function nodeBlocks(node: DescriptionNode): Block[] {
  if (node.kind === "code") {
    const items = splitText(node.text, PARAGRAPH_TEXT_LIMIT).map((content) => ({
      type: "text",
      text: { content },
    }));
    return chunk(items, RICH_TEXT_ITEM_LIMIT).map((rich_text) => ({
      object: "block",
      type: "code",
      code: { rich_text, language: "plain text" },
    }));
  }
  const type = blockType(node);
  const items = notionRuns(node.runs).flatMap(richTextItems);
  return chunk(items, RICH_TEXT_ITEM_LIMIT).map((rich_text) => ({
    object: "block",
    type,
    [type]: { rich_text },
  }));
}

/** The managed-section body for a Canvas description, or a placeholder when it is blank. */
export function descriptionBlocks(markdown: string): Block[] {
  const blocks = parseDescriptionMarkdown(markdown).flatMap(nodeBlocks);
  return blocks.length ? blocks : [paragraph(EMPTY_DESCRIPTION_TEXT)];
}
