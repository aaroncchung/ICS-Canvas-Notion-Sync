import type { AssignmentFeed, AssignmentRecord, PlanWarning } from "../types.js";

const DAY = 86_400_000;

export function hasAssignmentSignals(feed: AssignmentFeed): boolean {
  return (
    feed.assignments.length > 0 ||
    feed.cancelledAssignments.length > 0 ||
    feed.diagnostics.normalizedAssignmentUids.length > 0 ||
    feed.diagnostics.quarantinedUids.length > 0 ||
    feed.diagnostics.events.some((event) => event.kind !== "ignored")
  );
}

export function detectRemovals(
  feed: AssignmentFeed,
  existing: AssignmentRecord[],
  disableRemovals: boolean,
  protectedPageIds: ReadonlySet<string>,
  now = new Date(),
): { removals: AssignmentRecord[]; warnings: PlanWarning[] } {
  const warnings: PlanWarning[] = [];
  if (disableRemovals) return { removals: [], warnings };
  const unidentifiableAssignmentLikeEvent = feed.diagnostics.events.some(
    (event) => (event.kind === "malformed" || event.kind === "suspicious") && !event.uid,
  );
  if (!feed.diagnostics.complete || unidentifiableAssignmentLikeEvent) {
    warnings.push({
      code: "removals-unsafe-parse",
      message: "Removal detection skipped after parse warnings",
    });
  }
  if (feed.diagnostics.totalEvents >= 1000) {
    warnings.push({
      code: "removals-feed-limit",
      message: "Removal detection skipped for a feed with 1,000 or more items",
    });
  }
  if (existing.some((assignment) => !assignment.removed) && !hasAssignmentSignals(feed)) {
    warnings.push({
      code: "unexpected-no-assignment-signals",
      message: "Removal detection skipped because the feed contained no assignment signals",
    });
  }
  if (warnings.length) return { removals: [], warnings };
  const present = new Set([
    ...feed.diagnostics.sourceUids,
    ...feed.diagnostics.normalizedAssignmentUids,
    ...feed.diagnostics.quarantinedUids,
  ]);
  const earliest = now.getTime() - 30 * DAY;
  const latest = now.getTime() + 366 * DAY;
  const removals = existing.filter((assignment) => {
    if (
      assignment.removed ||
      present.has(assignment.uid) ||
      protectedPageIds.has(assignment.pageId) ||
      !assignment.canvasDueDate
    )
      return false;
    const due = Date.parse(assignment.canvasDueDate);
    return !Number.isNaN(due) && due >= earliest && due <= latest;
  });
  return { removals, warnings };
}
