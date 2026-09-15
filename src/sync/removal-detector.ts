import type {
  AssignmentFeed,
  AssignmentMissingEvidenceUpdate,
  AssignmentRecord,
  AssignmentRemoval,
  PlanWarning,
  Trigger,
} from "../types.js";

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

function hasUnidentifiableAssignmentLikeEvent(feed: AssignmentFeed): boolean {
  return feed.diagnostics.events.some(
    (event) => (event.kind === "malformed" || event.kind === "suspicious") && !event.uid,
  );
}

function hasDuplicateSourceData(feed: AssignmentFeed): boolean {
  return feed.diagnostics.events.some((event) => event.kind === "duplicate");
}

export function absenceRemovalSafe(feed: AssignmentFeed): boolean {
  return (
    !hasUnidentifiableAssignmentLikeEvent(feed) &&
    !hasDuplicateSourceData(feed) &&
    feed.diagnostics.totalEvents < 1000 &&
    hasAssignmentSignals(feed)
  );
}

export interface RemovalEvidenceResult {
  removals: AssignmentRemoval[];
  missingEvidenceUpdates: AssignmentMissingEvidenceUpdate[];
  newlyObserved: number;
  warnings: PlanWarning[];
}

export interface RemovalEvidenceOptions {
  /** Pages that other decisions in this run already act on or deliberately preserve. */
  protectedPageIds: ReadonlySet<string>;
  trigger: Trigger;
  now: Date;
  /** `now` as the ISO string shared by every timestamp the plan writes. */
  timestamp: string;
  /** How long an assignment must have been missing before a second absence removes it. */
  minimumMissingIntervalMs: number;
}

export function detectRemovals(
  feed: AssignmentFeed,
  existing: readonly AssignmentRecord[],
  { protectedPageIds, trigger, now, timestamp, minimumMissingIntervalMs }: RemovalEvidenceOptions,
): RemovalEvidenceResult {
  const result: RemovalEvidenceResult = {
    removals: [],
    missingEvidenceUpdates: [],
    newlyObserved: 0,
    warnings: [],
  };

  if (hasUnidentifiableAssignmentLikeEvent(feed)) {
    result.warnings.push({
      code: "removals-unsafe-parse",
      message: "Missing evidence was not advanced after unsafe feed diagnostics",
    });
  }
  if (hasDuplicateSourceData(feed)) {
    result.warnings.push({
      code: "removals-unsafe-duplicate",
      message: "Missing evidence was not advanced because source UID data was duplicated",
    });
  }
  if (feed.diagnostics.totalEvents >= 1000) {
    result.warnings.push({
      code: "removals-feed-limit",
      message: "Missing evidence was not advanced for a feed with 1,000 or more items",
    });
  }
  if (existing.some((assignment) => !assignment.removed) && !hasAssignmentSignals(feed)) {
    result.warnings.push({
      code: "unexpected-no-assignment-signals",
      message: "Missing evidence was not advanced because the feed had no assignment signals",
    });
  }
  if (result.warnings.length) return result;

  const present = new Set([
    ...feed.diagnostics.sourceUids,
    ...feed.diagnostics.normalizedAssignmentUids,
    ...feed.diagnostics.quarantinedUids,
  ]);
  const nowMs = now.getTime();
  const earliest = nowMs - 30 * DAY;
  const latest = nowMs + 366 * DAY;
  const candidates = existing.filter((assignment) => {
    if (
      assignment.removed ||
      present.has(assignment.uid) ||
      protectedPageIds.has(assignment.pageId) ||
      !assignment.canvasDueDate
    ) {
      return false;
    }
    const due = Date.parse(assignment.canvasDueDate);
    return !Number.isNaN(due) && due >= earliest && due <= latest;
  });

  for (const assignment of candidates) {
    const sinceMs = assignment.canvasMissingSince
      ? Date.parse(assignment.canvasMissingSince)
      : Number.NaN;
    const previousCount = Math.max(0, Math.floor(assignment.canvasMissingCount ?? 0));
    const hasPersistedEvidence = previousCount > 0 && !Number.isNaN(sinceMs);
    if (!hasPersistedEvidence) result.newlyObserved += 1;

    if (trigger === "manual") continue;

    const canvasMissingSince = hasPersistedEvidence ? assignment.canvasMissingSince! : timestamp;
    const canvasMissingCount = hasPersistedEvidence ? previousCount + 1 : 1;
    const intervalSatisfied = hasPersistedEvidence && nowMs - sinceMs >= minimumMissingIntervalMs;
    if (canvasMissingCount >= 2 && intervalSatisfied) {
      result.removals.push({
        ...assignment,
        reason: "persistent-absence",
        markRemoved: true,
        clearMissingEvidence: false,
        canvasMissingCountAfter: canvasMissingCount,
      });
    } else {
      result.missingEvidenceUpdates.push({
        pageId: assignment.pageId,
        canvasMissingSince,
        canvasMissingCount,
        transition: hasPersistedEvidence ? "advanced" : "observed",
      });
    }
  }

  if (candidates.length) {
    result.warnings.push({
      code: trigger === "manual" ? "missing-candidates-manual" : "missing-candidates-observed",
      message:
        trigger === "manual"
          ? `${candidates.length} removal candidate(s) were observed; manual runs do not advance missing evidence`
          : `${candidates.length} removal candidate(s) were processed using persistent missing evidence`,
    });
  }
  return result;
}
