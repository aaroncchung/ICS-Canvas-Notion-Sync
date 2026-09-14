import type {
  AssignmentFeed,
  AssignmentRecord,
  CourseRecord,
  ExternalAssignment,
  PlanningOperationCounters,
  SyncPlan,
  Trigger,
} from "../types.js";
import { CourseCatalog, type CourseResolution } from "./course-catalog.js";
import { buildCourseIndex, matchCourseFromIndex } from "./course-matcher.js";
import { buildAssignmentIndex, possibleDuplicateFromIndex } from "./duplicate-detector.js";
import { detectRemovals } from "./removal-detector.js";
import { decideAssignment, lifecycleUpdate } from "./assignment-decision.js";
import { feedWarnings } from "./feed-diagnostics.js";
export { feedWarnings, feedDiagnosticSummary } from "./feed-diagnostics.js";

function unidentifiedCourse(existing?: AssignmentRecord): CourseResolution {
  return {
    kind: "blocked",
    warning: {
      code: "unidentified-course",
      message: "An assignment had no course ID, name, or code and was preserved without changes",
      details: existing ? [existing.pageId] : [],
    },
  };
}

export function buildPlan(
  feed: AssignmentFeed,
  existingAssignments: AssignmentRecord[],
  courses: CourseRecord[],
  aliases: Record<string, string>,
  disableRemovals: boolean,
  notionTimezone: string,
  now = new Date(),
  trigger: Trigger = "scheduled",
  minimumMissingIntervalMs?: number,
): SyncPlan {
  const operationCounters: PlanningOperationCounters = {
    courseNormalizations: 0,
    courseCandidatesExamined: 0,
    assignmentNormalizations: 0,
    assignmentCandidatesExamined: 0,
  };
  const timestamp = now.toISOString();
  const courseIndex = buildCourseIndex(courses, aliases);
  const assignments = buildAssignmentIndex(
    existingAssignments,
    courseIndex,
    notionTimezone,
    operationCounters,
  );
  const catalog = new CourseCatalog(courses, aliases, timestamp, operationCounters);
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
  const protectedPages = new Set<string>();
  // Duplicate destination identities are protected even when their UID is absent from this feed.
  for (const matches of assignments.byUid.values()) {
    if (matches.length > 1) for (const record of matches) protectedPages.add(record.pageId);
  }
  function duplicateUid(source: ExternalAssignment, cancelled: boolean): boolean {
    const matches = assignments.byUid.get(source.uid) ?? [];
    if (matches.length <= 1) return false;
    plan.skipped += 1;
    plan.warnings.push({
      code: "duplicate-notion-uid",
      message: cancelled
        ? "A cancelled assignment UID maps to multiple Notion pages; all ambiguous pages were preserved"
        : "An assignment UID maps to multiple Notion pages; all ambiguous pages were preserved",
      details: matches.map((record) => record.pageId),
    });
    return true;
  }
  function possibleDuplicate(
    source: ExternalAssignment,
    pageId?: string,
    cancelled = false,
  ): boolean {
    const duplicates = possibleDuplicateFromIndex(source, assignments, pageId);
    if (!duplicates.length) return false;
    for (const record of duplicates) protectedPages.add(record.pageId);
    plan.skipped += 1;
    plan.warnings.push({
      code: "possible-assignment-duplicate",
      message: cancelled
        ? "A cancelled new UID resembles an existing assignment; no pages were merged"
        : "A new UID strongly resembles an existing assignment; no pages were merged",
      details: duplicates.map((record) => record.pageId),
    });
    return true;
  }

  for (const source of feed.cancelledAssignments) {
    if (duplicateUid(source, true)) continue;
    const existing = assignments.byUid.get(source.uid)?.[0];
    if (existing) {
      if (disableRemovals) plan.skipped += 1;
      else if (
        existing.removed &&
        existing.canvasState === "Removed" &&
        !existing.canvasMissingSince &&
        existing.canvasMissingCount === undefined
      )
        plan.unchanged += 1;
      else
        plan.assignmentsToRemove.push({
          ...existing,
          reason: "explicit-cancellation",
          markRemoved: !existing.removed || existing.canvasState !== "Removed",
          clearMissingEvidence:
            Boolean(existing.canvasMissingSince) || existing.canvasMissingCount !== undefined,
        });
    } else {
      const match = matchCourseFromIndex(source, courseIndex, timestamp);
      if (
        !possibleDuplicate(source, match.kind === "matched" ? match.course.pageId : undefined, true)
      ) {
        plan.skipped += 1;
        plan.warnings.push({
          code: "new-cancelled-assignment",
          message: "A cancelled assignment was not previously managed and needs review",
        });
      }
    }
  }

  // Phase 1 collects course evidence. Deferred decisions hold identity references, never queued writes.
  const candidates: Array<{
    source: ExternalAssignment;
    existing?: AssignmentRecord;
    duplicateCoursePageId?: string;
    resolve: () => CourseResolution;
  }> = [];
  for (const source of feed.assignments) {
    if (duplicateUid(source, false)) continue;
    const existing = assignments.byUid.get(source.uid)?.[0];
    const match = catalog.match(source);
    const duplicateCoursePageId =
      match.kind === "matched" && match.courseKey.startsWith("page:")
        ? match.course.pageId
        : undefined;
    if (!existing && possibleDuplicate(source, duplicateCoursePageId)) continue;
    candidates.push({
      source,
      ...(existing ? { existing } : {}),
      ...(duplicateCoursePageId ? { duplicateCoursePageId } : {}),
      resolve:
        match.kind === "unidentified"
          ? () => unidentifiedCourse(existing)
          : catalog.accept(source, match),
    });
  }

  // Phase 2 emits each assignment decision exactly once, after all course conflicts are known.
  catalog.settle();
  const usedCourses = new Set<string>();
  let avoided = 0;
  let deferred = 0;
  for (const { source, existing, duplicateCoursePageId, resolve } of candidates) {
    const course = resolve();
    if (course.kind === "blocked") {
      plan.skipped += 1;
      if (course.warning) plan.warnings.push(course.warning);
      if (existing) {
        protectedPages.add(existing.pageId);
        const update = lifecycleUpdate(source, existing);
        if (update) plan.assignmentsToUpdate.push(update);
      }
      continue;
    }
    if (
      !existing &&
      course.pageId !== duplicateCoursePageId &&
      possibleDuplicate(source, course.pageId)
    )
      continue;
    usedCourses.add(course.courseKey);
    if (!existing) {
      plan.assignmentsToCreate.push({ source, courseKey: course.courseKey });
      continue;
    }
    const decision = decideAssignment(source, existing, course, notionTimezone, now);
    if (decision.update) plan.assignmentsToUpdate.push(decision.update);
    else plan.unchanged += 1;
    if (!decision.update?.verifyDescription) {
      avoided += 1;
      if (decision.deferred) deferred += 1;
    }
  }
  const coursePlan = catalog.finish(usedCourses);
  plan.coursesToCreate = coursePlan.creates;
  plan.coursesToUpdate = coursePlan.updates;
  plan.warnings.push(...coursePlan.warnings);

  // Phase 3 sees the complete protection set; apply runs these writes only after active work succeeds.
  const removal = detectRemovals(
    feed,
    existingAssignments,
    disableRemovals,
    protectedPages,
    trigger,
    now,
    minimumMissingIntervalMs,
    timestamp,
  );
  plan.assignmentsMissingEvidenceToUpdate = removal.missingEvidenceUpdates;
  plan.assignmentsToRemove.push(...removal.removals);
  plan.missingCandidatesObserved = removal.newlyObserved;
  plan.warnings.push(...removal.warnings);
  plan.planning = {
    coursesConflicted: coursePlan.conflicts,
    descriptionIntegrityAuditsDeferred: deferred,
    descriptionUpdatesAvoided: avoided,
    operations: operationCounters,
  };
  return plan;
}
