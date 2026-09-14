import type { AppConfig } from "../config.js";
import type { RunResult, SyncOperation } from "../types.js";
import { compilePlan, operationOf } from "../sync/commands.js";

export interface ReportSection {
  title: string;
  lines: string[];
}

interface ReportField {
  label: string;
  value: string | number;
  section: string;
  logLabel: string;
}

/** Labels, values, and legacy Sync Log aliases are defined together. */
function reportFields(config: AppConfig, result: RunResult): ReportField[] {
  const { counts, metrics } = result;
  const dryRun = config.mode === "dry-run";
  const proposed = dryRun ? "Proposed " : "";
  const field = (
    label: string,
    value: string | number,
    section = "Run metrics",
    logLabel = label,
  ): ReportField => ({ label, value, section, logLabel });
  return [
    field("Feed events", counts.feedItems),
    field("Active assignments", counts.assignmentsParsed),
    field("Cancelled assignments", counts.cancelledAssignments),
    field("Ordinary events ignored", counts.ignoredEvents),
    field("Suspicious events", counts.suspiciousEvents),
    field("Malformed events", counts.malformedEvents),
    field("Duplicate source UIDs", counts.duplicateUids),
    field("Quarantined UIDs", `${counts.quarantinedUids} (values redacted)`),
    field("Removal inference enabled", config.disableRemovals ? "no" : "yes"),
    field(
      "Removal inference safe",
      !config.disableRemovals && result.feedDiagnostics?.absenceRemovalSafe ? "yes" : "no",
    ),
    ...(dryRun
      ? [
          field("Proposed Assignment pages", counts.created, "Create metrics"),
          field("Proposed Assignments updated", counts.updated),
          field("Proposed Assignments marked removed", counts.removed, "Removal evidence"),
          field("Proposed description integrity audits", metrics.descriptionIntegrityAuditsDue),
        ]
      : [
          field(
            "Assignment pages added",
            metrics.assignmentPagesCreated + metrics.assignmentPagesRecovered,
            "Create metrics",
          ),
          field("Assignment pages created", metrics.assignmentPagesCreated, "Create metrics"),
          field("Assignment pages recovered", metrics.assignmentPagesRecovered, "Create metrics"),
          field("Assignments updated", counts.updated),
          field("Assignments marked removed", counts.removed, "Removal evidence"),
        ]),
    field("Newly observed missing candidates", counts.missingObserved, "Removal evidence"),
    field(`${proposed}Missing evidence advanced`, counts.missingAdvanced, "Removal evidence"),
    field(`${proposed}Missing evidence cleared`, counts.missingCleared, "Removal evidence"),
    ...(dryRun
      ? [
          field(
            "Proposed Course pages",
            result.plan?.coursesToCreate.length ?? 0,
            "Create metrics",
          ),
          field("Proposed Courses enriched", counts.coursesUpdated),
        ]
      : [
          field(
            "Course pages added",
            metrics.coursesCreated + metrics.coursesRecovered,
            "Create metrics",
          ),
          field("Course pages created", metrics.coursesCreated, "Create metrics"),
          field("Course pages recovered", metrics.coursesRecovered, "Create metrics"),
          field("Courses enriched", counts.coursesUpdated),
        ]),
    field("Course conflicts", metrics.coursesConflicted),
    field("Unchanged", counts.unchanged),
    field("Skipped", counts.skipped),
    field("Warnings", counts.warningCount),
    field("Notion requests", metrics.notionRequests),
    field("Notion read retries", metrics.readRetries),
    field("Notion property-update retries", metrics.propertyUpdateRetries),
    field("Assignment body reads", metrics.assignmentBodyReads),
    field("Description updates avoided", metrics.descriptionUpdatesAvoided),
    field(
      "Description integrity audits due this run",
      metrics.descriptionIntegrityAuditsDue,
      "Description integrity",
      "Audits due this run",
    ),
    field(
      "Description integrity audits deferred",
      metrics.descriptionIntegrityAuditsDeferred,
      "Description integrity",
      "Audits deferred to later slots",
    ),
    field(
      "Description integrity audits run",
      metrics.descriptionIntegrityAuditsRun,
      "Description integrity",
      "Audits run",
    ),
    field(
      "Description audits passed without repair",
      metrics.descriptionIntegrityAuditsPassed,
      "Description integrity",
      "Audits passed without repair",
    ),
    field(
      "Description integrity repairs",
      metrics.descriptionIntegrityRepairs,
      "Description integrity",
      "Repairs performed",
    ),
    field(
      "Description body reads avoided",
      metrics.descriptionBodyReadsAvoided,
      "Description integrity",
      "Body reads avoided",
    ),
    field("Managed-section replacements", metrics.descriptionReplacements, "Description integrity"),
    field("Ambiguous write recoveries", metrics.ambiguousWriteRecoveries),
    field("Assignments fully synchronized", result.execution?.assignmentsSynchronized.length ?? 0),
    field("Assignments requiring repair", result.execution?.partialAssignments.length ?? 0),
    field(
      "Notion requests by operation",
      Object.entries(metrics.requestsByOperation)
        .map(([name, count]) => `${name}=${count}`)
        .join(", ") || "None",
    ),
  ];
}

export function reportLines(config: AppConfig, result: RunResult): string[] {
  return reportFields(config, result).map((field) => `${field.label}: ${field.value}`);
}

export function warningSummary(result: RunResult): string | undefined {
  if (!result.warnings.length) return;
  const counts = new Map<string, number>();
  for (const warning of result.warnings) {
    counts.set(warning.code, (counts.get(warning.code) ?? 0) + 1);
  }
  return Array.from(counts, ([code, count]) => `${code} (${count})`).join(", ");
}

export function failureSummary(result: RunResult): string | undefined {
  if (result.status !== "Failed") return;
  const failed = result.execution?.failedOperation;
  if (failed) {
    const remaining = result.execution?.notAttempted.length ?? 0;
    return `${failed.kind} ${failed.outcome}; ${remaining} later operation(s) not attempted. See workflow logs for details.`;
  }
  return `${result.errors.length || 1} error(s) recorded. See workflow logs for details.`;
}

function operation(value: SyncOperation): string {
  return `${value.kind}: ${value.target}`;
}

function operationLines<T extends SyncOperation>(
  values: T[],
  format: (value: T) => string,
): string[] {
  if (values.length <= 20) return values.map(format);
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value.kind, (counts.get(value.kind) ?? 0) + 1);
  return [
    `${values.length} operations total; ${values.length - 10} individual entries omitted.`,
    ...Array.from(counts, ([kind, count]) => `${kind}: ${count}`),
    "First 5:",
    ...values.slice(0, 5).map(format),
    "Last 5:",
    ...values.slice(-5).map(format),
  ];
}

export function operationSections(result: RunResult): ReportSection[] {
  const execution = result.execution;
  const planned = result.plan
    ? operationLines(compilePlan(result.plan).map(operationOf), operation)
    : [];
  const applied = execution
    ? operationLines(
        execution.appliedOperations,
        (item) =>
          `${operation(item)}${item.pageId ? ` -> ${item.pageId}` : ""}${item.recovered ? " (recovered)" : ""}`,
      )
    : [];
  const partial =
    execution?.partialAssignments.map(
      (item) =>
        `${item.intent} ${item.target} -> ${item.pageId}: completed ${item.completedSubsteps.join(", ")}; requires repair at ${item.failedSubstep?.kind ?? "unknown substep"}`,
    ) ?? [];
  const failed = [
    ...(execution?.failedOperation ? [execution.failedOperation] : []),
    ...(execution?.additionalFailures ?? []),
  ].map((value) => `${operation(value)} [${value.outcome}]: ${value.message}`);
  return [
    { title: "Planned operations", lines: planned },
    { title: "Applied operations", lines: applied },
    { title: "Partial operations", lines: partial },
    { title: "Failed or ambiguous operation", lines: failed },
    {
      title: "Operations not attempted",
      lines: execution ? operationLines(execution.notAttempted, operation) : planned,
    },
    {
      title: "Warnings",
      lines: result.warnings.map((warning) => `${warning.code}: ${warning.message}`),
    },
    { title: "Errors", lines: result.errors },
  ];
}

export function reportSections(config: AppConfig, result: RunResult): ReportSection[] {
  const fields = reportFields(config, result);
  return [
    ...["Create metrics", "Description integrity", "Removal evidence", "Run metrics"].map(
      (title) => ({
        title,
        lines: fields
          .filter((field) => field.section === title)
          .map((field) => `${field.logLabel}: ${field.value}`),
      }),
    ),
    ...operationSections(result),
  ];
}
