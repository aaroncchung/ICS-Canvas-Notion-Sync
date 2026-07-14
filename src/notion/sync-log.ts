import type { AppConfig } from "../config.js";
import { workflowUrl } from "../config.js";
import { plannedOperations } from "../sync/reconcile.js";
import type { RunResult, SyncOperation } from "../types.js";
import { AmbiguousNotionWriteError, isAmbiguousWriteError, type NotionGateway } from "./client.js";
import { reconcileManagedSection } from "./managed-section.js";
import { date, number, pageId, select, text, title, url } from "./property-helpers.js";
import { pollForUniquePage, type VisibilityPollingOptions } from "./recovery.js";

export const MANAGED_SYNC_LOG_TITLE = "Canvas Sync Result — managed by sync";
export const PENDING_MANAGED_SYNC_LOG_TITLE =
  "Canvas Sync Result — managed by sync [replacement pending]";

function heading(value: string): Record<string, unknown> {
  return {
    object: "block",
    type: "heading_2",
    heading_2: { rich_text: [{ type: "text", text: { content: value } }] },
  };
}

function paragraph(value: string): Record<string, unknown> {
  return {
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: [{ type: "text", text: { content: value.slice(0, 2000) } }],
    },
  };
}

function section(titleValue: string, lines: string[]): Array<Record<string, unknown>> {
  return [heading(titleValue), ...(lines.length ? lines : ["None"]).map(paragraph)];
}

function operation(value: SyncOperation): string {
  return `${value.kind}: ${value.target}`;
}

function resultBlocks(result: RunResult): Array<Record<string, unknown>> {
  const execution = result.execution;
  const planned = result.plan ? plannedOperations(result.plan).map(operation) : [];
  const applied = execution
    ? execution.appliedOperations.map(
        (item) =>
          `${operation(item)}${item.pageId ? ` -> ${item.pageId}` : ""}${item.recovered ? " (recovered)" : ""}`,
      )
    : [];
  const partial =
    execution?.partialAssignments.map(
      (item) =>
        `${item.intent} ${item.target} -> ${item.pageId}: completed ${item.completedSubsteps.join(", ")}; requires repair at ${item.failedSubstep?.kind ?? "unknown substep"}`,
    ) ?? [];
  const failed = execution?.failedOperation
    ? [
        `${operation(execution.failedOperation)} [${execution.failedOperation.outcome}]: ${execution.failedOperation.message}`,
      ]
    : [];
  return [
    ...section("Removal evidence", [
      `Newly observed missing candidates: ${result.counts.missingObserved}`,
      `Missing evidence advanced: ${result.counts.missingAdvanced}`,
      `Missing evidence cleared: ${result.counts.missingCleared}`,
      `Assignments marked removed: ${result.counts.removed}`,
    ]),
    ...section("Planned operations", planned),
    ...section("Applied operations", applied),
    ...section("Partial operations", partial),
    ...section("Failed or ambiguous operation", failed),
    ...section("Operations not attempted", execution?.notAttempted.map(operation) ?? []),
    ...section(
      "Warnings",
      result.warnings.map((warning) => `${warning.code}: ${warning.message}`),
    ),
    ...section("Errors", result.errors),
  ];
}

function runTitle(config: AppConfig, startedAt: string): string {
  return config.GITHUB_RUN_ID
    ? `Canvas sync GitHub run ${config.GITHUB_RUN_ID}`
    : `Canvas sync ${startedAt}`;
}

function logProperties(
  config: AppConfig,
  startedAt: string,
  finishedAt: string,
  result: RunResult,
): Record<string, unknown> {
  const mode =
    config.mode === "dry-run" ? "Dry Run" : config.mode === "validate" ? "Validate" : "Sync";
  const properties: Record<string, unknown> = {
    Run: title(runTitle(config, startedAt)),
    "Started At": date(startedAt),
    "Finished At": date(finishedAt),
    Status: select(result.status),
    Trigger: select(config.trigger === "scheduled" ? "Scheduled" : "Manual"),
    Mode: select(mode),
    "Feed Items": number(result.counts.feedItems),
    "Assignments Parsed": number(result.counts.assignmentsParsed),
    Created: number(result.counts.created),
    Updated: number(result.counts.updated),
    Removed: number(result.counts.removed),
    Unchanged: number(result.counts.unchanged),
    Skipped: number(result.counts.skipped),
    "Warning Count": number(result.counts.warningCount),
    "Error Summary": text(result.errors.join("; ").slice(0, 2000)),
    "Commit SHA": text(config.GITHUB_SHA ?? ""),
  };
  const runUrl = workflowUrl(config);
  if (runUrl) properties["Workflow URL"] = url(runUrl);
  return properties;
}

export async function writeSyncLog(
  gateway: NotionGateway,
  config: AppConfig,
  startedAt: string,
  finishedAt: string,
  result: RunResult,
  recoveryOptions: VisibilityPollingOptions = {},
): Promise<void> {
  const properties = logProperties(config, startedAt, finishedAt, result);
  const query = () =>
    gateway.queryDataSource(config.NOTION_SYNC_LOG_DATA_SOURCE_ID, {
      property: "Run",
      title: { equals: runTitle(config, startedAt) },
    });
  const matches = await query();
  if (matches.length > 1) {
    throw new AmbiguousNotionWriteError(
      `Sync Log create is ambiguous: ${matches.length} pages match this workflow run`,
    );
  }

  let logPageId = matches[0] ? pageId(matches[0]) : undefined;
  if (logPageId) {
    await gateway.updatePage(logPageId, properties);
  } else {
    try {
      logPageId = await gateway.createPage(config.NOTION_SYNC_LOG_DATA_SOURCE_ID, properties, {
        operation: "sync-log-create",
      });
    } catch (error) {
      if (!isAmbiguousWriteError(error)) throw error;
      const recovered = await pollForUniquePage(
        query,
        (count) => `Sync Log create is ambiguous: ${count} matching pages found`,
        recoveryOptions,
      );
      if (!recovered) {
        throw new AmbiguousNotionWriteError(
          "Sync Log create is ambiguous: no matching page became visible; creation was not retried",
        );
      }
      logPageId = pageId(recovered);
      if (gateway.metrics) gateway.metrics.ambiguousWriteRecoveries += 1;
      await gateway.updatePage(logPageId, properties);
    }
  }

  await reconcileManagedSection(
    gateway,
    logPageId,
    { managed: MANAGED_SYNC_LOG_TITLE, pending: PENDING_MANAGED_SYNC_LOG_TITLE },
    resultBlocks(result),
  );
}
