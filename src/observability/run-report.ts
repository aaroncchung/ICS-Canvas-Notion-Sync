import type {
  FeedDiagnosticSummary,
  RunCounts,
  RunMetrics,
  RunMode,
  RunResult,
  RequestMetrics,
  SyncExecutionResult,
  SyncPlan,
} from "../types.ts";
import { compilePlan } from "../sync/commands.ts";

export function createRequestMetrics(): RequestMetrics {
  return { notionRequests: 0, requestsByOperation: {}, readRetries: 0, propertyUpdateRetries: 0 };
}

/** Copies counters at a run/phase boundary; never retains a live gateway object. */
export function requestDifference(
  current: RequestMetrics,
  baseline: RequestMetrics,
): RequestMetrics {
  return {
    notionRequests: current.notionRequests - baseline.notionRequests,
    requestsByOperation: Object.fromEntries(
      Object.entries(current.requestsByOperation)
        .map(([key, value]): [string, number] => [
          key,
          value - (baseline.requestsByOperation[key] ?? 0),
        ])
        .filter(([, value]) => value !== 0),
    ),
    readRetries: current.readRetries - baseline.readRetries,
    propertyUpdateRetries: current.propertyUpdateRetries - baseline.propertyUpdateRetries,
  };
}

export function createRunMetrics(): RunMetrics {
  return {
    ...createRequestMetrics(),
    ambiguousWriteRecoveries: 0,
    assignmentBodyReads: 0,
    descriptionReplacements: 0,
    descriptionUpdatesAvoided: 0,
    descriptionIntegrityAuditsDue: 0,
    descriptionIntegrityAuditsDeferred: 0,
    descriptionIntegrityAuditsRun: 0,
    descriptionIntegrityAuditsPassed: 0,
    descriptionIntegrityRepairs: 0,
    descriptionBodyReadsAvoided: 0,
    descriptionFormatUpgrades: 0,
    coursesCreated: 0,
    coursesRecovered: 0,
    coursesEnriched: 0,
    coursesConflicted: 0,
    assignmentPagesCreated: 0,
    assignmentPagesRecovered: 0,
  };
}

export function emptyCounts(): RunCounts {
  return {
    feedItems: 0,
    assignmentsParsed: 0,
    cancelledAssignments: 0,
    ignoredEvents: 0,
    suspiciousEvents: 0,
    malformedEvents: 0,
    duplicateUids: 0,
    quarantinedUids: 0,
    created: 0,
    updated: 0,
    coursesUpdated: 0,
    removed: 0,
    missingObserved: 0,
    missingAdvanced: 0,
    missingCleared: 0,
    unchanged: 0,
    skipped: 0,
    warningCount: 0,
  };
}

/** One reducer for planned commands and confirmed logical effects, including fallbacks. */
export function workCounts(
  plan?: SyncPlan,
  execution?: SyncExecutionResult,
  planned = false,
): RunCounts {
  const counts = emptyCounts();
  if (!plan) return counts;
  counts.unchanged = plan.unchanged;
  counts.skipped = plan.skipped;
  counts.warningCount = plan.warnings.length;
  counts.missingObserved = plan.missingCandidatesObserved;
  const commands = compilePlan(plan);
  const appliedByKind = new Map<string, Set<string>>();
  const recoveredCreates = new Set<string>();
  for (const operation of execution?.appliedOperations ?? []) {
    const targets = appliedByKind.get(operation.kind) ?? new Set<string>();
    targets.add(operation.target);
    appliedByKind.set(operation.kind, targets);
    if (operation.kind === "assignment-page-create" && operation.recovered)
      recoveredCreates.add(operation.target);
  }
  for (const command of commands) {
    if (!planned && !appliedByKind.get(command.kind)?.has(command.target)) continue;
    switch (command.kind) {
      case "course-update":
        counts.coursesUpdated += 1;
        break;
      case "assignment-page-create":
        if (planned || !recoveredCreates.has(command.target)) counts.created += 1;
        break;
      case "assignment-property-update":
        if (command.assignment.value.missingEvidenceCleared) counts.missingCleared += 1;
        break;
      case "assignment-remove":
      case "assignment-missing-evidence-update":
        if (command.change.type === "evidence") {
          if (command.change.value.transition === "advanced") counts.missingAdvanced += 1;
        } else {
          const value = command.change.value;
          if (value.markRemoved) counts.removed += 1;
          if (value.clearMissingEvidence) counts.missingCleared += 1;
          if (value.canvasMissingCountAfter !== undefined) counts.missingAdvanced += 1;
        }
        break;
    }
  }
  counts.updated = planned
    ? plan.assignmentsToUpdate.length
    : (execution?.assignmentsSynchronized.filter((value) => value.intent === "update").length ?? 0);
  return counts;
}

export function runMetrics(
  plan?: SyncPlan,
  execution?: SyncExecutionResult,
  requests = createRequestMetrics(),
): RunMetrics {
  const metrics = {
    ...createRunMetrics(),
    ...requests,
    requestsByOperation: { ...requests.requestsByOperation },
  };
  metrics.coursesConflicted = plan?.planning?.coursesConflicted ?? 0;
  metrics.descriptionUpdatesAvoided = plan?.planning?.descriptionUpdatesAvoided ?? 0;
  // Compatibility alias, never an independently accumulated counter.
  metrics.descriptionBodyReadsAvoided = metrics.descriptionUpdatesAvoided;
  metrics.descriptionIntegrityAuditsDeferred =
    plan?.planning?.descriptionIntegrityAuditsDeferred ?? 0;
  metrics.descriptionFormatUpgrades = plan?.planning?.descriptionFormatUpgrades ?? 0;
  metrics.descriptionIntegrityAuditsDue = plan
    ? compilePlan(plan).filter((value) => value.kind === "assignment-description-update").length
    : 0;
  metrics.ambiguousWriteRecoveries = execution?.ambiguousWriteRecoveries ?? 0;
  for (const operation of execution?.appliedOperations ?? []) {
    if (operation.recovered) metrics.ambiguousWriteRecoveries += 1;
    if (operation.kind === "course-create") {
      if (operation.recovered) metrics.coursesRecovered += 1;
      else metrics.coursesCreated += 1;
    }
    if (operation.kind === "assignment-page-create") {
      if (operation.recovered) metrics.assignmentPagesRecovered += 1;
      else metrics.assignmentPagesCreated += 1;
    }
    if (operation.kind === "course-update") metrics.coursesEnriched += 1;
    if (operation.kind === "assignment-description-update") {
      metrics.descriptionIntegrityAuditsRun += 1;
      if (operation.description?.repaired) metrics.descriptionIntegrityRepairs += 1;
      else metrics.descriptionIntegrityAuditsPassed += 1;
      if (operation.description?.replaced) metrics.descriptionReplacements += 1;
    }
  }
  if (execution?.failedOperation?.kind === "assignment-description-update")
    metrics.descriptionIntegrityAuditsRun += 1;
  metrics.assignmentBodyReads = metrics.descriptionIntegrityAuditsRun;
  return metrics;
}

function feedCounts(feed?: FeedDiagnosticSummary): Partial<RunCounts> {
  return feed
    ? {
        feedItems: feed.totalEvents,
        assignmentsParsed: feed.activeAssignments,
        cancelledAssignments: feed.cancelledAssignments,
        ignoredEvents: feed.ignoredEvents,
        suspiciousEvents: feed.suspiciousEvents,
        malformedEvents: feed.malformedEvents,
        duplicateUids: feed.duplicateUids,
        quarantinedUids: feed.quarantinedUids,
      }
    : {};
}

/** Final projection shared by success, early failure, partial execution, and dry run. */
export function finalizeRun(result: RunResult, mode: RunMode, requests: RequestMetrics): RunResult {
  const common = { ...feedCounts(result.feedDiagnostics), warningCount: result.warnings.length };
  const plannedCounts = { ...workCounts(result.plan, undefined, true), ...common };
  const executedCounts = { ...workCounts(result.plan, result.execution), ...common };
  return {
    ...result,
    plannedCounts,
    executedCounts,
    counts: mode === "dry-run" ? plannedCounts : executedCounts,
    metrics: runMetrics(result.plan, result.execution, requests),
  };
}
