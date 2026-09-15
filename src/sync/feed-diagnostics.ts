import type { AssignmentFeed, FeedDiagnosticSummary, PlanWarning } from "../types.js";
import { absenceRemovalSafe } from "./removal-detector.js";

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
