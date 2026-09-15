import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { calendarDate, DATE_ONLY } from "../calendar-date.js";
import { paragraph, paragraphs, type Block } from "./blocks.js";
import type { NotionGateway } from "./client.js";
import {
  blockText,
  createManagedSectionSnapshot,
  managedBlockCanonicalRepresentation,
  reconcileManagedSection,
  verifyManagedSection,
} from "./managed-section.js";

export const MANAGED_DESCRIPTION_TITLE = "Canvas Description — managed by sync";
export const PENDING_MANAGED_DESCRIPTION_TITLE =
  "Canvas Description — managed by sync [replacement pending]";
export const DESCRIPTION_HASH_VERSION = "canvas-description:v2";
export const DESCRIPTION_INTEGRITY_MINIMUM_AGE_DAYS = 30;
export const DESCRIPTION_INTEGRITY_MAXIMUM_AGE_DAYS = 60;
export const DESCRIPTION_INTEGRITY_SLOT_COUNT = 30;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export type DescriptionIntegrityAuditReason =
  | "missing-verification"
  | "invalid-verification"
  | "not-eligible"
  | "scheduled-slot"
  | "maximum-age"
  | "deferred";

export interface DescriptionIntegrityAuditDecision {
  due: boolean;
  reason: DescriptionIntegrityAuditReason;
  slot: number;
  ageDays?: number;
}

function descriptionBlocks(markdown: string): Block[] {
  return markdown ? paragraphs(markdown) : [paragraph("No description provided.")];
}

function dayOrdinal(dateOnly: string): number {
  const [year, month, day] = dateOnly.split("-").map(Number) as [number, number, number];
  return Math.floor(Date.UTC(year, month - 1, day) / MILLISECONDS_PER_DAY);
}

function calendarDayOrdinal(value: Date, timeZone: string): number {
  return dayOrdinal(calendarDate(value.getTime(), timeZone));
}

function verifiedCalendarDayOrdinal(value: string, timestamp: number, timeZone: string): number {
  return DATE_ONLY.test(value)
    ? dayOrdinal(value)
    : calendarDayOrdinal(new Date(timestamp), timeZone);
}

function modulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

export function descriptionIntegrityAuditSlot(stableIdentifier: string): number {
  return (
    createHash("sha256").update(stableIdentifier).digest().readUInt32BE(0) %
    DESCRIPTION_INTEGRITY_SLOT_COUNT
  );
}

export function descriptionIntegrityAuditDecision(
  stableIdentifier: string,
  verifiedAt: string | undefined,
  timeZone: string,
  now = new Date(),
): DescriptionIntegrityAuditDecision {
  const slot = descriptionIntegrityAuditSlot(stableIdentifier);
  if (!verifiedAt) return { due: true, reason: "missing-verification", slot };
  const timestamp = Date.parse(verifiedAt);
  if (!Number.isFinite(timestamp)) return { due: true, reason: "invalid-verification", slot };
  if (!DATE_ONLY.test(verifiedAt) && timestamp > now.getTime()) {
    return { due: true, reason: "invalid-verification", slot };
  }

  const ageDays =
    calendarDayOrdinal(now, timeZone) - verifiedCalendarDayOrdinal(verifiedAt, timestamp, timeZone);
  if (ageDays < 0) return { due: true, reason: "invalid-verification", slot, ageDays };
  if (ageDays >= DESCRIPTION_INTEGRITY_MAXIMUM_AGE_DAYS) {
    return { due: true, reason: "maximum-age", slot, ageDays };
  }
  if (ageDays < DESCRIPTION_INTEGRITY_MINIMUM_AGE_DAYS) {
    return { due: false, reason: "not-eligible", slot, ageDays };
  }
  const currentSlot = modulo(calendarDayOrdinal(now, timeZone), DESCRIPTION_INTEGRITY_SLOT_COUNT);
  if (currentSlot === slot) return { due: true, reason: "scheduled-slot", slot, ageDays };
  return { due: false, reason: "deferred", slot, ageDays };
}

export function managedDescriptionHash(
  markdown: string | undefined,
  version = DESCRIPTION_HASH_VERSION,
): string {
  const representation = managedBlockCanonicalRepresentation(descriptionBlocks(markdown ?? ""));
  return `${version}:${createHash("sha256").update(representation).digest("hex")}`;
}

export async function replaceManagedDescription(
  gateway: NotionGateway,
  pageId: string,
  markdown: string | undefined,
  onRecovery?: () => void,
  initialRootBlocks?: Block[],
): Promise<{ repaired: boolean; replaced: boolean }> {
  const snapshot = await createManagedSectionSnapshot(
    gateway,
    pageId,
    { managed: MANAGED_DESCRIPTION_TITLE, pending: PENDING_MANAGED_DESCRIPTION_TITLE },
    descriptionBlocks(markdown ?? ""),
    initialRootBlocks,
    onRecovery,
  );
  if (await verifyManagedSection(gateway, snapshot)) {
    return { repaired: false, replaced: false };
  }

  const result = await reconcileManagedSection(gateway, snapshot);
  return { repaired: true, replaced: result.replaced };
}

export interface TemplateWaitOptions {
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

async function templateSnapshot(
  gateway: NotionGateway,
  parentId: string,
): Promise<{ signature: string; blocks: Block[] }> {
  const blocks = await gateway.listBlocks(parentId);
  const values: unknown[] = [];
  for (const block of blocks) {
    const id = typeof block.id === "string" ? block.id : "";
    values.push([id, block.type ?? "", blockText(block), block.has_children === true]);
    if (id && block.has_children === true)
      values.push((await templateSnapshot(gateway, id)).signature);
  }
  return { signature: blocks.length ? JSON.stringify(values) : "", blocks };
}

export async function waitForTemplate(
  gateway: NotionGateway,
  pageId: string,
  options: TemplateWaitOptions = {},
): Promise<Block[]> {
  const attempts = options.attempts ?? 10;
  const delayMs = options.delayMs ?? 1000;
  const pause = options.sleep ?? sleep;
  let previous = "";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const current = await templateSnapshot(gateway, pageId);
    if (current.signature && current.signature === previous) return current.blocks;
    previous = current.signature;
    if (attempt < attempts - 1) await pause(delayMs);
  }
  throw new Error(`Default template did not stabilize for assignment page ${pageId}`);
}
