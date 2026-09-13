import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { Logger } from "pino";
import { loadConfig, type AppConfig } from "./config.js";
import { CanvasIcsProvider } from "./canvas/provider.js";
import { readAssignments } from "./notion/assignments.js";
import { createRunMetrics, OfficialNotionGateway, type NotionGateway } from "./notion/client.js";
import { readCourses } from "./notion/courses.js";
import { validateNotionSchemas } from "./notion/schema-validator.js";
import { writeSyncLog } from "./notion/sync-log.js";
import { createLogger } from "./observability/logger.js";
import { redactText, safeDiagnostic, safeError } from "./observability/redaction.js";
import { buildPlan, feedDiagnosticSummary, feedWarnings } from "./sync/plan.js";
import { ApplyPlanError, applyPlan } from "./sync/reconcile.js";
import type { AssignmentProvider, RunCounts, RunResult } from "./types.js";

export interface RunDependencies {
  gateway?: NotionGateway;
  provider?: AssignmentProvider;
  summaryAppender?: SummaryAppender;
  now?: () => Date;
}

export type SummaryAppender = (path: string, data: string, encoding: "utf8") => Promise<void>;

function emptyCounts(): RunCounts {
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

export function buildJobSummary(config: AppConfig, result: RunResult): string {
  const secrets = [config.CANVAS_ICS_URL, config.NOTION_TOKEN];
  const dryRun = config.mode === "dry-run";
  const assignmentPagesAdded =
    result.metrics.assignmentPagesCreated + result.metrics.assignmentPagesRecovered;
  const coursePagesAdded = result.metrics.coursesCreated + result.metrics.coursesRecovered;
  const removalEnabled = !config.disableRemovals;
  const removalSafe = result.feedDiagnostics?.absenceRemovalSafe ?? false;
  const lines = [
    "## Canvas–Notion sync",
    "",
    `- Status: ${result.status}`,
    `- Mode: ${config.mode}`,
    `- Trigger: ${config.trigger}`,
    `- Feed events: ${result.counts.feedItems}`,
    `- Active assignments: ${result.counts.assignmentsParsed}`,
    `- Cancelled assignments: ${result.counts.cancelledAssignments}`,
    `- Ordinary events ignored: ${result.counts.ignoredEvents}`,
    `- Suspicious events: ${result.counts.suspiciousEvents}`,
    `- Malformed events: ${result.counts.malformedEvents}`,
    `- Duplicate source UIDs: ${result.counts.duplicateUids}`,
    `- Quarantined UIDs: ${result.counts.quarantinedUids} (values redacted)`,
    `- Removal inference enabled: ${removalEnabled ? "yes" : "no"}`,
    `- Removal inference safe: ${removalEnabled && removalSafe ? "yes" : "no"}`,
    ...(dryRun
      ? [
          `- Proposed Assignment pages: ${result.counts.created}`,
          `- Proposed Assignments updated: ${result.counts.updated}`,
          `- Proposed Assignments marked removed: ${result.counts.removed}`,
          `- Proposed description integrity audits: ${result.metrics.descriptionIntegrityAuditsDue}`,
        ]
      : [
          `- Assignment pages added: ${assignmentPagesAdded}`,
          `- Assignment pages created: ${result.metrics.assignmentPagesCreated}`,
          `- Assignment pages recovered: ${result.metrics.assignmentPagesRecovered}`,
          `- Assignments updated: ${result.counts.updated}`,
          `- Assignments marked removed: ${result.counts.removed}`,
        ]),
    `- Newly observed missing candidates: ${result.counts.missingObserved}`,
    `- ${dryRun ? "Proposed " : ""}Missing evidence advanced: ${result.counts.missingAdvanced}`,
    `- ${dryRun ? "Proposed " : ""}Missing evidence cleared: ${result.counts.missingCleared}`,
    ...(dryRun
      ? [
          `- Proposed Course pages: ${result.plan?.coursesToCreate.length ?? 0}`,
          `- Proposed Courses enriched: ${result.counts.coursesUpdated}`,
        ]
      : [
          `- Course pages added: ${coursePagesAdded}`,
          `- Course pages created: ${result.metrics.coursesCreated}`,
          `- Course pages recovered: ${result.metrics.coursesRecovered}`,
          `- Courses enriched: ${result.counts.coursesUpdated}`,
        ]),
    `- Course conflicts: ${result.metrics.coursesConflicted}`,
    `- Unchanged: ${result.counts.unchanged}`,
    `- Skipped: ${result.counts.skipped}`,
    `- Warnings: ${result.counts.warningCount}`,
    `- Notion requests: ${result.metrics.notionRequests}`,
    `- Notion read retries: ${result.metrics.readRetries}`,
    `- Notion property-update retries: ${result.metrics.propertyUpdateRetries}`,
    `- Assignment body reads: ${result.metrics.assignmentBodyReads}`,
    `- Description updates avoided: ${result.metrics.descriptionUpdatesAvoided}`,
    `- Description integrity audits due this run: ${result.metrics.descriptionIntegrityAuditsDue}`,
    `- Description integrity audits deferred: ${result.metrics.descriptionIntegrityAuditsDeferred}`,
    `- Description integrity audits run: ${result.metrics.descriptionIntegrityAuditsRun}`,
    `- Description audits passed without repair: ${result.metrics.descriptionIntegrityAuditsPassed}`,
    `- Description integrity repairs: ${result.metrics.descriptionIntegrityRepairs}`,
    `- Description body reads avoided: ${result.metrics.descriptionBodyReadsAvoided}`,
    ...(result.errors.length
      ? [
          "",
          `Failure summary: ${result.errors
            .slice(0, 3)
            .map((error) => redactText(error, secrets).split(/\r?\n/, 1)[0])
            .join("; ")}`,
        ]
      : []),
    "",
  ];
  return lines.join("\n");
}

export async function writeJobSummaryBestEffort(
  config: AppConfig,
  result: RunResult,
  logger: Logger,
  appender: SummaryAppender = appendFile,
): Promise<boolean> {
  if (!config.GITHUB_STEP_SUMMARY) return true;
  try {
    await appender(config.GITHUB_STEP_SUMMARY, buildJobSummary(config, result), "utf8");
    return true;
  } catch (error) {
    logger.warn(
      { diagnostic: safeDiagnostic(error, [config.CANVAS_ICS_URL, config.NOTION_TOKEN]) },
      "Could not append GitHub job summary",
    );
    return false;
  }
}

function workflowCommand(kind: "error" | "warning", message: string, secrets: string[]): string {
  const sanitized = redactText(message, secrets)
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A")
    .slice(0, 1000);
  return `::${kind}::${sanitized}`;
}

export function workflowAnnotations(config: AppConfig, result: RunResult): string[] {
  if (config.GITHUB_ACTIONS !== "true") return [];
  const secrets = [config.CANVAS_ICS_URL, config.NOTION_TOKEN];
  if (result.status === "Failed") {
    return [workflowCommand("error", result.errors[0] ?? "Synchronization failed", secrets)];
  }
  if (result.status !== "Warning") return [];
  const diagnosticCounts = [
    `suspicious=${result.counts.suspiciousEvents}`,
    `malformed=${result.counts.malformedEvents}`,
    `duplicates=${result.counts.duplicateUids}`,
    `quarantined=${result.counts.quarantinedUids}`,
  ].join(", ");
  const warningSummary = result.warnings
    .slice(0, 3)
    .map((warning) => warning.message)
    .join("; ");
  return [
    workflowCommand(
      "warning",
      `Sync completed with meaningful diagnostics (${diagnosticCounts})${warningSummary ? `: ${warningSummary}` : ""}`,
      secrets,
    ),
  ];
}

export async function run(
  config: AppConfig,
  dependencies: RunDependencies = {},
): Promise<RunResult> {
  const secrets = [config.CANVAS_ICS_URL, config.NOTION_TOKEN];
  const logger = createLogger();
  const defaultMetrics = createRunMetrics();
  const gateway =
    dependencies.gateway ?? new OfficialNotionGateway(config.NOTION_TOKEN, logger, defaultMetrics);
  const metrics = gateway.metrics ?? defaultMetrics;
  const provider = dependencies.provider ?? new CanvasIcsProvider(config, logger);
  const now = dependencies.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const counts = emptyCounts();
  let result: RunResult = { status: "Failed", counts, warnings: [], errors: [], metrics };
  let syncLogAttempted = false;

  try {
    await validateNotionSchemas(gateway, config);
    const feed = await provider.fetchAssignments();
    const diagnosticSummary = feedDiagnosticSummary(feed);
    result.feedDiagnostics = diagnosticSummary;
    counts.feedItems = feed.diagnostics.totalEvents;
    counts.assignmentsParsed = feed.assignments.length;
    counts.cancelledAssignments = diagnosticSummary.cancelledAssignments;
    counts.ignoredEvents = diagnosticSummary.ignoredEvents;
    counts.suspiciousEvents = diagnosticSummary.suspiciousEvents;
    counts.malformedEvents = diagnosticSummary.malformedEvents;
    counts.duplicateUids = diagnosticSummary.duplicateUids;
    counts.quarantinedUids = diagnosticSummary.quarantinedUids;
    if (!feed.diagnostics.complete) {
      throw new Error("Assignment provider returned incomplete feed diagnostics");
    }

    if (config.mode === "validate") {
      const warnings = feedWarnings(feed);
      counts.warningCount = warnings.length;
      result = {
        status: warnings.length ? "Warning" : "Success",
        counts,
        warnings,
        errors: [],
        feedDiagnostics: diagnosticSummary,
        metrics,
      };
    } else {
      const [existingAssignments, courses] = await Promise.all([
        readAssignments(gateway, config.NOTION_ASSIGNMENTS_DATA_SOURCE_ID),
        readCourses(gateway, config.NOTION_COURSES_DATA_SOURCE_ID),
      ]);
      const plan = buildPlan(
        feed,
        existingAssignments,
        courses,
        config.aliases,
        config.disableRemovals,
        config.NOTION_TIMEZONE,
        now(),
        metrics,
        config.trigger,
        config.CANVAS_MISSING_EVIDENCE_MINIMUM_HOURS * 60 * 60 * 1000,
      );
      for (const warning of plan.warnings.filter(
        (item) => item.code === "course-metadata-conflict",
      )) {
        logger.warn(
          { code: warning.code, pageIds: warning.details ?? [], canvasIdentifiers: "[REDACTED]" },
          warning.message,
        );
      }
      counts.unchanged = plan.unchanged;
      counts.skipped = plan.skipped;
      counts.warningCount = plan.warnings.length;
      counts.missingObserved = plan.missingCandidatesObserved;
      if (config.mode === "dry-run") {
        counts.created = plan.assignmentsToCreate.length;
        counts.updated = plan.assignmentsToUpdate.length;
        counts.coursesUpdated = plan.coursesToUpdate.length;
        counts.removed = plan.assignmentsToRemove.filter(
          (assignment) => assignment.markRemoved,
        ).length;
        counts.missingAdvanced =
          plan.assignmentsMissingEvidenceToUpdate.filter(
            (assignment) => assignment.transition === "advanced",
          ).length +
          plan.assignmentsToRemove.filter(
            (assignment) => assignment.canvasMissingCountAfter !== undefined,
          ).length;
        counts.missingCleared =
          plan.assignmentsToUpdate.filter((assignment) => assignment.missingEvidenceCleared)
            .length +
          plan.assignmentsToRemove.filter((assignment) => assignment.clearMissingEvidence).length;
      }
      result = {
        status:
          config.mode === "dry-run" ? "Dry Run" : plan.warnings.length ? "Warning" : "Success",
        counts,
        warnings: plan.warnings,
        errors: [],
        feedDiagnostics: diagnosticSummary,
        metrics,
        plan,
      };
      if (config.mode === "sync") {
        result.execution = await applyPlan(gateway, config, plan, counts, { now });
      }
    }

    if (config.mode === "sync") {
      syncLogAttempted = true;
      await writeSyncLog(gateway, config, startedAt, now().toISOString(), result);
    }
    logger.debug({ metrics }, "Notion and reconciliation metrics");
    logger.info({ status: result.status, counts: result.counts }, "Synchronization run complete");
  } catch (error) {
    if (error instanceof ApplyPlanError) result.execution = error.execution;
    const message = safeError(error, secrets);
    result.status = "Failed";
    result.errors.push(message);
    logger.error(
      { diagnostic: safeDiagnostic(error, secrets), counts, metrics },
      "Synchronization run failed",
    );
    if (config.mode === "sync" && !syncLogAttempted) {
      try {
        syncLogAttempted = true;
        await writeSyncLog(gateway, config, startedAt, now().toISOString(), result);
      } catch (logError) {
        const logMessage = safeError(logError, secrets);
        result.errors.push(`Sync Log write failed: ${logMessage}`);
        logger.error(
          { diagnostic: safeDiagnostic(logError, secrets) },
          "Could not persist the failed run to Notion Sync Log",
        );
      }
    } else if (config.mode === "sync" && syncLogAttempted) {
      result.errors.push("Sync Log write failed; creation was not blindly retried");
    }
  }
  for (const annotation of workflowAnnotations(config, result)) {
    process.stdout.write(`${annotation}\n`);
  }
  await writeJobSummaryBestEffort(config, result, logger, dependencies.summaryAppender);
  return result;
}

async function main(): Promise<void> {
  try {
    const config = await loadConfig();
    const result = await run(config);
    if (result.status === "Failed") process.exitCode = 1;
  } catch (error) {
    const secrets = [process.env.CANVAS_ICS_URL ?? "", process.env.NOTION_TOKEN ?? ""];
    const message = safeError(error, secrets);
    if (process.env.GITHUB_ACTIONS === "true") {
      process.stdout.write(`${workflowCommand("error", message, secrets)}\n`);
    }
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
