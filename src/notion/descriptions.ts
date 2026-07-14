import type { NotionGateway } from "./client.js";
import { blockText, reconcileManagedSection } from "./managed-section.js";

export const MANAGED_DESCRIPTION_TITLE = "Canvas Description — managed by sync";
export const PENDING_MANAGED_DESCRIPTION_TITLE =
  "Canvas Description — managed by sync [replacement pending]";

function paragraph(content: string): Record<string, unknown> {
  return {
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content } }] },
  };
}

function descriptionBlocks(markdown: string): Array<Record<string, unknown>> {
  if (!markdown) return [paragraph("No description provided.")];
  const result: Array<Record<string, unknown>> = [];
  for (let offset = 0; offset < markdown.length; offset += 1900) {
    result.push(paragraph(markdown.slice(offset, offset + 1900)));
  }
  return result;
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
  const value = (await gateway.listBlocks(toggle.id)).map(blockText).join("");
  return value === "No description provided." ? "" : value;
}

export async function replaceManagedDescription(
  gateway: NotionGateway,
  pageId: string,
  markdown: string | undefined,
): Promise<void> {
  await reconcileManagedSection(
    gateway,
    pageId,
    { managed: MANAGED_DESCRIPTION_TITLE, pending: PENDING_MANAGED_DESCRIPTION_TITLE },
    descriptionBlocks(markdown ?? ""),
  );
}

export interface TemplateWaitOptions {
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

async function templateSnapshot(gateway: NotionGateway, parentId: string): Promise<string> {
  const blocks = await gateway.listBlocks(parentId);
  const values: unknown[] = [];
  for (const block of blocks) {
    const id = typeof block.id === "string" ? block.id : "";
    values.push([id, block.type ?? "", blockText(block), block.has_children === true]);
    if (id && block.has_children === true) values.push(await templateSnapshot(gateway, id));
  }
  return blocks.length ? JSON.stringify(values) : "";
}

export async function waitForTemplate(
  gateway: NotionGateway,
  pageId: string,
  options: TemplateWaitOptions = {},
): Promise<void> {
  const attempts = options.attempts ?? 10;
  const delayMs = options.delayMs ?? 1000;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let previous = "";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const current = await templateSnapshot(gateway, pageId);
    if (current && current === previous) return;
    previous = current;
    if (attempt < attempts - 1) await sleep(delayMs);
  }
  throw new Error(`Default template did not stabilize for assignment page ${pageId}`);
}
