import type {
  AssignmentFeed,
  AssignmentPropertyUpdate,
  AssignmentRecord,
  CourseRecord,
  PlanWarning,
  SyncPlan,
} from "../types.js";
import { descriptionExcerpt } from "../notion/assignments.js";
import { matchCourse } from "./course-matcher.js";
import { datesEqual, resolveDates } from "./date-resolution.js";
import { possibleDuplicate } from "./duplicate-detector.js";
import { detectRemovals } from "./removal-detector.js";

function sameOptional(left?: string, right?: string): boolean {
  return (left ?? undefined) === (right ?? undefined);
}

function warnFeed(feed: AssignmentFeed): PlanWarning[] {
  const warnings: PlanWarning[] = [];
  if (feed.diagnostics.duplicateUids.length) {
    warnings.push({
      code: "duplicate-source-uids",
      message: `${feed.diagnostics.duplicateUids.length} duplicate UID event(s) were skipped`,
      details: feed.diagnostics.duplicateUids.map(() => "duplicate UID redacted"),
    });
  }
  if (feed.diagnostics.malformedEvents) {
    warnings.push({
      code: "malformed-events",
      message: `${feed.diagnostics.malformedEvents} malformed assignment event(s) were skipped`,
    });
  }
  if (feed.diagnostics.skippedEvents.length) {
    warnings.push({
      code: "skipped-feed-events",
      message: `${feed.diagnostics.skippedEvents.length} feed event(s) were skipped`,
      details: feed.diagnostics.skippedEvents.map((event) => event.reason),
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
): SyncPlan {
  const plan: SyncPlan = {
    coursesToCreate: [],
    assignmentsToCreate: [],
    assignmentsToUpdate: [],
    assignmentsToRemove: [],
    unchanged: 0,
    skipped: feed.diagnostics.skippedEvents.length,
    warnings: warnFeed(feed),
  };
  const byUid = new Map<string, AssignmentRecord[]>();
  for (const assignment of existingAssignments) {
    const values = byUid.get(assignment.uid) ?? [];
    values.push(assignment);
    byUid.set(assignment.uid, values);
  }
  const plannedCourseKeys = new Set<string>();

  for (const source of feed.assignments) {
    const uidMatches = byUid.get(source.uid) ?? [];
    if (uidMatches.length > 1) {
      plan.skipped += 1;
      plan.warnings.push({
        code: "duplicate-notion-uid",
        message:
          "An assignment UID maps to multiple Notion pages; all ambiguous pages were preserved",
        details: uidMatches.map((assignment) => assignment.pageId),
      });
      continue;
    }
    if (uidMatches.length === 0) {
      const duplicates = possibleDuplicate(source, existingAssignments);
      if (duplicates.length) {
        plan.skipped += 1;
        plan.warnings.push({
          code: "possible-assignment-duplicate",
          message: "A new UID strongly resembles an existing assignment; no pages were merged",
          details: duplicates.map((assignment) => assignment.pageId),
        });
        continue;
      }
    }

    const match = matchCourse(source, courses, aliases);
    if (match.kind === "ambiguous") {
      plan.skipped += 1;
      plan.warnings.push({
        code: "ambiguous-course",
        message: `Multiple courses matched at the ${match.method} confidence level`,
        details: match.courses.map((course) => course.pageId),
      });
      continue;
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
    const updateDescription =
      existing.managedDescription === undefined ||
      existing.managedDescription !== (source.descriptionMarkdown ?? "");
    if (updateDescription || excerptChanged) properties.rawDescription = excerpt;
    const reactivate = existing.removed || existing.canvasState !== "Active";
    if (reactivate) {
      properties.removed = false;
      properties.canvasState = "Active";
    }
    if (Object.keys(properties).length || updateDescription) {
      plan.assignmentsToUpdate.push({
        pageId: existing.pageId,
        source,
        courseKey,
        properties,
        updateDescription,
        reactivate,
      });
    } else {
      plan.unchanged += 1;
    }
  }

  const removal = detectRemovals(feed, existingAssignments, disableRemovals, now);
  plan.assignmentsToRemove = removal.removals;
  plan.warnings.push(...removal.warnings);
  return plan;
}
