import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { loadConfig, type AppConfig } from "./config.js";
import { CanvasIcsProvider } from "./canvas/provider.js";
import { readAssignments } from "./notion/assignments.js";
import { OfficialNotionGateway, type NotionGateway } from "./notion/client.js";
import { readCourses } from "./notion/courses.js";
import { validateNotionSchemas } from "./notion/schema-validator.js";
import { writeSyncLog } from "./notion/sync-log.js";
import { createLogger } from "./observability/logger.js";
import { safeError } from "./observability/redaction.js";
import { buildPlan } from "./sync/plan.js";
import { applyPlan } from "./sync/reconcile.js";
import type { AssignmentFeed, AssignmentProvider, RunCounts, RunResult } from "./types.js";

export interface RunDependencies {
  gateway?: NotionGateway;
  provider?: AssignmentProvider & { lastFeed?: AssignmentFeed };
}

function emptyCounts(): RunCounts {
  return {
    feedItems: 0,
    assignmentsParsed: 0,
    created: 0,
    updated: 0,
    removed: 0,
    unchanged: 0,
    skipped: 0,
    warningCount: 0,
  };
}

async function writeSummary(config: AppConfig, result: RunResult): Promise<void> {
  const lines = [
    "## Canvas–Notion sync",
    "",
    `- Status: ${result.status}`,
    `- Mode: ${config.mode}`,
    `- Feed events: ${result.counts.feedItems}`,
    `- Assignments parsed: ${result.counts.assignmentsParsed}`,
    `- Created: ${result.counts.created}`,
    `- Updated: ${result.counts.updated}`,
    `- Removed: ${result.counts.removed}`,
    `- Unchanged: ${result.counts.unchanged}`,
    `- Skipped: ${result.counts.skipped}`,
    `- Warnings: ${result.counts.warningCount}`,
    ...(result.errors.length ? ["", `Errors: ${result.errors.join("; ")}`] : []),
    "",
  ];
  if (config.GITHUB_STEP_SUMMARY) {
    await appendFile(config.GITHUB_STEP_SUMMARY, lines.join("\n"), "utf8");
  }
}

export async function run(
  config: AppConfig,
  dependencies: RunDependencies = {},
): Promise<RunResult> {
  const secrets = [config.CANVAS_ICS_URL, config.NOTION_TOKEN];
  const logger = createLogger();
  const gateway = dependencies.gateway ?? new OfficialNotionGateway(config.NOTION_TOKEN, logger);
  const provider = dependencies.provider ?? new CanvasIcsProvider(config, logger);
  const startedAt = new Date().toISOString();
  const counts = emptyCounts();
  let result: RunResult = { status: "Failed", counts, warnings: [], errors: [] };

  try {
    await validateNotionSchemas(gateway, config);
    const sourceAssignments = await provider.fetchAssignments();
    const feed = provider.lastFeed;
    if (!feed) throw new Error("Assignment provider did not supply feed diagnostics");
    counts.feedItems = feed.diagnostics.totalEvents;
    counts.assignmentsParsed = sourceAssignments.length;
    counts.skipped = feed.diagnostics.events.length;

    if (config.mode === "validate") {
      result = { status: "Success", counts, warnings: [], errors: [] };
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
      );
      counts.unchanged = plan.unchanged;
      counts.skipped = plan.skipped;
      counts.warningCount = plan.warnings.length;
      if (config.mode === "dry-run") {
        counts.created = plan.assignmentsToCreate.length;
        counts.updated = plan.assignmentsToUpdate.length;
        counts.removed = plan.assignmentsToRemove.length;
      }
      result = {
        status:
          config.mode === "dry-run" ? "Dry Run" : plan.warnings.length ? "Warning" : "Success",
        counts,
        warnings: plan.warnings,
        errors: [],
        plan,
      };
      if (config.mode === "sync") await applyPlan(gateway, config, plan, counts);
    }

    if (config.mode === "sync") {
      await writeSyncLog(gateway, config, startedAt, new Date().toISOString(), result);
    }
    logger.info({ status: result.status, counts: result.counts }, "Synchronization run complete");
  } catch (error) {
    const message = safeError(error, secrets);
    result.status = "Failed";
    result.errors.push(message);
    logger.error({ error: message, counts }, "Synchronization run failed");
    if (config.mode === "sync") {
      try {
        await writeSyncLog(gateway, config, startedAt, new Date().toISOString(), result);
      } catch (logError) {
        const logMessage = safeError(logError, secrets);
        result.errors.push(`Sync Log write failed: ${logMessage}`);
        logger.error({ error: logMessage }, "Could not persist the failed run to Notion Sync Log");
      }
    }
  }
  await writeSummary(config, result);
  return result;
}

async function main(): Promise<void> {
  try {
    const config = await loadConfig();
    const result = await run(config);
    if (result.status === "Failed") process.exitCode = 1;
  } catch (error) {
    const message = safeError(error, [
      process.env.CANVAS_ICS_URL ?? "",
      process.env.NOTION_TOKEN ?? "",
    ]);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
