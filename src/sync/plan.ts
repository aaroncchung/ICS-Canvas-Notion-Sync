import type {
  AssignmentFeed,
  AssignmentPropertyUpdate,
  AssignmentRecord,
  CourseRecord,
  FeedDiagnosticSummary,
  PlanWarning,
  PlanningOperationCounters,
  RunMetrics,
  SyncPlan,
  Trigger,
} from "../types.js";
import { descriptionExcerpt } from "../notion/assignments.js";
import { descriptionIntegrityAuditDue, managedDescriptionHash } from "../notion/descriptions.js";
import {
  addCanvasCourseIdToIndex,
  addCourseToIndex,
  buildCourseIndex,
  matchCourseFromIndex,
  type CourseMatch,
} from "./course-matcher.js";
import { datesEqual, resolveDates } from "./date-resolution.js";
import { buildAssignmentIndex, possibleDuplicateFromIndex } from "./duplicate-detector.js";
import { absenceRemovalSafe, detectRemovals } from "./removal-detector.js";

function sameOptional(left?: string, right?: string): boolean {
  return (left ?? undefined) === (right ?? undefined);
}

function lifecycleProperties(existing: AssignmentRecord): {
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

function lifecycleOnlyProperties(properties: AssignmentPropertyUpdate): AssignmentPropertyUpdate {
  return {
    ...(properties.removed !== undefined ? { removed: properties.removed } : {}),
    ...(properties.canvasState !== undefined ? { canvasState: properties.canvasState } : {}),
    ...(properties.canvasMissingSince !== undefined
      ? { canvasMissingSince: properties.canvasMissingSince }
      : {}),
    ...(properties.canvasMissingCount !== undefined
      ? { canvasMissingCount: properties.canvasMissingCount }
      : {}),
  };
}

function aggregateFeedDiagnostics(feed: AssignmentFeed): {
  ignored: number;
  suspiciousReasons: string[];
  malformed: number;
  duplicate: number;
} {
  let ignored = 0;
  let malformed = 0;
  let duplicate = 0;
  const suspiciousReasons: string[] = [];
  for (const event of feed.diagnostics.events) {
    switch (event.kind) {
      case "ignored":
        ignored += 1;
        break;
      case "suspicious":
        suspiciousReasons.push(event.reason);
        break;
      case "malformed":
        malformed += 1;
        break;
      case "duplicate":
        duplicate += 1;
        break;
      case "cancelled":
        break;
    }
  }
  return { ignored, suspiciousReasons, malformed, duplicate };
}

export function feedDiagnosticSummary(feed: AssignmentFeed): FeedDiagnosticSummary {
  const diagnostics = aggregateFeedDiagnostics(feed);
  return {
    totalEvents: feed.diagnostics.totalEvents,
    activeAssignments: feed.assignments.length,
    cancelledAssignments: feed.cancelledAssignments.length,
    ignoredEvents: diagnostics.ignored,
    suspiciousEvents: diagnostics.suspiciousReasons.length,
    malformedEvents: diagnostics.malformed,
    duplicateUids: diagnostics.duplicate,
    quarantinedUids: feed.diagnostics.quarantinedUids.length,
    absenceRemovalSafe: absenceRemovalSafe(feed),
  };
}

export function feedWarnings(feed: AssignmentFeed): PlanWarning[] {
  const warnings: PlanWarning[] = [];
  const diagnostics = aggregateFeedDiagnostics(feed);
  if (!feed.diagnostics.complete) {
    warnings.push({
      code: "incomplete-feed-diagnostics",
      message: "The provider reported incomplete feed diagnostics",
    });
  }
  if (feed.diagnostics.totalEvents >= 1000) {
    warnings.push({
      code: "feed-event-limit",
      message: "The feed reached the safety limit of 1,000 events",
    });
  }
  if (diagnostics.duplicate) {
    warnings.push({
      code: "duplicate-source-uids",
      message: `${diagnostics.duplicate} duplicate source UID(s) were quarantined`,
      details: Array.from({ length: diagnostics.duplicate }, () => "duplicate UID redacted"),
    });
  }
  if (diagnostics.malformed) {
    warnings.push({
      code: "malformed-events",
      message: `${diagnostics.malformed} malformed assignment-like event(s) were quarantined`,
    });
  }
  if (diagnostics.suspiciousReasons.length) {
    warnings.push({
      code: "suspicious-feed-events",
      message: `${diagnostics.suspiciousReasons.length} assignment-like event(s) were quarantined`,
      details: diagnostics.suspiciousReasons,
    });
  }
  return warnings;
}

export function buildPlan(
  feed: AssignmentFeed,
  existingAssignments: AssignmentRecord[],
  courses: CourseRecord[],
  aliases: Record<string, string>,
  disableRemovals: boolean,
  notionTimezone: string,
  now = new Date(),
  metrics?: RunMetrics,
  trigger: Trigger = "scheduled",
  minimumMissingIntervalMs?: number,
  operationCounters?: PlanningOperationCounters,
): SyncPlan {
  const planTimestamp = now.toISOString();
  const plannedCourseRecords = courses.map((course) => ({ ...course }));
  const courseKeysByPageId = new Map<string, string>(
    courses.map((course) => [course.pageId, `page:${course.pageId}`] as const),
  );
  let courseIndex = buildCourseIndex(
    plannedCourseRecords,
    aliases,
    operationCounters,
    courseKeysByPageId,
  );
  const originalCourseIndex = buildCourseIndex(
    courses.map((course) => ({ ...course })),
    aliases,
  );
  const assignmentIndex = buildAssignmentIndex(
    existingAssignments,
    courseIndex,
    notionTimezone,
    operationCounters,
  );
  const plan: SyncPlan = {
    coursesToCreate: [],
    coursesToUpdate: [],
    assignmentsToCreate: [],
    assignmentsToUpdate: [],
    assignmentsMissingEvidenceToUpdate: [],
    assignmentsToRemove: [],
    missingCandidatesObserved: 0,
    unchanged: 0,
    skipped: 0,
    warnings: feedWarnings(feed),
  };
  const byUid = assignmentIndex.byUid;
  const plannedCourseUpdates = new Map<string, SyncPlan["coursesToUpdate"][number]>();
  const conflictedCourseKeys = new Set<string>();
  const unnamedCourseWarnings = new Map<string, PlanWarning>();
  const assignmentsAlreadySkippedForCourse = new Set<string>();
  const protectedPageIds = new Set<string>();
  const removalsByPageId = new Map<string, SyncPlan["assignmentsToRemove"][number]>();
  const plannedAssignmentUpdates = new Map<string, SyncPlan["assignmentsToUpdate"][number]>();

  function rebuildCourseIndex(): void {
    courseIndex = buildCourseIndex(
      plannedCourseRecords,
      aliases,
      operationCounters,
      courseKeysByPageId,
    );
  }

  function updatePlannedCourseRecord(
    courseKey: string,
    update: { canvasCourseId?: string; canvasUrl?: string; syncUpdatedAt?: string },
  ): void {
    const record = plannedCourseRecords.find(
      (candidate) => courseKeysByPageId.get(candidate.pageId) === courseKey,
    );
    if (!record) return;
    if (update.canvasCourseId && !record.canvasCourseId) {
      record.canvasCourseId = update.canvasCourseId;
      addCanvasCourseIdToIndex(courseIndex, record, update.canvasCourseId);
    }
    if (update.canvasUrl) record.url = update.canvasUrl;
    if (update.syncUpdatedAt) record.syncUpdatedAt = update.syncUpdatedAt;
  }

  function redirectPlannedCourse(fromKey: string, toKey: string): void {
    const recordIndex = plannedCourseRecords.findIndex(
      (candidate) => courseKeysByPageId.get(candidate.pageId) === fromKey,
    );
    if (recordIndex >= 0) {
      const [record] = plannedCourseRecords.splice(recordIndex, 1);
      if (record) courseKeysByPageId.delete(record.pageId);
    }
    const createIndex = plan.coursesToCreate.findIndex((course) => course.key === fromKey);
    if (createIndex >= 0) plan.coursesToCreate.splice(createIndex, 1);
    for (const assignment of plan.assignmentsToCreate) {
      if (assignment.courseKey === fromKey) assignment.courseKey = toKey;
    }
    for (const [pageId, assignment] of plannedAssignmentUpdates) {
      if (assignment.courseKey === fromKey) {
        plannedAssignmentUpdates.set(pageId, { ...assignment, courseKey: toKey });
      }
    }
    const warning = unnamedCourseWarnings.get(fromKey);
    if (warning) {
      const warningIndex = plan.warnings.indexOf(warning);
      if (warningIndex >= 0) plan.warnings.splice(warningIndex, 1);
      unnamedCourseWarnings.delete(fromKey);
    }
    rebuildCourseIndex();
  }

  function reconcileProvisionalMatch(
    source: AssignmentFeed["assignments"][number],
    match: CourseMatch,
  ): CourseMatch {
    if (match.kind !== "matched" || match.courseKey.startsWith("page:")) return match;
    const existingMatch = matchCourseFromIndex(source, originalCourseIndex, planTimestamp);
    if (existingMatch.kind === "create" || existingMatch.kind === "unidentified") return match;
    if (existingMatch.kind === "matched") {
      redirectPlannedCourse(match.courseKey, existingMatch.courseKey);
    }
    return existingMatch;
  }

  function queueAssignmentUpdate(update: SyncPlan["assignmentsToUpdate"][number]): void {
    const current = plannedAssignmentUpdates.get(update.pageId);
    if (!current) {
      plannedAssignmentUpdates.set(update.pageId, update);
      return;
    }
    plannedAssignmentUpdates.set(update.pageId, {
      ...current,
      properties: { ...current.properties, ...update.properties },
      verifyDescription: current.verifyDescription || update.verifyDescription,
      descriptionHash: update.verifyDescription ? update.descriptionHash : current.descriptionHash,
      descriptionHashNeedsUpdate: Boolean(
        current.descriptionHashNeedsUpdate || update.descriptionHashNeedsUpdate,
      ),
      missingEvidenceCleared: current.missingEvidenceCleared || update.missingEvidenceCleared,
    });
  }

  function queueLifecycleUpdate(
    source: AssignmentFeed["assignments"][number],
    existing: AssignmentRecord,
  ): void {
    const lifecycle = lifecycleProperties(existing);
    if (!Object.keys(lifecycle.properties).length) return;
    queueAssignmentUpdate({
      pageId: existing.pageId,
      source,
      courseKey: `page:${existing.coursePageIds[0] ?? ""}`,
      properties: lifecycle.properties,
      verifyDescription: false,
      descriptionHash:
        existing.descriptionHash ?? managedDescriptionHash(source.descriptionMarkdown),
      descriptionHashNeedsUpdate: false,
      missingEvidenceCleared: lifecycle.missingEvidenceCleared,
    });
  }

  for (const source of feed.cancelledAssignments) {
    const uidMatches = byUid.get(source.uid) ?? [];
    if (uidMatches.length > 1) {
      plan.skipped += 1;
      for (const assignment of uidMatches) protectedPageIds.add(assignment.pageId);
      plan.warnings.push({
        code: "duplicate-notion-uid",
        message:
          "A cancelled assignment UID maps to multiple Notion pages; all ambiguous pages were preserved",
        details: uidMatches.map((assignment) => assignment.pageId),
      });
      continue;
    }
    const existing = uidMatches[0];
    if (existing) {
      if (disableRemovals) {
        plan.skipped += 1;
      } else if (
        existing.removed &&
        existing.canvasState === "Removed" &&
        !existing.canvasMissingSince &&
        existing.canvasMissingCount === undefined
      ) {
        plan.unchanged += 1;
      } else {
        removalsByPageId.set(existing.pageId, {
          ...existing,
          reason: "explicit-cancellation",
          markRemoved: !existing.removed || existing.canvasState !== "Removed",
          clearMissingEvidence:
            Boolean(existing.canvasMissingSince) || existing.canvasMissingCount !== undefined,
        });
      }
      continue;
    }

    const match = matchCourseFromIndex(source, courseIndex, planTimestamp);
    const duplicates = possibleDuplicateFromIndex(
      source,
      assignmentIndex,
      match.kind === "matched" && match.courseKey.startsWith("page:")
        ? match.course.pageId
        : undefined,
    );
    plan.skipped += 1;
    if (duplicates.length) {
      for (const assignment of duplicates) protectedPageIds.add(assignment.pageId);
      plan.warnings.push({
        code: "possible-assignment-duplicate",
        message: "A cancelled new UID resembles an existing assignment; no pages were merged",
        details: duplicates.map((assignment) => assignment.pageId),
      });
    } else {
      plan.warnings.push({
        code: "new-cancelled-assignment",
        message: "A cancelled assignment was not previously managed and needs review",
      });
    }
  }

  for (const source of feed.assignments) {
    const uidMatches = byUid.get(source.uid) ?? [];
    if (uidMatches.length > 1) {
      plan.skipped += 1;
      for (const assignment of uidMatches) protectedPageIds.add(assignment.pageId);
      plan.warnings.push({
        code: "duplicate-notion-uid",
        message:
          "An assignment UID maps to multiple Notion pages; all ambiguous pages were preserved",
        details: uidMatches.map((assignment) => assignment.pageId),
      });
      continue;
    }
    const existing = uidMatches[0];
    let match = matchCourseFromIndex(source, courseIndex, planTimestamp);
    match = reconcileProvisionalMatch(source, match);
    if (uidMatches.length === 0) {
      const duplicates = possibleDuplicateFromIndex(
        source,
        assignmentIndex,
        match.kind === "matched" && match.courseKey.startsWith("page:")
          ? match.course.pageId
          : undefined,
      );
      if (duplicates.length) {
        plan.skipped += 1;
        for (const assignment of duplicates) protectedPageIds.add(assignment.pageId);
        plan.warnings.push({
          code: "possible-assignment-duplicate",
          message: "A new UID strongly resembles an existing assignment; no pages were merged",
          details: duplicates.map((assignment) => assignment.pageId),
        });
        continue;
      }
    }

    if (match.kind === "ambiguous") {
      if (existing) queueLifecycleUpdate(source, existing);
      plan.skipped += 1;
      for (const assignment of uidMatches) protectedPageIds.add(assignment.pageId);
      plan.warnings.push({
        code: "ambiguous-course",
        message:
          match.method === "configured-alias"
            ? "Applicable configured-alias mappings resolved to multiple courses; assignment changes were blocked"
            : `Multiple courses matched at the ${match.method} confidence level`,
        details: match.courses.map((course) => course.pageId),
      });
      continue;
    }
    if (match.kind === "unidentified") {
      if (existing) queueLifecycleUpdate(source, existing);
      plan.skipped += 1;
      for (const assignment of uidMatches) protectedPageIds.add(assignment.pageId);
      plan.warnings.push({
        code: "unidentified-course",
        message: "An assignment had no course ID, name, or code and was preserved without changes",
        details: uidMatches.map((assignment) => assignment.pageId),
      });
      continue;
    }
    if (match.kind === "conflict") {
      if (existing) {
        queueLifecycleUpdate(source, existing);
        assignmentsAlreadySkippedForCourse.add(existing.pageId);
      }
      plan.skipped += 1;
      if (!conflictedCourseKeys.has(match.courseKey) && metrics) {
        metrics.coursesConflicted += 1;
      }
      conflictedCourseKeys.add(match.courseKey);
      plannedCourseUpdates.delete(match.course.pageId);
      if (!match.courseKey.startsWith("page:")) {
        plan.coursesToCreate = plan.coursesToCreate.filter(
          (course) => course.key !== match.courseKey,
        );
      }
      for (const assignment of uidMatches) protectedPageIds.add(assignment.pageId);
      plan.warnings.push({
        code: "course-metadata-conflict",
        message: `Course metadata conflicted in ${match.fields.join(" and ")}; assignment work was blocked`,
        details: [match.course.pageId],
      });
      continue;
    }
    if (match.kind === "matched" && conflictedCourseKeys.has(match.courseKey)) {
      if (existing) {
        queueLifecycleUpdate(source, existing);
        assignmentsAlreadySkippedForCourse.add(existing.pageId);
      }
      plan.skipped += 1;
      for (const assignment of uidMatches) protectedPageIds.add(assignment.pageId);
      continue;
    }
    if (match.kind === "matched" && match.update) {
      if (!match.courseKey.startsWith("page:")) {
        const createIndex = plan.coursesToCreate.findIndex(
          (course) => course.key === match.courseKey,
        );
        const current = plan.coursesToCreate[createIndex];
        if (current) {
          plan.coursesToCreate[createIndex] = {
            ...current,
            ...(match.update.canvasCourseId ? { canvasCourseId: match.update.canvasCourseId } : {}),
            ...(match.update.canvasUrl ? { canvasUrl: match.update.canvasUrl } : {}),
          };
          updatePlannedCourseRecord(match.courseKey, match.update);
        }
      } else {
        const current = plannedCourseUpdates.get(match.course.pageId) ?? {
          pageId: match.course.pageId,
        };
        const conflictsWithPlannedUpdate =
          Boolean(
            current.canvasCourseId &&
              match.update.canvasCourseId &&
              current.canvasCourseId !== match.update.canvasCourseId,
          ) ||
          Boolean(
            current.canvasUrl &&
              match.update.canvasUrl &&
              current.canvasUrl !== match.update.canvasUrl,
          );
        if (conflictsWithPlannedUpdate) {
          if (existing) {
            queueLifecycleUpdate(source, existing);
            assignmentsAlreadySkippedForCourse.add(existing.pageId);
          }
          if (!conflictedCourseKeys.has(match.courseKey) && metrics) {
            metrics.coursesConflicted += 1;
          }
          conflictedCourseKeys.add(match.courseKey);
          plannedCourseUpdates.delete(match.course.pageId);
          for (const assignment of uidMatches) protectedPageIds.add(assignment.pageId);
          plan.skipped += 1;
          plan.warnings.push({
            code: "course-metadata-conflict",
            message: "Multiple source assignments supplied conflicting metadata for one course",
            details: [match.course.pageId],
          });
          continue;
        }
        const merged = { ...current, ...match.update };
        plannedCourseUpdates.set(match.course.pageId, merged);
        updatePlannedCourseRecord(match.courseKey, merged);
      }
    }
    const courseKey = match.kind === "matched" ? match.courseKey : match.course.key;
    if (match.kind === "create") {
      plan.coursesToCreate.push(match.course);
      const pageId = `planned-course:${plan.coursesToCreate.length}`;
      plannedCourseRecords.push({
        pageId,
        title: match.course.title,
        ...(match.course.courseCode ? { courseCode: match.course.courseCode } : {}),
        ...(match.course.canvasCourseId ? { canvasCourseId: match.course.canvasCourseId } : {}),
        ...(match.course.canvasUrl ? { url: match.course.canvasUrl } : {}),
      });
      courseKeysByPageId.set(pageId, courseKey);
      addCourseToIndex(courseIndex, plannedCourseRecords.at(-1)!, courseKey);
      if (!source.courseName && !source.courseCode) {
        const warning: PlanWarning = {
          code: "unnamed-course",
          message: "A course lacked a usable name and will use a generated Canvas Course label",
        };
        unnamedCourseWarnings.set(courseKey, warning);
        plan.warnings.push(warning);
      }
    }

    if (!existing) {
      plan.assignmentsToCreate.push({ source, courseKey });
      continue;
    }

    const lifecycle = lifecycleProperties(existing);
    const properties: AssignmentPropertyUpdate = { ...lifecycle.properties };
    const matchedPageId =
      match.kind === "matched" && match.courseKey.startsWith("page:")
        ? match.course.pageId
        : undefined;
    if (matchedPageId && !existing.coursePageIds.includes(matchedPageId)) {
      properties.coursePageId = matchedPageId;
    } else if (match.kind === "create") {
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
    const verifyDescription =
      descriptionHashNeedsUpdate ||
      descriptionIntegrityAuditDue(existing.descriptionVerifiedAt, now);
    if (!verifyDescription && metrics) {
      metrics.descriptionUpdatesAvoided += 1;
      metrics.descriptionBodyReadsAvoided += 1;
    }
    if (excerptChanged) properties.rawDescription = excerpt;
    if (Object.keys(properties).length || verifyDescription) {
      queueAssignmentUpdate({
        pageId: existing.pageId,
        source,
        courseKey,
        properties,
        verifyDescription,
        descriptionHash,
        descriptionHashNeedsUpdate,
        missingEvidenceCleared: lifecycle.missingEvidenceCleared,
      });
    } else {
      plan.unchanged += 1;
    }
  }

  plan.assignmentsToUpdate = [...plannedAssignmentUpdates.values()];

  if (conflictedCourseKeys.size) {
    const blockedCreates = plan.assignmentsToCreate.filter((assignment) =>
      conflictedCourseKeys.has(assignment.courseKey),
    );
    let blockedUpdatesNotAlreadySkipped = 0;
    plan.assignmentsToUpdate = plan.assignmentsToUpdate.flatMap((assignment) => {
      if (!conflictedCourseKeys.has(assignment.courseKey)) {
        return [assignment];
      }
      protectedPageIds.add(assignment.pageId);
      if (!assignmentsAlreadySkippedForCourse.has(assignment.pageId)) {
        blockedUpdatesNotAlreadySkipped += 1;
      }
      const properties = lifecycleOnlyProperties(assignment.properties);
      return Object.keys(properties).length
        ? [
            {
              ...assignment,
              properties,
              verifyDescription: false,
              descriptionHashNeedsUpdate: false,
            },
          ]
        : [];
    });
    plan.skipped += blockedCreates.length + blockedUpdatesNotAlreadySkipped;
    plan.assignmentsToCreate = plan.assignmentsToCreate.filter(
      (assignment) => !blockedCreates.includes(assignment),
    );
  }

  const removal = detectRemovals(
    feed,
    existingAssignments,
    disableRemovals,
    protectedPageIds,
    trigger,
    now,
    minimumMissingIntervalMs,
    planTimestamp,
  );
  for (const assignment of removal.removals) removalsByPageId.set(assignment.pageId, assignment);
  plan.assignmentsMissingEvidenceToUpdate = removal.missingEvidenceUpdates;
  plan.assignmentsToRemove = [...removalsByPageId.values()];
  plan.missingCandidatesObserved = removal.newlyObserved;
  plan.coursesToUpdate = [...plannedCourseUpdates.values()];
  plan.warnings.push(...removal.warnings);
  return plan;
}
