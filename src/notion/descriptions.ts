import { createHash } from "node:crypto";
import type { NotionGateway } from "./client.js";
import {
  blockText,
  createManagedSectionSnapshot,
  reconcileManagedSection,
  verifyManagedSection,
} from "./managed-section.js";

export const MANAGED_DESCRIPTION_TITLE = "Canvas Description — managed by sync";
export const PENDING_MANAGED_DESCRIPTION_TITLE =
  "Canvas Description — managed by sync [replacement pending]";
export const DESCRIPTION_HASH_VERSION = "canvas-description:v1";
export const DESCRIPTION_INTEGRITY_INTERVAL_DAYS = 30;

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

export function descriptionIntegrityAuditDue(
  verifiedAt: string | undefined,
  now = new Date(),
): boolean {
  if (!verifiedAt) return true;
  const timestamp = Date.parse(verifiedAt);
  if (!Number.isFinite(timestamp)) return true;
  return now.getTime() - timestamp > DESCRIPTION_INTEGRITY_INTERVAL_DAYS * 24 * 60 * 60 * 1000;
}

export function managedDescriptionHash(
  markdown: string | undefined,
  version = DESCRIPTION_HASH_VERSION,
): string {
  const representation = JSON.stringify(descriptionBlocks(markdown ?? ""));
  return `${version}:${createHash("sha256").update(representation).digest("hex")}`;
}

export async function replaceManagedDescription(
  gateway: NotionGateway,
  pageId: string,
  markdown: string | undefined,
): Promise<{ repaired: boolean; replaced: boolean }> {
  if (gateway.metrics) {
    gateway.metrics.descriptionIntegrityAuditsRun += 1;
    gateway.metrics.assignmentBodyReads += 1;
  }
  const snapshot = await createManagedSectionSnapshot(
    gateway,
    pageId,
    { managed: MANAGED_DESCRIPTION_TITLE, pending: PENDING_MANAGED_DESCRIPTION_TITLE },
    descriptionBlocks(markdown ?? ""),
  );
  if (await verifyManagedSection(gateway, snapshot)) {
    if (gateway.metrics) gateway.metrics.descriptionIntegrityAuditsPassed += 1;
    return { repaired: false, replaced: false };
  }

  const result = await reconcileManagedSection(gateway, snapshot);
  if (gateway.metrics) {
    gateway.metrics.descriptionIntegrityRepairs += 1;
    if (result.replaced) gateway.metrics.descriptionReplacements += 1;
  }
  return { repaired: true, replaced: result.replaced };
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
