import { AmbiguousNotionWriteError, isAmbiguousWriteError, type NotionGateway } from "./client.js";

export const MANAGED_DESCRIPTION_TITLE = "Canvas Description — managed by sync";
export const PENDING_MANAGED_DESCRIPTION_TITLE =
  "Canvas Description — managed by sync [replacement pending]";

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
      const record = item as Record<string, unknown>;
      if (typeof record.plain_text === "string") return record.plain_text;
      const text = record.text;
      if (!text || typeof text !== "object") return "";
      const contentValue = (text as Record<string, unknown>).content;
      return typeof contentValue === "string" ? contentValue : "";
    })
    .join("");
}

function isToggle(block: Record<string, unknown>, title: string): boolean {
  return block.type === "toggle" && blockText(block) === title && typeof block.id === "string";
}

export async function readManagedDescription(
  gateway: NotionGateway,
  pageId: string,
): Promise<string | undefined> {
  const blocks = await gateway.listBlocks(pageId);
  const toggle = blocks.find((block) => isToggle(block, MANAGED_DESCRIPTION_TITLE));
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

function toggle(title: string): Record<string, unknown> {
  return {
    object: "block",
    type: "toggle",
    toggle: {
      rich_text: [{ type: "text", text: { content: title } }],
      color: "default",
    },
  };
}

function isPrefix(actual: string[], expected: string[]): boolean {
  return (
    actual.length <= expected.length && actual.every((value, index) => value === expected[index])
  );
}

async function childText(gateway: NotionGateway, blockId: string): Promise<string[]> {
  return (await gateway.listBlocks(blockId)).map(blockText);
}

async function deleteBlocks(
  gateway: NotionGateway,
  blocks: Array<Record<string, unknown>>,
  exceptId?: string,
): Promise<void> {
  for (const block of blocks) {
    if (typeof block.id === "string" && block.id !== exceptId) await gateway.deleteBlock(block.id);
  }
}

export async function replaceManagedDescription(
  gateway: NotionGateway,
  pageId: string,
  markdown: string | undefined,
): Promise<void> {
  const expected = chunks(markdown ?? "");
  let blocks = await gateway.listBlocks(pageId);
  let canonical = blocks.filter((block) => isToggle(block, MANAGED_DESCRIPTION_TITLE));
  let pending = blocks.filter((block) => isToggle(block, PENDING_MANAGED_DESCRIPTION_TITLE));

  for (const candidate of canonical) {
    if (typeof candidate.id !== "string") continue;
    if ((await childText(gateway, candidate.id)).join("") === expected.join("")) {
      await deleteBlocks(gateway, canonical, candidate.id);
      await deleteBlocks(gateway, pending);
      return;
    }
  }

  if (pending.length > 1) {
    await deleteBlocks(gateway, pending);
    pending = [];
  }

  let replacement = pending[0];
  if (replacement && typeof replacement.id === "string") {
    const actual = await childText(gateway, replacement.id);
    if (!isPrefix(actual, expected)) {
      await gateway.deleteBlock(replacement.id);
      replacement = undefined;
    }
  }

  if (!replacement) {
    try {
      const [replacementId] = await gateway.appendBlocks(pageId, [
        toggle(PENDING_MANAGED_DESCRIPTION_TITLE),
      ]);
      if (!replacementId) throw new Error("Notion did not return the replacement toggle ID");
      replacement = { id: replacementId };
    } catch (error) {
      if (!isAmbiguousWriteError(error)) throw error;
      blocks = await gateway.listBlocks(pageId);
      const recovered = blocks.filter((block) =>
        isToggle(block, PENDING_MANAGED_DESCRIPTION_TITLE),
      );
      if (recovered.length !== 1) {
        throw new AmbiguousNotionWriteError(
          `Managed description toggle append is ambiguous: ${recovered.length} replacements found`,
        );
      }
      replacement = recovered[0];
    }
  }

  if (!replacement || typeof replacement.id !== "string") {
    throw new Error("Notion did not return the replacement toggle ID");
  }
  const replacementId = replacement.id;
  let actual = await childText(gateway, replacementId);
  if (!isPrefix(actual, expected)) {
    throw new AmbiguousNotionWriteError("Managed description replacement has unexpected content");
  }
  while (actual.length < expected.length) {
    const next = expected.slice(actual.length, actual.length + 100);
    try {
      await gateway.appendBlocks(replacementId, next.map(paragraph));
    } catch (error) {
      if (!isAmbiguousWriteError(error)) throw error;
      const recovered = await childText(gateway, replacementId);
      if (!isPrefix(recovered, expected) || recovered.length < actual.length + next.length) {
        throw new AmbiguousNotionWriteError(
          "Managed description child append is ambiguous; the old section was preserved",
        );
      }
    }
    actual = await childText(gateway, replacementId);
    if (!isPrefix(actual, expected)) {
      throw new AmbiguousNotionWriteError("Managed description replacement could not be verified");
    }
  }
  if (actual.join("") !== expected.join("")) {
    throw new AmbiguousNotionWriteError("Managed description replacement could not be verified");
  }

  await gateway.updateBlock(replacementId, { toggle: toggle(MANAGED_DESCRIPTION_TITLE).toggle });
  canonical = (await gateway.listBlocks(pageId)).filter((block) =>
    isToggle(block, MANAGED_DESCRIPTION_TITLE),
  );
  await deleteBlocks(gateway, canonical, replacementId);
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
