import type { AppConfig } from "../config.js";
import { workflowUrl } from "../config.js";
import type { RunResult, SyncPlan } from "../types.js";
import type { NotionGateway } from "./client.js";
import { date, number, select, text, title, url } from "./property-helpers.js";

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

function planBlocks(plan: SyncPlan | undefined, result: RunResult): Array<Record<string, unknown>> {
  return [
    ...section(
      "Created assignments",
      plan?.assignmentsToCreate.map((item) => `UID: ${item.source.uid}`) ?? [],
    ),
    ...section(
      "Updated assignments",
      plan?.assignmentsToUpdate.map((item) => `Page: ${item.pageId}`) ?? [],
    ),
    ...section(
      "Removed assignments",
      plan?.assignmentsToRemove.map((item) => `Page: ${item.pageId}`) ?? [],
    ),
    ...section(
      "New courses",
      plan?.coursesToCreate.map((item) => `${item.title} (${item.key})`) ?? [],
    ),
    ...section(
      "Ambiguous courses",
      result.warnings
        .filter((warning) => warning.code === "ambiguous-course")
        .flatMap((warning) => warning.details ?? [warning.message]),
    ),
    ...section(
      "Possible duplicates",
      result.warnings
        .filter((warning) => warning.code.includes("duplicate"))
        .flatMap((warning) => warning.details ?? [warning.message]),
    ),
    ...section(
      "Skipped events",
      result.warnings
        .filter((warning) => warning.code.includes("skipped") || warning.code.includes("malformed"))
        .map((warning) => warning.message),
    ),
    ...section(
      "Warnings",
      result.warnings.map((warning) => `${warning.code}: ${warning.message}`),
    ),
    ...section("Errors", result.errors),
  ];
}

export async function writeSyncLog(
  gateway: NotionGateway,
  config: AppConfig,
  startedAt: string,
  finishedAt: string,
  result: RunResult,
): Promise<void> {
  const mode =
    config.mode === "dry-run" ? "Dry Run" : config.mode === "validate" ? "Validate" : "Sync";
  const properties: Record<string, unknown> = {
    Run: title(`Canvas sync ${startedAt}`),
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
  const pageId = await gateway.createPage(config.NOTION_SYNC_LOG_DATA_SOURCE_ID, properties);
  const blocks = planBlocks(result.plan, result);
  for (let index = 0; index < blocks.length; index += 100) {
    await gateway.appendBlocks(pageId, blocks.slice(index, index + 100));
  }
}
