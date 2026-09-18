import { describe, expect, it, vi } from "vitest";
import { buildJobSummary, run } from "../../src/cli.ts";
import { blockText } from "../../src/notion/managed-section.ts";
import { managedDescriptionHash } from "../../src/notion/descriptions.ts";
import {
  createRequestMetrics,
  finalizeRun,
  runMetrics,
} from "../../src/observability/run-report.ts";
import { reportLines, reportSections } from "../../src/observability/report-content.ts";
import { buildPlan, type PlanOptions } from "../../src/sync/plan.ts";
import { ApplyPlanError, applyPlan } from "../../src/sync/reconcile.ts";
import type { AssignmentFeed, AssignmentRecord, CourseRecord, SyncPlan } from "../../src/types.ts";
import {
  assignmentFeed,
  config,
  FakeGateway,
  FakeProvider,
  plannedOperations,
  runResult,
} from "../helpers.ts";

const now = new Date("2026-09-14T12:00:00Z");
const source = {
  uid: "one",
  title: "One",
  courseName: "Biology",
  canvasCourseId: "7",
  inferredType: "Other" as const,
};
const feed = assignmentFeed({ assignments: [source] });
const makePlan = () => buildPlan(feed, [], [], { notionTimezone: "UTC", now });

describe("run reporting sources of truth", () => {
  it("returns planning facts without mutating any input and repeats deterministically", () => {
    const record: AssignmentRecord = {
      uid: source.uid,
      pageId: "one",
      title: source.title,
      coursePageIds: ["biology"],
      removed: false,
      canvasState: "Active",
      descriptionHash: managedDescriptionHash(undefined),
      descriptionVerifiedAt: now.toISOString(),
    };
    const inputs: [AssignmentFeed, AssignmentRecord[], CourseRecord[], PlanOptions] = [
      structuredClone(feed),
      [record],
      [{ pageId: "biology", title: "Biology", canvasCourseId: "7" }],
      { aliases: {}, notionTimezone: "UTC", now: new Date(now) },
    ];
    function freeze(value: unknown): void {
      if (!value || typeof value !== "object") return;
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
    freeze(inputs);
    const first = buildPlan(...inputs);
    expect(buildPlan(...inputs)).toEqual(first);
    expect(first.planning?.descriptionUpdatesAvoided).toBe(1);
    expect(runMetrics(first).descriptionUpdatesAvoided).toBe(1);
  });

  it.each([false, true])(
    "separates planned, confirmed, recovered, and completed work (recovered=%s)",
    async (recovered) => {
      const gateway = new FakeGateway();
      gateway.simulateDefaultTemplate = true;
      if (recovered) {
        gateway.failCreate({ id: "courses", code: "ECONNRESET", applied: true });
        gateway.failCreate({ id: "assignments", code: "ECONNRESET", applied: true });
      }
      const plan = makePlan();
      const dry = finalizeRun(
        runResult({ plan, status: "Dry Run" }),
        "dry-run",
        createRequestMetrics(),
      );
      expect(dry.plannedCounts?.created).toBe(1);
      expect(dry.executedCounts?.created).toBe(0);
      expect(dry.metrics.descriptionIntegrityAuditsDue).toBe(1);
      expect(dry.metrics.descriptionIntegrityAuditsRun).toBe(0);
      expect(reportSections(config({ mode: "dry-run" }), dry)).toContainEqual({
        title: "Operations not attempted",
        lines: plannedOperations(plan).map((value) => `${value.kind}: ${value.target}`),
      });
      const execution = await applyPlan(gateway, config(), plan, {
        templateWait: { sleep: async () => {} },
      });
      const live = finalizeRun(runResult({ plan, execution }), "sync", createRequestMetrics());
      expect(live.plannedCounts).toEqual(dry.plannedCounts);
      expect(live.counts.created).toBe(recovered ? 0 : 1);
      expect(live.metrics.assignmentPagesRecovered).toBe(recovered ? 1 : 0);
      expect(live.metrics.coursesCreated + live.metrics.coursesRecovered).toBe(1);
      expect(live.metrics.ambiguousWriteRecoveries).toBe(recovered ? 2 : 0);
      expect(live.execution?.assignmentsSynchronized).toHaveLength(1);
    },
  );

  it("retains completed repair and lifecycle effects when the metadata commit fails", async () => {
    const gateway = new FakeGateway();
    const plan: SyncPlan = {
      ...makePlan(),
      coursesToCreate: [],
      assignmentsToCreate: [],
      assignmentsToUpdate: [
        {
          pageId: "one",
          source,
          courseKey: "page:biology",
          properties: { canvasMissingSince: null, canvasMissingCount: null },
          verifyDescription: true,
          descriptionHash: managedDescriptionHash(undefined),
          missingEvidenceCleared: true,
        },
      ],
      assignmentsToRemove: [
        {
          pageId: "remove",
          uid: "remove",
          title: "Remove",
          coursePageIds: [],
          removed: false,
          reason: "explicit-cancellation",
          markRemoved: true,
          clearMissingEvidence: false,
        },
      ],
    };
    const update = gateway.updatePage.bind(gateway);
    vi.spyOn(gateway, "updatePage").mockImplementation((id, properties) => {
      if (properties["Canvas Description Verified At"])
        throw Object.assign(new Error("metadata failed"), { status: 400 });
      return update(id, properties);
    });
    let failure: ApplyPlanError | undefined;
    try {
      await applyPlan(gateway, config(), plan);
    } catch (error) {
      if (!(error instanceof ApplyPlanError)) throw error;
      failure = error;
    }
    expect(failure).toBeInstanceOf(ApplyPlanError);
    const report = finalizeRun(
      runResult({ plan, execution: failure!.execution, status: "Failed" }),
      "sync",
      createRequestMetrics(),
    );
    expect(report.counts).toMatchObject({ updated: 0, removed: 0, missingCleared: 1 });
    expect(report.plannedCounts).toMatchObject({ updated: 1, removed: 1 });
    expect(report.metrics).toMatchObject({
      descriptionIntegrityAuditsRun: 1,
      descriptionIntegrityRepairs: 1,
      descriptionReplacements: 1,
    });
    expect(report.execution?.partialAssignments).toHaveLength(1);
    expect(report.execution?.notAttempted).toEqual(plannedOperations(plan).slice(3));
  });

  it.each([false, true])(
    "snapshots requests before logging and isolates reused gateways (log failure=%s)",
    async (failLog) => {
      const gateway = new FakeGateway();
      // Instrument actual fake dispatches; real transport pagination/retry coverage is separate.
      function observe<A extends unknown[], T>(operation: (...args: A) => Promise<T>) {
        return async (...args: A): Promise<T> => {
          gateway.requestMetrics.notionRequests += 1;
          gateway.requestMetrics.requestsByOperation.read =
            (gateway.requestMetrics.requestsByOperation.read ?? 0) + 1;
          return operation(...args);
        };
      }
      vi.spyOn(gateway, "retrieveDataSource").mockImplementation(
        observe(FakeGateway.prototype.retrieveDataSource.bind(gateway)),
      );
      vi.spyOn(gateway, "queryDataSource").mockImplementation(
        observe(FakeGateway.prototype.queryDataSource.bind(gateway)),
      );
      vi.spyOn(gateway, "listBlocks").mockImplementation(
        observe(FakeGateway.prototype.listBlocks.bind(gateway)),
      );
      const create = gateway.createPage.bind(gateway);
      vi.spyOn(gateway, "createPage").mockImplementation(async (id, properties, options) => {
        gateway.requestMetrics.notionRequests += 1;
        gateway.requestMetrics.requestsByOperation["sync-log-create"] =
          (gateway.requestMetrics.requestsByOperation["sync-log-create"] ?? 0) + 1;
        if (failLog) throw Object.assign(new Error("log failed"), { status: 400 });
        return create(id, properties, options);
      });
      const dependencies = {
        gateway,
        provider: new FakeProvider(assignmentFeed()),
        now: () => now,
      };
      const first = await run(config(), dependencies);
      const saved = structuredClone(first);
      const second = await run(config(), dependencies);
      expect(first).toEqual(saved);
      expect(first.metrics.notionRequests).toBe(5);
      expect(second.metrics).toEqual(first.metrics);
      expect(first.reportingRequests?.notionRequests).toBeGreaterThan(0);
      expect(first.status).toBe(failLog ? "Failed" : "Success");
      expect(buildJobSummary(config(), first)).toContain("Notion requests: 5");
      if (!failLog) {
        const text = [...gateway.blocks.values()].flat().map(blockText).join("\n");
        expect(text).toContain("Notion requests: 5");
        const properties = gateway.pages.get("log")?.[0]?.properties as Record<string, unknown>;
        expect(properties.Created).toEqual({ number: 0 });
        expect(properties).not.toHaveProperty("Notion Requests");
      }
    },
  );

  it("drains concurrent schema reads before taking the failed-run request snapshot", async () => {
    const gateway = new FakeGateway();
    vi.spyOn(gateway, "retrieveDataSource").mockImplementation(async (id) => {
      if (id !== "assignments") await new Promise((resolve) => setTimeout(resolve, 10));
      gateway.requestMetrics.notionRequests += 1;
      gateway.requestMetrics.requestsByOperation.read =
        (gateway.requestMetrics.requestsByOperation.read ?? 0) + 1;
      throw new Error(`unavailable ${id}`);
    });
    const provider = new FakeProvider(feed);
    const fetch = vi.spyOn(provider, "fetchAssignments");
    const result = await run(config({ mode: "validate" }), { gateway, provider });
    expect(result.status).toBe("Failed");
    expect(fetch).not.toHaveBeenCalled();
    expect(result.metrics.notionRequests).toBe(3);
    expect(result.reportingRequests?.notionRequests).toBe(0);
    expect(result.plan).toBeUndefined();
  });

  it("shares every report value while retaining legacy Sync Log labels", () => {
    const result = finalizeRun(runResult({ plan: makePlan() }), "sync", createRequestMetrics());
    const summary = reportLines(config(), result);
    const log = reportSections(config(), result).flatMap((section) => section.lines);
    expect(log).toContain("Audits due this run: 1");
    expect(summary).toContain("Description integrity audits due this run: 1");
    const aliases = new Set([
      "Description integrity audits due this run",
      "Description integrity audits deferred",
      "Description integrity audits run",
      "Description audits passed without repair",
      "Description integrity repairs",
    ]);
    for (const line of summary) if (!aliases.has(line.split(":")[0]!)) expect(log).toContain(line);
  });
});
