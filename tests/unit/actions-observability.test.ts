import { describe, expect, it } from "vitest";
import { buildJobSummary, workflowAnnotations } from "../../src/cli.js";
import { createRunMetrics } from "../../src/notion/client.js";
import type { RunResult } from "../../src/types.js";
import { config } from "../helpers.js";

function result(status: RunResult["status"]): RunResult {
  return {
    status,
    counts: {
      feedItems: 9,
      assignmentsParsed: 3,
      cancelledAssignments: 1,
      ignoredEvents: 2,
      suspiciousEvents: 1,
      malformedEvents: 1,
      duplicateUids: 1,
      quarantinedUids: 2,
      created: 2,
      updated: 1,
      coursesUpdated: 1,
      removed: 1,
      unchanged: 0,
      skipped: 1,
      warningCount: 1,
    },
    warnings: [{ code: "suspicious", message: "Suspicious assignment-like event" }],
    errors: [],
    metrics: createRunMetrics(),
    feedDiagnostics: {
      totalEvents: 9,
      activeAssignments: 3,
      cancelledAssignments: 1,
      ignoredEvents: 2,
      suspiciousEvents: 1,
      malformedEvents: 1,
      duplicateUids: 1,
      quarantinedUids: 2,
      absenceRemovalSafe: false,
    },
  };
}

describe("GitHub Actions observability", () => {
  it("preserves proposed dry-run counts in the expanded job summary", () => {
    const value = result("Dry Run");
    value.plan = {
      coursesToCreate: [{ key: "course", title: "Course" }],
      coursesToUpdate: [],
      assignmentsToCreate: [],
      assignmentsToUpdate: [],
      assignmentsToRemove: [],
      unchanged: 0,
      skipped: 0,
      warnings: [],
    };
    const summary = buildJobSummary(config({ mode: "dry-run", trigger: "manual" }), value);
    expect(summary).toContain("Mode: dry-run");
    expect(summary).toContain("Trigger: manual");
    expect(summary).toContain("Proposed Assignments created: 2");
    expect(summary).toContain("Proposed Courses created: 1");
    expect(summary).toContain("Removal inference safe: no");
  });

  it("emits sanitized fatal annotations only in GitHub Actions", () => {
    const failed = result("Failed");
    failed.errors = [
      `Failed with ${config().NOTION_TOKEN}\n    at privateFunction (secret.ts:1:1)`,
    ];
    expect(workflowAnnotations(config(), failed)).toEqual([]);
    const annotations = workflowAnnotations(config({ GITHUB_ACTIONS: "true" }), failed);
    expect(annotations[0]).toMatch(/^::error::/);
    expect(annotations[0]).not.toContain(config().NOTION_TOKEN);
    expect(buildJobSummary(config(), failed)).not.toContain("privateFunction");
  });

  it("warns for meaningful diagnostics but not ordinary successful ignored events", () => {
    expect(workflowAnnotations(config({ GITHUB_ACTIONS: "true" }), result("Warning"))[0]).toMatch(
      /^::warning::/,
    );
    const successful = result("Success");
    successful.counts.ignoredEvents = 5;
    expect(workflowAnnotations(config({ GITHUB_ACTIONS: "true" }), successful)).toEqual([]);
  });
});
