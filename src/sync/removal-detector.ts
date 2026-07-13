import type { AssignmentFeed, AssignmentRecord, PlanWarning } from "../types.js";

const DAY = 86_400_000;

export function detectRemovals(
  feed: AssignmentFeed,
  existing: AssignmentRecord[],
  disableRemovals: boolean,
  now = new Date(),
): { removals: AssignmentRecord[]; warnings: PlanWarning[] } {
  const warnings: PlanWarning[] = [];
  if (disableRemovals) return { removals: [], warnings };
  if (!feed.diagnostics.complete || feed.diagnostics.malformedEvents > 0) {
    warnings.push({
      code: "removals-unsafe-parse",
      message: "Removal detection skipped after parse warnings",
    });
    return { removals: [], warnings };
  }
  if (feed.diagnostics.totalEvents >= 1000) {
    warnings.push({
      code: "removals-feed-limit",
      message: "Removal detection skipped for a feed with 1,000 or more items",
    });
    return { removals: [], warnings };
  }
  if (feed.assignments.length === 0 && existing.length > 0) {
    warnings.push({
      code: "unexpected-empty-feed",
      message: "Removal detection skipped because the feed unexpectedly contained no assignments",
    });
    return { removals: [], warnings };
  }
  const present = new Set(feed.assignments.map((assignment) => assignment.uid));
  const earliest = now.getTime() - 30 * DAY;
  const latest = now.getTime() + 366 * DAY;
  const removals = existing.filter((assignment) => {
    if (assignment.removed || present.has(assignment.uid) || !assignment.canvasDueDate)
      return false;
    const due = Date.parse(assignment.canvasDueDate);
    return !Number.isNaN(due) && due >= earliest && due <= latest;
  });
  return { removals, warnings };
}
