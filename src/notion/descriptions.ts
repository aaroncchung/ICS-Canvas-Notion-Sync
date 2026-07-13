import type { NotionGateway } from "./client.js";

export const MANAGED_DESCRIPTION_TITLE = "Canvas Description — managed by sync";

function blockText(block: Record<string, unknown>): string {
  const type = block.type;
  if (typeof type !== "string") return "";
  const content = block[type];
  if (!content || typeof content !== "object") return "";
  const richText = (content as Record<string, unknown>).rich_text;
  if (!Array.isArray(richText)) return "";
  return richText
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const plain = (item as Record<string, unknown>).plain_text;
      return typeof plain === "string" ? plain : "";
    })
    .join("");
}

export async function readManagedDescription(
  gateway: NotionGateway,
  pageId: string,
): Promise<string | undefined> {
  const blocks = await gateway.listBlocks(pageId);
  const toggle = blocks.find(
    (block) => block.type === "toggle" && blockText(block) === MANAGED_DESCRIPTION_TITLE,
  );
  if (!toggle || typeof toggle.id !== "string") return;
  const children = await gateway.listBlocks(toggle.id);
  const value = children.map(blockText).join("");
  return value === "No description provided." ? "" : value;
}

function chunks(markdown: string): string[] {
  if (!markdown) return ["No description provided."];
  const result: string[] = [];
  for (let offset = 0; offset < markdown.length; offset += 1900) {
    result.push(markdown.slice(offset, offset + 1900));
  }
  return result;
}

function paragraph(content: string): Record<string, unknown> {
  return {
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content } }] },
  };
}

export async function replaceManagedDescription(
  gateway: NotionGateway,
  pageId: string,
  markdown: string | undefined,
): Promise<void> {
  const blocks = await gateway.listBlocks(pageId);
  for (const block of blocks) {
    if (block.type === "toggle" && blockText(block) === MANAGED_DESCRIPTION_TITLE) {
      if (typeof block.id === "string") await gateway.deleteBlock(block.id);
    }
  }
  const [toggleId] = await gateway.appendBlocks(pageId, [
    {
      object: "block",
      type: "toggle",
      toggle: {
        rich_text: [{ type: "text", text: { content: MANAGED_DESCRIPTION_TITLE } }],
        color: "default",
      },
    },
  ]);
  if (!toggleId) throw new Error("Notion did not return the managed description block ID");
  const paragraphs = chunks(markdown ?? "").map(paragraph);
  for (let index = 0; index < paragraphs.length; index += 100) {
    await gateway.appendBlocks(toggleId, paragraphs.slice(index, index + 100));
  }
}

export async function waitForTemplate(
  gateway: NotionGateway,
  pageId: string,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<void> {
  const attempts = options.attempts ?? 10;
  const delayMs = options.delayMs ?? 1000;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if ((await gateway.listBlocks(pageId)).length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}
