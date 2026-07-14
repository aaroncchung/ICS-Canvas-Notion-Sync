import {
  AmbiguousNotionWriteError,
  errorStatus,
  isAmbiguousWriteError,
  type NotionGateway,
} from "./client.js";

type Block = Record<string, unknown>;

export interface ManagedSectionTitles {
  managed: string;
  pending: string;
}

export interface ManagedSectionSnapshot {
  readonly pageId: string;
  readonly titles: ManagedSectionTitles;
  readonly expectedBlocks: Block[];
  readonly expectedSignatures: string[];
  rootBlocks: Block[] | undefined;
  readonly childSignatures: Map<string, string[]>;
}

export interface ManagedSectionVerification {
  readonly canonicalId: string;
  readonly rootBlocks: Block[];
  readonly childSignatures: string[];
  readonly expectedSignatures: string[];
}

export interface ManagedSectionReconciliation {
  replaced: boolean;
  verified: ManagedSectionVerification;
}

export function blockText(block: Block): string {
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

function toggle(title: string): Block {
  return {
    object: "block",
    type: "toggle",
    toggle: {
      rich_text: [{ type: "text", text: { content: title } }],
      color: "default",
    },
  };
}

function isToggle(block: Block, title: string): boolean {
  return block.type === "toggle" && blockText(block) === title && typeof block.id === "string";
}

function signature(block: Block): string {
  const type = typeof block.type === "string" ? block.type : "";
  return JSON.stringify([type, blockText(block)]);
}

function signaturesEqual(actual: string[], expected: string[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

function isPrefix(actual: string[], expected: string[]): boolean {
  return (
    actual.length <= expected.length && actual.every((value, index) => value === expected[index])
  );
}

function markerBlocks(blocks: Block[], title: string): Block[] {
  return blocks.filter((block) => isToggle(block, title));
}

async function rootBlocks(
  gateway: NotionGateway,
  snapshot: ManagedSectionSnapshot,
): Promise<Block[]> {
  if (!snapshot.rootBlocks) snapshot.rootBlocks = await gateway.listBlocks(snapshot.pageId);
  return snapshot.rootBlocks;
}

function invalidateRoot(snapshot: ManagedSectionSnapshot): void {
  snapshot.rootBlocks = undefined;
}

async function childSignatures(
  gateway: NotionGateway,
  snapshot: ManagedSectionSnapshot,
  blockId: string,
): Promise<string[]> {
  const cached = snapshot.childSignatures.get(blockId);
  if (cached) return cached;
  const actual = (await gateway.listBlocks(blockId)).map(signature);
  snapshot.childSignatures.set(blockId, actual);
  return actual;
}

function invalidateChild(snapshot: ManagedSectionSnapshot, blockId: string): void {
  snapshot.childSignatures.delete(blockId);
}

export async function createManagedSectionSnapshot(
  gateway: NotionGateway,
  pageId: string,
  titles: ManagedSectionTitles,
  expectedBlocks: Block[],
  initialRootBlocks?: Block[],
): Promise<ManagedSectionSnapshot> {
  return {
    pageId,
    titles,
    expectedBlocks,
    expectedSignatures: expectedBlocks.map(signature),
    rootBlocks: initialRootBlocks ?? (await gateway.listBlocks(pageId)),
    childSignatures: new Map(),
  };
}

export async function verifyManagedSection(
  gateway: NotionGateway,
  snapshot: ManagedSectionSnapshot,
): Promise<ManagedSectionVerification | undefined> {
  const root = await rootBlocks(gateway, snapshot);
  const canonical = markerBlocks(root, snapshot.titles.managed);
  const pending = markerBlocks(root, snapshot.titles.pending);
  if (canonical.length !== 1 || pending.length !== 0) return;
  const canonicalId = canonical[0]!.id as string;
  const actual = await childSignatures(gateway, snapshot, canonicalId);
  if (!signaturesEqual(actual, snapshot.expectedSignatures)) return;
  return {
    canonicalId,
    rootBlocks: root,
    childSignatures: actual,
    expectedSignatures: snapshot.expectedSignatures,
  };
}

async function deleteBlockWithObservation(
  gateway: NotionGateway,
  parentId: string,
  blockId: string,
): Promise<Block[] | undefined> {
  try {
    await gateway.deleteBlock(blockId);
    return;
  } catch (error) {
    if (errorStatus(error) === 404) return;
    if (!isAmbiguousWriteError(error)) throw error;
  }

  const observed = await gateway.listBlocks(parentId);
  if (!observed.some((block) => block.id === blockId)) {
    if (gateway.metrics) gateway.metrics.ambiguousWriteRecoveries += 1;
    return observed;
  }

  try {
    await gateway.deleteBlock(blockId);
    return observed.filter((block) => block.id !== blockId);
  } catch (error) {
    if (errorStatus(error) === 404) return observed.filter((block) => block.id !== blockId);
    if (!isAmbiguousWriteError(error)) throw error;
    const recovered = await gateway.listBlocks(parentId);
    if (!recovered.some((block) => block.id === blockId)) {
      if (gateway.metrics) gateway.metrics.ambiguousWriteRecoveries += 1;
      return recovered;
    }
    throw error;
  }
}

export async function deleteBlockReconciled(
  gateway: NotionGateway,
  parentId: string,
  blockId: string,
): Promise<void> {
  await deleteBlockWithObservation(gateway, parentId, blockId);
}

async function deleteSnapshotBlock(
  gateway: NotionGateway,
  snapshot: ManagedSectionSnapshot,
  blockId: string,
): Promise<void> {
  const root = await rootBlocks(gateway, snapshot);
  const observed = await deleteBlockWithObservation(gateway, snapshot.pageId, blockId);
  snapshot.rootBlocks = observed ?? root.filter((block) => block.id !== blockId);
  invalidateChild(snapshot, blockId);
}

async function deleteBlocks(
  gateway: NotionGateway,
  snapshot: ManagedSectionSnapshot,
  blocks: Block[],
  exceptId?: string,
): Promise<void> {
  for (const block of blocks) {
    if (typeof block.id === "string" && block.id !== exceptId) {
      await deleteSnapshotBlock(gateway, snapshot, block.id);
    }
  }
}

async function verifiedResult(
  gateway: NotionGateway,
  snapshot: ManagedSectionSnapshot,
  replaced: boolean,
): Promise<ManagedSectionReconciliation> {
  const verified = await verifyManagedSection(gateway, snapshot);
  if (!verified) {
    throw new AmbiguousNotionWriteError("Managed section integrity verification failed");
  }
  return { replaced, verified };
}

export async function reconcileManagedSection(
  gateway: NotionGateway,
  snapshot: ManagedSectionSnapshot,
): Promise<ManagedSectionReconciliation> {
  let root = await rootBlocks(gateway, snapshot);
  let canonical = markerBlocks(root, snapshot.titles.managed);
  let pending = markerBlocks(root, snapshot.titles.pending);

  for (const candidate of canonical) {
    const id = candidate.id as string;
    const actual = await childSignatures(gateway, snapshot, id);
    if (signaturesEqual(actual, snapshot.expectedSignatures)) {
      await deleteBlocks(gateway, snapshot, canonical, id);
      await deleteBlocks(gateway, snapshot, pending);
      return verifiedResult(gateway, snapshot, false);
    }
  }

  let replacement: Block | undefined;
  let replacementLength = -1;
  for (const candidate of pending) {
    const id = candidate.id as string;
    const actual = await childSignatures(gateway, snapshot, id);
    if (isPrefix(actual, snapshot.expectedSignatures) && actual.length > replacementLength) {
      replacement = candidate;
      replacementLength = actual.length;
    }
  }
  await deleteBlocks(gateway, snapshot, pending, replacement?.id as string | undefined);

  if (!replacement) {
    const marker = toggle(snapshot.titles.pending);
    root = await rootBlocks(gateway, snapshot);
    try {
      const [replacementId] = await gateway.appendBlocks(snapshot.pageId, [marker]);
      if (!replacementId) {
        invalidateRoot(snapshot);
        throw new Error("Notion did not return the managed section ID");
      }
      replacement = { ...marker, id: replacementId };
      snapshot.rootBlocks = [...root, replacement];
      snapshot.childSignatures.set(replacementId, []);
    } catch (error) {
      if (!isAmbiguousWriteError(error)) throw error;
      invalidateRoot(snapshot);
      root = await rootBlocks(gateway, snapshot);
      const recovered = markerBlocks(root, snapshot.titles.pending);
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
  let actual = await childSignatures(gateway, snapshot, replacementId);
  if (!isPrefix(actual, snapshot.expectedSignatures)) {
    throw new AmbiguousNotionWriteError("Managed section replacement has unexpected content");
  }

  while (actual.length < snapshot.expectedSignatures.length) {
    const next = snapshot.expectedBlocks.slice(actual.length, actual.length + 100);
    const previousLength = actual.length;
    let ambiguousAppend = false;
    try {
      await gateway.appendBlocks(replacementId, next);
    } catch (error) {
      if (!isAmbiguousWriteError(error)) throw error;
      ambiguousAppend = true;
    }
    invalidateChild(snapshot, replacementId);
    actual = await childSignatures(gateway, snapshot, replacementId);
    if (ambiguousAppend) {
      if (!isPrefix(actual, snapshot.expectedSignatures) || actual.length <= previousLength) {
        throw new AmbiguousNotionWriteError(
          "Managed section child append is ambiguous; the previous section was preserved",
        );
      }
      if (gateway.metrics) gateway.metrics.ambiguousWriteRecoveries += 1;
    }
    if (!isPrefix(actual, snapshot.expectedSignatures)) {
      throw new AmbiguousNotionWriteError("Managed section replacement could not be verified");
    }
  }
  if (!signaturesEqual(actual, snapshot.expectedSignatures)) {
    throw new AmbiguousNotionWriteError("Managed section replacement could not be verified");
  }

  try {
    await gateway.updateBlock(replacementId, { toggle: toggle(snapshot.titles.managed).toggle });
  } catch (error) {
    if (isAmbiguousWriteError(error)) invalidateRoot(snapshot);
    throw error;
  }
  invalidateRoot(snapshot);
  root = await rootBlocks(gateway, snapshot);
  canonical = markerBlocks(root, snapshot.titles.managed);
  pending = markerBlocks(root, snapshot.titles.pending);
  if (!canonical.some((block) => block.id === replacementId)) {
    throw new AmbiguousNotionWriteError("Managed section marker promotion could not be verified");
  }
  await deleteBlocks(gateway, snapshot, canonical, replacementId);
  await deleteBlocks(gateway, snapshot, pending);
  return verifiedResult(gateway, snapshot, true);
}
