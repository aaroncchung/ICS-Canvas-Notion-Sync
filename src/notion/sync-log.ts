import type { AppConfig } from "../config.js";
import { workflowUrl } from "../config.js";
import type { RunResult, SyncOperation } from "../types.js";
import { AmbiguousNotionWriteError, isAmbiguousWriteError, type NotionGateway } from "./client.js";
import { date, number, pageId, select, text, title, url } from "./property-helpers.js";

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

function operation(operation: SyncOperation): string {
  return `${operation.kind}: ${operation.target}`;
}

function resultBlocks(result: RunResult): Array<Record<string, unknown>> {
  const plan = result.plan;
  const execution = result.execution;
  const planned = plan
    ? [
        ...plan.coursesToCreate.map((item) => `course-create: ${item.key}`),
        ...plan.assignmentsToCreate.map((item) => `assignment-create: ${item.source.uid}`),
        ...plan.assignmentsToUpdate.map((item) => `assignment-update: ${item.pageId}`),
        ...plan.assignmentsToRemove.map((item) => `assignment-remove: ${item.pageId}`),
      ]
    : [];
  const applied = execution
    ? [
        ...execution.coursesCreated.map(
          (item) => `${operation(item)}${item.recovered ? " (recovered)" : ""}`,
        ),
        ...execution.assignmentsCreated.map(
          (item) => `${operation(item)}${item.recovered ? " (recovered)" : ""}`,
        ),
        ...execution.assignmentsUpdated.map(operation),
        ...execution.assignmentsRemoved.map(operation),
      ]
    : [];
  const failed = execution?.failedOperation
    ? [
        `${operation(execution.failedOperation)} [${execution.failedOperation.outcome}]: ${execution.failedOperation.message}`,
      ]
    : [];
  return [
    ...section("Planned changes", planned),
    ...section("Successfully applied changes", applied),
    ...section("Failed or ambiguous change", failed),
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
): Promise<void> {
  const properties = logProperties(config, startedAt, finishedAt, result);
  const matches = await gateway.queryDataSource(config.NOTION_SYNC_LOG_DATA_SOURCE_ID, {
    property: "Run",
    title: { equals: runTitle(config, startedAt) },
  });
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
      const recovered = await gateway.queryDataSource(config.NOTION_SYNC_LOG_DATA_SOURCE_ID, {
        property: "Run",
        title: { equals: runTitle(config, startedAt) },
      });
      if (recovered.length !== 1) {
        throw new AmbiguousNotionWriteError(
          `Sync Log create is ambiguous: ${recovered.length} matching pages found`,
        );
      }
      logPageId = pageId(recovered[0]!);
    }
  }

  if ((await gateway.listBlocks(logPageId)).length) return;
  const blocks = resultBlocks(result);
  for (let index = 0; index < blocks.length; index += 100) {
    await gateway.appendBlocks(logPageId, blocks.slice(index, index + 100));
  }
}
