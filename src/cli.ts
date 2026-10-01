import { failureSummary, reportLines, warningSummary } from "./observability/report-content.ts";
import {
  createRunMetrics,
  createRequestMetrics,
  emptyCounts,
  finalizeRun,
  requestDifference,
} from "./observability/run-report.ts";
import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { Logger } from "pino";
import { loadConfig, type AppConfig } from "./config.ts";
import { CanvasIcsProvider } from "./canvas/provider.ts";
import { readAssignments } from "./notion/assignments.ts";
import { OfficialNotionGateway, settleReads, type NotionGateway } from "./notion/client.ts";
import { readCourses } from "./notion/courses.ts";
import { validateNotionSchemas } from "./notion/schema-validator.ts";
import { writeSyncLog } from "./notion/sync-log.ts";
import { createLogger } from "./observability/logger.ts";
import { redactText, safeDiagnostic, safeError } from "./observability/redaction.ts";
import { buildPlan, feedDiagnosticSummary, feedWarnings } from "./sync/plan.ts";
import { ApplyPlanError, applyPlan } from "./sync/reconcile.ts";
import type { AssignmentProvider, RunResult } from "./types.ts";

export interface RunDependencies {
  gateway?: NotionGateway;
  provider?: AssignmentProvider;
  summaryAppender?: SummaryAppender;
  now?: () => Date;
  logger?: Logger;
}

export type SummaryAppender = (path: string, data: string, encoding: "utf8") => Promise<void>;

export function buildJobSummary(config: AppConfig, result: RunResult): string {
  const warnings = warningSummary(result);
  const failure = failureSummary(result);
  return [
    "## Canvas–Notion sync",
    "",
    `- Status: ${result.status}`,
    `- Mode: ${config.mode}`,
    `- Trigger: ${config.trigger}`,
    ...reportLines(config, result).map((line) => `- ${line}`),
    ...(warnings ? ["", `Warning summary: ${warnings}`] : []),
    ...(failure ? ["", `Failure summary: ${failure}`] : []),
    "",
  ].join("\n");
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

/**
 * Annotations are public in a public repository's Actions logs, so they carry only aggregate
 * counts, warning messages built from counts, and the failure summary. Failure details, which
 * can name a Canvas UID or quote description text, stay in the Notion Sync Log.
 */
export function workflowAnnotations(config: AppConfig, result: RunResult): string[] {
  if (config.GITHUB_ACTIONS !== "true") return [];
  const secrets = [config.CANVAS_ICS_URL, config.NOTION_TOKEN];
  const annotations =
    result.status === "Failed"
      ? [workflowCommand("error", failureSummary(result) ?? "Synchronization failed", secrets)]
      : [];
  // Warnings are annotated whatever the status: dry runs are how a new feed is inspected, and a
  // failed run may still have found suspicious events.
  if (!result.warnings.length) return annotations;
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
  annotations.push(
    workflowCommand(
      "warning",
      `Run found meaningful diagnostics (${diagnosticCounts})${warningSummary ? `: ${warningSummary}` : ""}`,
      secrets,
    ),
  );
  return annotations;
}

export async function run(
  config: AppConfig,
  dependencies: RunDependencies = {},
): Promise<RunResult> {
  const secrets = [config.CANVAS_ICS_URL, config.NOTION_TOKEN];
  const logger = dependencies.logger ?? createLogger();

  const gateway = dependencies.gateway ?? new OfficialNotionGateway(config.NOTION_TOKEN, logger);
  const baseline = requestDifference(gateway.requestMetrics, createRequestMetrics());
  const metrics = createRunMetrics();
  const provider = dependencies.provider ?? new CanvasIcsProvider(config, logger);
  const now = dependencies.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const counts = emptyCounts();
  let result: RunResult = { status: "Failed", counts, warnings: [], errors: [], metrics };

  try {
    await validateNotionSchemas(gateway, config);
    const feed = await provider.fetchAssignments();
    const diagnosticSummary = feedDiagnosticSummary(feed);
    result.feedDiagnostics = diagnosticSummary;
    result.warnings = feedWarnings(feed);

    if (config.mode === "validate") {
      const warnings = feedWarnings(feed);
      result = {
        status: warnings.length ? "Warning" : "Success",
        counts,
        warnings,
        errors: [],
        feedDiagnostics: diagnosticSummary,
        metrics,
      };
    } else {
      const [existingAssignments, courses] = await settleReads([
        readAssignments(gateway, config.NOTION_ASSIGNMENTS_DATA_SOURCE_ID),
        readCourses(gateway, config.NOTION_COURSES_DATA_SOURCE_ID),
      ]);
      const plan = buildPlan(feed, existingAssignments, courses, {
        aliases: config.aliases,
        disableRemovals: config.disableRemovals,
        notionTimezone: config.NOTION_TIMEZONE,
        now: now(),
        trigger: config.trigger,
        minimumMissingIntervalMs: config.CANVAS_MISSING_EVIDENCE_MINIMUM_HOURS * 60 * 60 * 1000,
      });
      for (const warning of plan.warnings.filter(
        (item) => item.code === "course-metadata-conflict",
      )) {
        logger.warn(
          { code: warning.code, pageIds: warning.details ?? [], canvasIdentifiers: "[REDACTED]" },
          warning.message,
        );
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
        result.execution = await applyPlan(gateway, config, plan, { now });
      }
    }
  } catch (error) {
    if (error instanceof ApplyPlanError) result.execution = error.execution;
    result.status = "Failed";
    result.errors.push(safeError(error, secrets));
    const diagnostic = safeDiagnostic(error, secrets);
    // The cause of an apply failure can quote assignment text; the Sync Log records it instead.
    if (error instanceof ApplyPlanError) delete diagnostic.cause;
    logger.error({ diagnostic }, "Synchronization run failed");
  }
  const reportingStart = requestDifference(gateway.requestMetrics, createRequestMetrics());
  result = finalizeRun(result, config.mode, requestDifference(reportingStart, baseline));
  if (config.mode === "sync") {
    try {
      await writeSyncLog(gateway, config, startedAt, now().toISOString(), result);
    } catch (error) {
      result.status = "Failed";
      result.errors.push(`Sync Log write failed: ${safeError(error, secrets)}`);
      result.errors.push("Sync Log write failed; creation was not blindly retried");
      // The Sync Log quotes failure details, and a failed write of it (for example a verification
      // mismatch) can quote them back, so only the failure's classification is logged.
      const { name, failureClass, status, code, operation } = safeDiagnostic(error, secrets);
      logger.error(
        { diagnostic: { name, failureClass, status, code, operation } },
        "Could not persist the run to Notion Sync Log",
      );
    }
  }
  result.reportingRequests = requestDifference(gateway.requestMetrics, reportingStart);
  logger.debug(
    { metrics: result.metrics, reportingRequests: result.reportingRequests },
    "Notion and reconciliation metrics",
  );
  logger.info({ status: result.status, counts: result.counts }, "Synchronization run complete");
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
