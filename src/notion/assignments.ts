import type {
  AssignmentCreate,
  AssignmentPropertyUpdate,
  AssignmentRecord,
  ExternalAssignment,
  RecoveredCreate,
} from "../types.js";
import { AmbiguousNotionWriteError, isAmbiguousWriteError, type NotionGateway } from "./client.js";
import { readManagedDescription } from "./descriptions.js";
import { pollForUniquePage, type VisibilityPollingOptions } from "./recovery.js";
import {
  checkbox,
  date,
  pageId,
  pageProperties,
  readCheckbox,
  readDate,
  readRelation,
  readRichText,
  readSelect,
  readStatus,
  readTitle,
  readUrl,
  relation,
  select,
  status,
  text,
  title,
  url,
} from "./property-helpers.js";

export const DESCRIPTION_EXCERPT_LENGTH = 1900;

export function descriptionExcerpt(source: ExternalAssignment): string {
  return (source.descriptionPlainText ?? "").slice(0, DESCRIPTION_EXCERPT_LENGTH);
}

export async function readAssignments(
  gateway: NotionGateway,
  dataSourceId: string,
): Promise<AssignmentRecord[]> {
  const pages = await gateway.queryDataSource(dataSourceId, {
    property: "Imported From",
    select: { equals: "Canvas ICS" },
  });
  const assignments: AssignmentRecord[] = [];
  for (const page of pages) {
    const properties = pageProperties(page);
    const uid = readRichText(properties, "Canvas UID");
    if (!uid) continue;
    const canvasUrl = readUrl(properties, "Canvas URL");
    const canvasDueDate = readDate(properties, "Canvas Due Date");
    const effectiveDueDate = readDate(properties, "Effective Due Date");
    const overrideDueDate = readDate(properties, "Override Due Date");
    const storedDescription = readRichText(properties, "Raw Description");
    const personalStatus = readStatus(properties, "Personal Status");
    const priority = readSelect(properties, "Priority");
    const assignmentType = readSelect(properties, "Assignment Type");
    const canvasState = readSelect(properties, "Canvas State");
    const importedFrom = readSelect(properties, "Imported From");
    const id = pageId(page);
    const managedDescription = await readManagedDescription(gateway, id);
    assignments.push({
      pageId: id,
      uid,
      title: readTitle(properties, "Assignment"),
      coursePageIds: readRelation(properties, "Course"),
      ...(canvasUrl ? { canvasUrl } : {}),
      ...(canvasDueDate ? { canvasDueDate } : {}),
      ...(effectiveDueDate ? { effectiveDueDate } : {}),
      ...(overrideDueDate ? { overrideDueDate } : {}),
      ...(storedDescription ? { descriptionExcerpt: storedDescription } : {}),
      ...(managedDescription !== undefined ? { managedDescription } : {}),
      ...(personalStatus ? { personalStatus } : {}),
      ...(priority ? { priority } : {}),
      ...(assignmentType ? { assignmentType } : {}),
      removed: readCheckbox(properties, "Removed from Canvas"),
      ...(canvasState ? { canvasState } : {}),
      ...(importedFrom ? { importedFrom } : {}),
    });
  }
  return assignments;
}

export async function createAssignment(
  gateway: NotionGateway,
  dataSourceId: string,
  create: AssignmentCreate,
  coursePageId: string,
  timezone: string,
  recoveryOptions: VisibilityPollingOptions = {},
): Promise<RecoveredCreate> {
  const source = create.source;
  const properties: Record<string, unknown> = {
    Assignment: title(source.title),
    Course: relation(coursePageId),
    "Canvas UID": text(source.uid),
    "Personal Status": status("Not started"),
    "Assignment Type": select(source.inferredType),
    "Imported From": select("Canvas ICS"),
    "Canvas State": select("Active"),
    "Removed from Canvas": checkbox(false),
    "Raw Description": text(descriptionExcerpt(source)),
    "Last Synced": date(new Date().toISOString()),
  };
  if (source.canvasUrl) properties["Canvas URL"] = url(source.canvasUrl);
  if (source.dueAt) {
    properties["Canvas Due Date"] = date(source.dueAt);
    properties["Effective Due Date"] = date(source.dueAt);
  }
  try {
    return {
      pageId: await gateway.createPage(dataSourceId, properties, {
        useDefaultTemplate: true,
        templateTimezone: timezone,
      }),
      recovered: false,
    };
  } catch (error) {
    if (!isAmbiguousWriteError(error)) throw error;
    const match = await pollForUniquePage(
      () =>
        gateway.queryDataSource(dataSourceId, {
          property: "Canvas UID",
          rich_text: { equals: source.uid },
        }),
      (count) => `Assignment create is ambiguous: ${count} pages match the Canvas UID`,
      recoveryOptions,
    );
    if (match && typeof match.id === "string") return { pageId: match.id, recovered: true };
    throw new AmbiguousNotionWriteError(
      "Assignment create is ambiguous: no matching page became visible; creation was not retried",
    );
  }
}

export function buildUpdateProperties(update: AssignmentPropertyUpdate): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  if (update.title !== undefined) properties.Assignment = title(update.title);
  if (update.coursePageId !== undefined) properties.Course = relation(update.coursePageId);
  if (update.canvasUrl !== undefined) properties["Canvas URL"] = url(update.canvasUrl);
  if (update.canvasDueDate !== undefined) {
    properties["Canvas Due Date"] = date(update.canvasDueDate);
  }
  if (update.effectiveDueDate !== undefined) {
    properties["Effective Due Date"] = date(update.effectiveDueDate);
  }
  if (update.overrideDueDate !== undefined) {
    properties["Override Due Date"] = date(update.overrideDueDate);
  }
  if (update.rawDescription !== undefined) {
    properties["Raw Description"] = text(update.rawDescription);
  }
  if (update.removed !== undefined) properties["Removed from Canvas"] = checkbox(update.removed);
  if (update.canvasState !== undefined) properties["Canvas State"] = select(update.canvasState);
  if (Object.keys(properties).length) properties["Last Synced"] = date(new Date().toISOString());
  return properties;
}

export async function updateAssignment(
  gateway: NotionGateway,
  pageIdValue: string,
  update: AssignmentPropertyUpdate,
): Promise<void> {
  const properties = buildUpdateProperties(update);
  if (Object.keys(properties).length) await gateway.updatePage(pageIdValue, properties);
}
