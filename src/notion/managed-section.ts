import {
  AmbiguousNotionWriteError,
  errorStatus,
  isAmbiguousWriteError,
  type NotionGateway,
} from "./client.js";

export function blockText(block: Record<string, unknown>): string {
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

function isToggle(block: Record<string, unknown>, title: string): boolean {
  return block.type === "toggle" && blockText(block) === title && typeof block.id === "string";
}

function signature(block: Record<string, unknown>): string {
  const type = typeof block.type === "string" ? block.type : "";
  return JSON.stringify([type, blockText(block)]);
}

function isPrefix(actual: string[], expected: string[]): boolean {
  return (
    actual.length <= expected.length && actual.every((value, index) => value === expected[index])
  );
}

async function blockExists(
  gateway: NotionGateway,
  parentId: string,
  blockId: string,
): Promise<boolean> {
  return (await gateway.listBlocks(parentId)).some((block) => block.id === blockId);
}

export async function deleteBlockReconciled(
  gateway: NotionGateway,
  parentId: string,
  blockId: string,
): Promise<void> {
  try {
    await gateway.deleteBlock(blockId);
    return;
  } catch (error) {
    if (errorStatus(error) === 404) return;
    if (!isAmbiguousWriteError(error)) throw error;
  }

  if (!(await blockExists(gateway, parentId, blockId))) {
    if (gateway.metrics) gateway.metrics.ambiguousWriteRecoveries += 1;
    return;
  }

  try {
    await gateway.deleteBlock(blockId);
  } catch (error) {
    if (errorStatus(error) === 404) return;
    if (isAmbiguousWriteError(error) && !(await blockExists(gateway, parentId, blockId))) {
      if (gateway.metrics) gateway.metrics.ambiguousWriteRecoveries += 1;
      return;
    }
    throw error;
  }
}

async function deleteBlocks(
  gateway: NotionGateway,
  parentId: string,
  blocks: Array<Record<string, unknown>>,
  exceptId?: string,
): Promise<void> {
  for (const block of blocks) {
    if (typeof block.id === "string" && block.id !== exceptId) {
      await deleteBlockReconciled(gateway, parentId, block.id);
    }
  }
}

async function childSignatures(gateway: NotionGateway, blockId: string): Promise<string[]> {
  return (await gateway.listBlocks(blockId)).map(signature);
}

export async function reconcileManagedSection(
  gateway: NotionGateway,
  pageId: string,
  titles: { managed: string; pending: string },
  expectedBlocks: Array<Record<string, unknown>>,
): Promise<void> {
  const expected = expectedBlocks.map(signature);
  let blocks = await gateway.listBlocks(pageId);
  let canonical = blocks.filter((block) => isToggle(block, titles.managed));
  let pending = blocks.filter((block) => isToggle(block, titles.pending));

  for (const candidate of canonical) {
    const id = candidate.id as string;
    if (JSON.stringify(await childSignatures(gateway, id)) === JSON.stringify(expected)) {
      await deleteBlocks(gateway, pageId, canonical, id);
      await deleteBlocks(gateway, pageId, pending);
      return;
    }
  }

  let replacement: Record<string, unknown> | undefined;
  let replacementLength = -1;
  for (const candidate of pending) {
    const id = candidate.id as string;
    const actual = await childSignatures(gateway, id);
    if (isPrefix(actual, expected) && actual.length > replacementLength) {
      replacement = candidate;
      replacementLength = actual.length;
    }
  }
  await deleteBlocks(gateway, pageId, pending, replacement?.id as string | undefined);

  if (!replacement) {
    try {
      const [replacementId] = await gateway.appendBlocks(pageId, [toggle(titles.pending)]);
      if (!replacementId) throw new Error("Notion did not return the managed section ID");
      replacement = { id: replacementId };
    } catch (error) {
      if (!isAmbiguousWriteError(error)) throw error;
      blocks = await gateway.listBlocks(pageId);
      const recovered = blocks.filter((block) => isToggle(block, titles.pending));
      if (recovered.length !== 1) {
        throw new AmbiguousNotionWriteError(
          `Managed section marker append is ambiguous: ${recovered.length} replacements found`,
        );
      }
      replacement = recovered[0];
      if (gateway.metrics) gateway.metrics.ambiguousWriteRecoveries += 1;
    }
  }

  if (!replacement || typeof replacement.id !== "string") {
    throw new Error("Notion did not return the managed section ID");
  }
  const replacementId = replacement.id;
  let actual = await childSignatures(gateway, replacementId);
  if (!isPrefix(actual, expected)) {
    throw new AmbiguousNotionWriteError("Managed section replacement has unexpected content");
  }

  while (actual.length < expected.length) {
    const next = expectedBlocks.slice(actual.length, actual.length + 100);
    const previousLength = actual.length;
    try {
      await gateway.appendBlocks(replacementId, next);
    } catch (error) {
      if (!isAmbiguousWriteError(error)) throw error;
      const recovered = await childSignatures(gateway, replacementId);
      if (!isPrefix(recovered, expected) || recovered.length <= previousLength) {
        throw new AmbiguousNotionWriteError(
          "Managed section child append is ambiguous; the previous section was preserved",
        );
      }
      if (gateway.metrics) gateway.metrics.ambiguousWriteRecoveries += 1;
    }
    actual = await childSignatures(gateway, replacementId);
    if (!isPrefix(actual, expected)) {
      throw new AmbiguousNotionWriteError("Managed section replacement could not be verified");
    }
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new AmbiguousNotionWriteError("Managed section replacement could not be verified");
  }

  await gateway.updateBlock(replacementId, { toggle: toggle(titles.managed).toggle });
  canonical = (await gateway.listBlocks(pageId)).filter((block) => isToggle(block, titles.managed));
  await deleteBlocks(gateway, pageId, canonical, replacementId);
  pending = (await gateway.listBlocks(pageId)).filter((block) => isToggle(block, titles.pending));
  await deleteBlocks(gateway, pageId, pending);
}
