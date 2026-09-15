import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { buildJobSummary, run, workflowAnnotations } from "../../src/cli.ts";
import type { RunResult } from "../../src/types.ts";
import {
  assignmentFeed,
  config,
  FakeGateway,
  FakeProvider,
  runCounts,
  runResult,
} from "../helpers.ts";

const emptyFeed = assignmentFeed();

function result(status: RunResult["status"]): RunResult {
  return runResult({
    status,
    counts: runCounts({
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
      missingObserved: 2,
      missingAdvanced: 1,
      missingCleared: 1,
      unchanged: 0,
      skipped: 1,
      warningCount: 1,
    }),
    warnings: [{ code: "suspicious", message: "Suspicious assignment-like event" }],
    errors: [],
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
  });
}

describe("GitHub Actions observability", () => {
  it("preserves proposed dry-run counts in the expanded job summary", () => {
    const value = result("Dry Run");
    value.metrics.descriptionIntegrityAuditsDue = 2;
    value.metrics.descriptionIntegrityAuditsDeferred = 7;
    value.plan = {
      coursesToCreate: [{ key: "course", title: "Course" }],
      coursesToUpdate: [],
      assignmentsToCreate: [],
      assignmentsToUpdate: [],
      assignmentsMissingEvidenceToUpdate: [],
      assignmentsToRemove: [],
      missingCandidatesObserved: 0,
      unchanged: 0,
      skipped: 0,
      warnings: [],
    };
    const summary = buildJobSummary(config({ mode: "dry-run", trigger: "manual" }), value);
    expect(summary).toContain("Mode: dry-run");
    expect(summary).toContain("Trigger: manual");
    expect(summary).toContain("Proposed Assignment pages: 2");
    expect(summary).toContain("Proposed Course pages: 1");
    expect(summary).toContain("Newly observed missing candidates: 2");
    expect(summary).toContain("Proposed Missing evidence advanced: 1");
    expect(summary).toContain("Removal inference safe: no");
    expect(summary).toContain("Proposed description integrity audits: 2");
    expect(summary).toContain("Description integrity audits due this run: 2");
    expect(summary).toContain("Description integrity audits deferred: 7");
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

  it("reports confirmed, recovered, and logical assignment and course totals", () => {
    const value = result("Success");
    value.metrics.assignmentPagesCreated = 2;
    value.metrics.assignmentPagesRecovered = 1;
    value.metrics.coursesCreated = 1;
    value.metrics.coursesRecovered = 2;
    const summary = buildJobSummary(config(), value);
    expect(summary).toContain("Assignment pages added: 3");
    expect(summary).toContain("Assignment pages created: 2");
    expect(summary).toContain("Assignment pages recovered: 1");
    expect(summary).toContain("Course pages added: 3");
    expect(summary).toContain("Course pages created: 1");
    expect(summary).toContain("Course pages recovered: 2");
  });

  it("keeps the job summary aggregate and omits operation and personal details", () => {
    const value = result("Failed");
    value.warnings = [
      {
        code: "course-metadata-conflict",
        message: "Private Course Name conflicted",
        details: ["notion-course-page-id"],
      },
    ];
    value.errors = ["assignment-property-update private-assignment-uid: private failure"];
    value.execution = {
      appliedOperations: [
        {
          kind: "assignment-page-create",
          target: "Private Assignment Name (private-assignment-uid)",
          pageId: "notion-assignment-page-id",
        },
      ],
      assignmentsSynchronized: [],
      partialAssignments: [],
      failedOperation: {
        kind: "assignment-property-update",
        target: "Private Assignment Name (private-assignment-uid)",
        outcome: "failed",
        message: "private failure for notion-assignment-page-id",
      },
      notAttempted: [{ kind: "assignment-description-update", target: "Private Assignment Name" }],
      ambiguousWriteRecoveries: 0,
    };

    const summary = buildJobSummary(config(), value);
    expect(summary).toContain("Status: Failed");
    expect(summary).toContain("Warnings: 1");
    expect(summary).toContain("Warning summary: course-metadata-conflict (1)");
    expect(summary).toContain(
      "Failure summary: assignment-property-update failed; 1 later operation(s) not attempted.",
    );
    expect(summary).not.toMatch(
      /Planned operations|Applied operations|Partial operations|Failed or ambiguous operation|Operations not attempted/,
    );
    expect(summary).not.toMatch(
      /Private Assignment Name|private-assignment-uid|notion-assignment-page-id|Private Course Name|notion-course-page-id|private failure/,
    );
  });

  it("does not fail a successful sync after an append failure", async () => {
    const value = await run(config({ GITHUB_STEP_SUMMARY: "summary.md" }), {
      gateway: new FakeGateway(),
      provider: new FakeProvider(emptyFeed),
      summaryAppender: () => Promise.reject(new Error("append failed")),
    });
    expect(value.status).toBe("Success");
  });

  it("preserves a failed sync after an append failure", async () => {
    const value = await run(config({ GITHUB_STEP_SUMMARY: "summary.md" }), {
      gateway: new FakeGateway(),
      provider: { fetchAssignments: () => Promise.reject(new Error("feed unavailable")) },
      summaryAppender: () => Promise.reject(new Error("append failed")),
    });
    expect(value.status).toBe("Failed");
    expect(value.errors[0]).toContain("feed unavailable");
  });

  it("normally appends the generated summary", async () => {
    let appended = "";
    const value = await run(
      config({ mode: "validate", GITHUB_STEP_SUMMARY: join(tmpdir(), "summary.md") }),
      {
        gateway: new FakeGateway(),
        provider: new FakeProvider(emptyFeed),
        summaryAppender: (_path, data, encoding) => {
          expect(encoding).toBe("utf8");
          appended = data;
          return Promise.resolve();
        },
      },
    );
    expect(value.status).toBe("Success");
    expect(appended).toContain("## Canvas");
    expect(appended).toContain("Status: Success");
  });
});
