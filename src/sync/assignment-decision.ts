import type {
  AssignmentPropertyUpdate,
  AssignmentRecord,
  AssignmentUpdate,
  ExternalAssignment,
} from "../types.js";
import { descriptionExcerpt } from "../notion/assignments.js";
import {
  descriptionIntegrityAuditDecision,
  managedDescriptionHash,
} from "../notion/descriptions.js";
import { datesEqual, resolveDates } from "./date-resolution.js";

function sameOptional(left?: string, right?: string): boolean {
  return left === right;
}

export function lifecycleProperties(existing: AssignmentRecord): {
  properties: AssignmentPropertyUpdate;
  missingEvidenceCleared: boolean;
} {
  const properties: AssignmentPropertyUpdate = {};
  if (existing.removed || existing.canvasState !== "Active") {
    properties.removed = false;
    properties.canvasState = "Active";
  }
  const missingEvidenceCleared =
    Boolean(existing.canvasMissingSince) || existing.canvasMissingCount !== undefined;
  if (missingEvidenceCleared) {
    properties.canvasMissingSince = null;
    properties.canvasMissingCount = null;
  }
  return { properties, missingEvidenceCleared };
}

export function lifecycleUpdate(
  source: ExternalAssignment,
  existing: AssignmentRecord,
): AssignmentUpdate | undefined {
  const lifecycle = lifecycleProperties(existing);
  if (!Object.keys(lifecycle.properties).length) return;
  return {
    pageId: existing.pageId,
    source,
    courseKey: `page:${existing.coursePageIds[0] ?? ""}`,
    properties: lifecycle.properties,
    verifyDescription: false,
    descriptionHash: existing.descriptionHash ?? managedDescriptionHash(source.descriptionMarkdown),
    descriptionHashNeedsUpdate: false,
    missingEvidenceCleared: lifecycle.missingEvidenceCleared,
  };
}

export function decideAssignment(
  source: ExternalAssignment,
  existing: AssignmentRecord,
  course: { courseKey: string; pageId?: string },
  notionTimezone: string,
  now: Date,
): { update?: AssignmentUpdate; deferred: boolean } {
  const courseKey = course.courseKey;
  const lifecycle = lifecycleProperties(existing);
  const properties: AssignmentPropertyUpdate = { ...lifecycle.properties };
  if (!course.pageId || !existing.coursePageIds.includes(course.pageId)) {
    properties.coursePageId = courseKey;
  }
  if (existing.title !== source.title) properties.title = source.title;
  if (!sameOptional(existing.canvasUrl, source.canvasUrl)) {
    properties.canvasUrl = source.canvasUrl ?? null;
  }

  const dates = resolveDates(existing, source.dueAt, notionTimezone);
  if (!datesEqual(existing.canvasDueDate, source.dueAt, notionTimezone)) {
    properties.canvasDueDate = source.dueAt ?? null;
  }
  if (!datesEqual(existing.effectiveDueDate, dates.effectiveDueDate, notionTimezone)) {
    properties.effectiveDueDate = dates.effectiveDueDate ?? null;
  }
  if (dates.overrideChanged) properties.overrideDueDate = dates.overrideDueDate ?? null;

  const excerpt = descriptionExcerpt(source);
  const excerptChanged = (existing.descriptionExcerpt ?? "") !== excerpt;
  const descriptionHash = managedDescriptionHash(source.descriptionMarkdown);
  const descriptionHashNeedsUpdate = existing.descriptionHash !== descriptionHash;
  const auditDecision = descriptionHashNeedsUpdate
    ? undefined
    : descriptionIntegrityAuditDecision(
        source.uid || existing.pageId,
        existing.descriptionVerifiedAt,
        notionTimezone,
        now,
      );
  const verifyDescription = descriptionHashNeedsUpdate || auditDecision?.due === true;
  if (excerptChanged) properties.rawDescription = excerpt;
  if (Object.keys(properties).length || verifyDescription) {
    return {
      update: {
        pageId: existing.pageId,
        source,
        courseKey,
        properties,
        verifyDescription,
        descriptionHash,
        descriptionHashNeedsUpdate,
        missingEvidenceCleared: lifecycle.missingEvidenceCleared,
      },
      deferred: auditDecision?.reason === "deferred",
    };
  }
  return { deferred: auditDecision?.reason === "deferred" };
}
