import type {
  AssignmentFeed,
  AssignmentPropertyUpdate,
  AssignmentRecord,
  CourseRecord,
  FeedDiagnosticSummary,
  PlanWarning,
  RunMetrics,
  SyncPlan,
} from "../types.js";
import { descriptionExcerpt } from "../notion/assignments.js";
import { managedDescriptionHash } from "../notion/descriptions.js";
import { matchCourse } from "./course-matcher.js";
import { datesEqual, resolveDates } from "./date-resolution.js";
import { possibleDuplicate } from "./duplicate-detector.js";
import { absenceRemovalSafe, detectRemovals } from "./removal-detector.js";

function sameOptional(left?: string, right?: string): boolean {
  return (left ?? undefined) === (right ?? undefined);
}

export function feedDiagnosticSummary(feed: AssignmentFeed): FeedDiagnosticSummary {
  const count = (kind: AssignmentFeed["diagnostics"]["events"][number]["kind"]) =>
    feed.diagnostics.events.filter((event) => event.kind === kind).length;
  return {
    totalEvents: feed.diagnostics.totalEvents,
    activeAssignments: feed.assignments.length,
    cancelledAssignments: feed.cancelledAssignments.length,
    ignoredEvents: count("ignored"),
    suspiciousEvents: count("suspicious"),
    malformedEvents: count("malformed"),
    duplicateUids: count("duplicate"),
    quarantinedUids: feed.diagnostics.quarantinedUids.length,
    absenceRemovalSafe: absenceRemovalSafe(feed),
  };
}

export function feedWarnings(feed: AssignmentFeed): PlanWarning[] {
  const warnings: PlanWarning[] = [];
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
  const duplicateEvents = feed.diagnostics.events.filter((event) => event.kind === "duplicate");
  if (duplicateEvents.length) {
    warnings.push({
      code: "duplicate-source-uids",
      message: `${duplicateEvents.length} duplicate source UID(s) were quarantined`,
      details: duplicateEvents.map(() => "duplicate UID redacted"),
    });
  }
  const malformedEvents = feed.diagnostics.events.filter((event) => event.kind === "malformed");
  if (malformedEvents.length) {
    warnings.push({
      code: "malformed-events",
      message: `${malformedEvents.length} malformed assignment-like event(s) were quarantined`,
    });
  }
  const suspiciousEvents = feed.diagnostics.events.filter((event) => event.kind === "suspicious");
  if (suspiciousEvents.length) {
    warnings.push({
      code: "suspicious-feed-events",
      message: `${suspiciousEvents.length} assignment-like event(s) were quarantined`,
      details: suspiciousEvents.map((event) => event.reason),
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
  now = new Date(),
  metrics?: RunMetrics,
): SyncPlan {
  const plan: SyncPlan = {
    coursesToCreate: [],
    coursesToUpdate: [],
    assignmentsToCreate: [],
    assignmentsToUpdate: [],
    assignmentsToRemove: [],
    unchanged: 0,
    skipped: 0,
    warnings: feedWarnings(feed),
  };
  const byUid = new Map<string, AssignmentRecord[]>();
  for (const assignment of existingAssignments) {
    const values = byUid.get(assignment.uid) ?? [];
    values.push(assignment);
    byUid.set(assignment.uid, values);
  }
  const plannedCourseKeys = new Set<string>();
  const plannedCourseUpdates = new Map<string, SyncPlan["coursesToUpdate"][number]>();
  const conflictedCoursePageIds = new Set<string>();
  const protectedPageIds = new Set<string>();
  const cancelledRemovals = new Map<string, AssignmentRecord>();

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
      } else if (existing.removed && existing.canvasState === "Removed") {
        plan.unchanged += 1;
      } else {
        cancelledRemovals.set(existing.pageId, existing);
      }
      continue;
    }

    const match = matchCourse(source, courses, aliases);
    const duplicates = possibleDuplicate(
      source,
      existingAssignments,
      courses,
      match.kind === "matched" ? match.course.pageId : undefined,
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
    const match = matchCourse(source, courses, aliases);
    if (uidMatches.length === 0) {
      const duplicates = possibleDuplicate(
        source,
        existingAssignments,
        courses,
        match.kind === "matched" ? match.course.pageId : undefined,
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
      plan.skipped += 1;
      for (const assignment of uidMatches) protectedPageIds.add(assignment.pageId);
      plan.warnings.push({
        code: "ambiguous-course",
        message: `Multiple courses matched at the ${match.method} confidence level`,
        details: match.courses.map((course) => course.pageId),
      });
      continue;
    }
    if (match.kind === "unidentified") {
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
      plan.skipped += 1;
      if (!conflictedCoursePageIds.has(match.course.pageId) && metrics) {
        metrics.coursesConflicted += 1;
      }
      conflictedCoursePageIds.add(match.course.pageId);
      plannedCourseUpdates.delete(match.course.pageId);
      for (const assignment of uidMatches) protectedPageIds.add(assignment.pageId);
      plan.warnings.push({
        code: "course-metadata-conflict",
        message: `Course metadata conflicted in ${match.fields.join(" and ")}; assignment work was blocked`,
        details: [match.course.pageId],
      });
      continue;
    }
    if (match.kind === "matched" && conflictedCoursePageIds.has(match.course.pageId)) {
      plan.skipped += 1;
      for (const assignment of uidMatches) protectedPageIds.add(assignment.pageId);
      continue;
    }
    if (match.kind === "matched" && match.update) {
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
        if (!conflictedCoursePageIds.has(match.course.pageId) && metrics) {
          metrics.coursesConflicted += 1;
        }
        conflictedCoursePageIds.add(match.course.pageId);
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
    }
    const courseKey = match.kind === "matched" ? `page:${match.course.pageId}` : match.course.key;
    if (match.kind === "create" && !plannedCourseKeys.has(courseKey)) {
      plannedCourseKeys.add(courseKey);
      plan.coursesToCreate.push(match.course);
      if (!source.courseName && !source.courseCode) {
        plan.warnings.push({
          code: "unnamed-course",
          message: "A course lacked a usable name and will use a generated Canvas Course label",
        });
      }
    }

    const existing = uidMatches[0];
    if (!existing) {
      plan.assignmentsToCreate.push({ source, courseKey });
      continue;
    }

    const properties: AssignmentPropertyUpdate = {};
    const matchedPageId = match.kind === "matched" ? match.course.pageId : undefined;
    if (matchedPageId && !existing.coursePageIds.includes(matchedPageId)) {
      properties.coursePageId = matchedPageId;
    } else if (match.kind === "create") {
      properties.coursePageId = courseKey;
    }
    if (existing.title !== source.title) properties.title = source.title;
    if (!sameOptional(existing.canvasUrl, source.canvasUrl)) {
      properties.canvasUrl = source.canvasUrl ?? null;
    }

    const dates = resolveDates(existing, source.dueAt);
    if (!datesEqual(existing.canvasDueDate, source.dueAt)) {
      properties.canvasDueDate = source.dueAt ?? null;
    }
    if (!datesEqual(existing.effectiveDueDate, dates.effectiveDueDate)) {
      properties.effectiveDueDate = dates.effectiveDueDate ?? null;
    }
    if (dates.overrideChanged) properties.overrideDueDate = dates.overrideDueDate ?? null;

    const excerpt = descriptionExcerpt(source);
    const excerptChanged = (existing.descriptionExcerpt ?? "") !== excerpt;
    const descriptionHash = managedDescriptionHash(source.descriptionMarkdown);
    const verifyDescription = existing.descriptionHash !== descriptionHash;
    if (!verifyDescription && metrics) metrics.descriptionUpdatesAvoided += 1;
    if (excerptChanged) properties.rawDescription = excerpt;
    const needsReactivation = existing.removed || existing.canvasState !== "Active";
    if (needsReactivation) {
      properties.removed = false;
      properties.canvasState = "Active";
    }
    if (Object.keys(properties).length || verifyDescription) {
      plan.assignmentsToUpdate.push({
        pageId: existing.pageId,
        source,
        courseKey,
        properties,
        verifyDescription,
        descriptionHash,
      });
    } else {
      plan.unchanged += 1;
    }
  }

  if (conflictedCoursePageIds.size) {
    const blockedCreates = plan.assignmentsToCreate.filter((assignment) =>
      conflictedCoursePageIds.has(assignment.courseKey.replace(/^page:/, "")),
    );
    const blockedUpdates = plan.assignmentsToUpdate.filter((assignment) =>
      conflictedCoursePageIds.has(assignment.courseKey.replace(/^page:/, "")),
    );
    for (const assignment of blockedUpdates) protectedPageIds.add(assignment.pageId);
    plan.skipped += blockedCreates.length + blockedUpdates.length;
    plan.assignmentsToCreate = plan.assignmentsToCreate.filter(
      (assignment) => !blockedCreates.includes(assignment),
    );
    plan.assignmentsToUpdate = plan.assignmentsToUpdate.filter(
      (assignment) => !blockedUpdates.includes(assignment),
    );
  }

  const removal = detectRemovals(feed, existingAssignments, disableRemovals, protectedPageIds, now);
  for (const assignment of removal.removals) cancelledRemovals.set(assignment.pageId, assignment);
  plan.assignmentsToRemove = [...cancelledRemovals.values()];
  plan.coursesToUpdate = [...plannedCourseUpdates.values()];
  plan.warnings.push(...removal.warnings);
  return plan;
}
