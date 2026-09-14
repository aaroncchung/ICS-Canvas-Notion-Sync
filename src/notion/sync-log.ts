import type { AppConfig } from "../config.js";
import { workflowUrl } from "../config.js";
import { reportSections } from "../observability/report-content.js";
import type { RunResult } from "../types.js";
import { AmbiguousNotionWriteError, isAmbiguousWriteError, type NotionGateway } from "./client.js";
import { createManagedSectionSnapshot, reconcileManagedSection } from "./managed-section.js";
import { date, number, pageId, select, text, title, url } from "./property-helpers.js";
import { pollForUniquePage, type VisibilityPollingOptions } from "./recovery.js";
import { blockBatch, paragraph, toggle } from "./blocks.js";

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

function section(titleValue: string, lines: string[]): Array<Record<string, unknown>> {
  const content = lines.length ? lines.join("\n") : "None";
  const blocks = [heading(titleValue)];
  for (let offset = 0; offset < content.length; offset += 1900)
    blocks.push(paragraph(content.slice(offset, offset + 1900)));
  return blocks;
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
  const blocks = reportSections(config, result).flatMap((value) =>
    section(value.title, value.lines),
  );
  const fitsCreate = blockBatch(blocks).length === blocks.length;
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
  let initialRootBlocks: Array<Record<string, unknown>> | undefined;
  if (logPageId) {
    await gateway.updatePage(logPageId, properties);
  } else {
    try {
      logPageId = await gateway.createPage(config.NOTION_SYNC_LOG_DATA_SOURCE_ID, properties, {
        operation: "sync-log-create",
        ...(fitsCreate ? { children: [toggle(MANAGED_SYNC_LOG_TITLE, blocks)] } : {}),
      });
      // The acknowledged create includes the complete body. Only reused or
      // ambiguously-created pages need observation and replacement recovery.
      if (fitsCreate) return;
      initialRootBlocks = [];
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
      await gateway.updatePage(logPageId, properties);
    }
  }

  const snapshot = await createManagedSectionSnapshot(
    gateway,
    logPageId,
    { managed: MANAGED_SYNC_LOG_TITLE, pending: PENDING_MANAGED_SYNC_LOG_TITLE },
    blocks,
    initialRootBlocks,
  );
  await reconcileManagedSection(gateway, snapshot);
}
