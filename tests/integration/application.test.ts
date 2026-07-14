import { describe, expect, it } from "vitest";
import { run } from "../../src/cli.js";
import { createAssignment, readAssignments } from "../../src/notion/assignments.js";
import { createRunMetrics, withRetry } from "../../src/notion/client.js";
import { createCourse } from "../../src/notion/courses.js";
import {
  MANAGED_DESCRIPTION_TITLE,
  PENDING_MANAGED_DESCRIPTION_TITLE,
  managedDescriptionHash,
  readManagedDescription,
  replaceManagedDescription,
  waitForTemplate,
} from "../../src/notion/descriptions.js";
import { deleteBlockReconciled } from "../../src/notion/managed-section.js";
import {
  MANAGED_SYNC_LOG_TITLE,
  PENDING_MANAGED_SYNC_LOG_TITLE,
  writeSyncLog,
} from "../../src/notion/sync-log.js";
import { safeDiagnostic, safeError } from "../../src/observability/redaction.js";
import { buildPlan } from "../../src/sync/plan.js";
import { ApplyPlanError, applyPlan } from "../../src/sync/reconcile.js";
import type {
  AssignmentCreate,
  AssignmentFeed,
  RunCounts,
  RunResult,
  SyncPlan,
} from "../../src/types.js";
import { config, FakeGateway, FakeProvider, StatefulFakeGateway } from "../helpers.js";

const emptyFeed: AssignmentFeed = {
  assignments: [],
  cancelledAssignments: [],
  diagnostics: {
    totalEvents: 0,
    sourceUids: [],
    normalizedAssignmentUids: [],
    quarantinedUids: [],
    events: [],
    complete: true,
  },
};

function counts(): RunCounts {
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

function assignmentCreate(uid = "uid-new"): AssignmentCreate {
  return {
    courseKey: "page:course",
    source: {
      uid,
      title: "Homework",
      inferredType: "Homework",
    },
  };
}

function richText(value: string): Record<string, unknown> {
  return { rich_text: [{ type: "text", text: { content: value } }] };
}

function toggle(id: string, value: string): Record<string, unknown> {
  return {
    id,
    type: "toggle",
    toggle: { rich_text: [{ plain_text: value }] },
  };
}

function templateBlock(id: string, value = "Template content"): Record<string, unknown> {
  return {
    id,
    type: "paragraph",
    paragraph: { rich_text: [{ plain_text: value }] },
  };
}

function blockText(block: Record<string, unknown>): string {
  const type = block.type as string;
  const content = block[type] as Record<string, unknown> | undefined;
  const values = content?.rich_text;
  if (!Array.isArray(values)) return "";
  return (values as unknown[])
    .map((value) =>
      value &&
      typeof value === "object" &&
      typeof (value as Record<string, unknown>).plain_text === "string"
        ? ((value as Record<string, unknown>).plain_text as string)
        : "",
    )
    .join("");
}

async function managedChildren(
  gateway: StatefulFakeGateway,
  pageId: string,
  marker = MANAGED_SYNC_LOG_TITLE,
): Promise<Array<Record<string, unknown>>> {
  const managed = (await gateway.listBlocks(pageId)).find((block) => blockText(block) === marker);
  if (!managed || typeof managed.id !== "string") return [];
  return gateway.listBlocks(managed.id);
}

function result(errors: string[] = []): RunResult {
  return {
    status: errors.length ? "Failed" : "Success",
    counts: counts(),
    warnings: [],
    errors,
    metrics: createRunMetrics(),
  };
}

function seedLogPage(gateway: StatefulFakeGateway, id: string, runId: string): void {
  gateway.seedPage("log", id, {
    Run: { title: [{ type: "text", text: { content: `Canvas sync GitHub run ${runId}` } }] },
  });
}

describe("application modes and failure handling", () => {
  it("23 dry-run performs complete reads but no writes", async () => {
    const gateway = new FakeGateway();
    const proposedFeed: AssignmentFeed = {
      assignments: [
        {
          uid: "uid-new",
          title: "Homework 1",
          courseName: "EE 10",
          canvasCourseId: "123",
          canvasUrl: "https://canvas.example.edu/courses/123/assignments/456",
          inferredType: "Homework",
        },
      ],
      cancelledAssignments: [],
      diagnostics: {
        ...emptyFeed.diagnostics,
        totalEvents: 1,
        sourceUids: ["uid-new"],
        normalizedAssignmentUids: ["uid-new"],
      },
    };
    const result = await run(config({ mode: "dry-run" }), {
      gateway,
      provider: new FakeProvider(proposedFeed),
    });
    expect(result.status).toBe("Dry Run");
    expect(result.counts.created).toBe(1);
    expect(gateway.writes).toEqual([]);
  });

  it("dry-run proposes a scheduled missing-evidence transition without writes", async () => {
    const gateway = new FakeGateway();
    gateway.assignments.push({
      id: "assignment-missing",
      properties: {
        Assignment: { title: [{ plain_text: "Existing" }] },
        Course: { relation: [{ id: "course" }] },
        "Canvas UID": { rich_text: [{ plain_text: "uid-missing" }] },
        "Canvas Due Date": { date: { start: "2026-07-20T20:00:00Z" } },
        "Imported From": { select: { name: "Canvas ICS" } },
        "Removed from Canvas": { checkbox: false },
        "Canvas State": { select: { name: "Active" } },
      },
    });
    gateway.courses.push({
      id: "course",
      properties: {
        Course: { title: [{ plain_text: "EE 10" }] },
        "Canvas Course ID": { rich_text: [{ plain_text: "123" }] },
      },
    });
    const present = {
      uid: "uid-present",
      title: "Present",
      courseName: "EE 10",
      canvasCourseId: "123",
      inferredType: "Homework" as const,
    };
    const proposedFeed: AssignmentFeed = {
      assignments: [present],
      cancelledAssignments: [],
      diagnostics: {
        ...emptyFeed.diagnostics,
        totalEvents: 1,
        sourceUids: [present.uid],
        normalizedAssignmentUids: [present.uid],
      },
    };
    const result = await run(config({ mode: "dry-run", trigger: "scheduled" }), {
      gateway,
      provider: new FakeProvider(proposedFeed),
    });
    expect(result.plan?.assignmentsMissingEvidenceToUpdate).toHaveLength(1);
    expect(result.counts.missingObserved).toBe(1);
    expect(result.counts.missingAdvanced).toBe(1);
    expect(result.counts.removed).toBe(0);
    expect(gateway.writes).toEqual([]);
  });

  it("24 validate mode performs no data writes", async () => {
    const gateway = new FakeGateway();
    const result = await run(config({ mode: "validate" }), {
      gateway,
      provider: new FakeProvider(emptyFeed),
    });
    expect(result.status).toBe("Success");
    expect(gateway.writes).toEqual([]);
  });

  it("dry-run proposes course enrichment without writing it", async () => {
    const gateway = new FakeGateway();
    gateway.courses.push({
      id: "course",
      properties: { Course: { title: [{ plain_text: "EE 10" }] } },
    });
    const source = {
      ...assignmentCreate().source,
      courseName: "EE 10",
      canvasCourseId: "123",
      canvasUrl: "https://canvas.example.edu/courses/123/assignments/456",
    };
    const proposedFeed: AssignmentFeed = {
      ...emptyFeed,
      assignments: [source],
      diagnostics: {
        ...emptyFeed.diagnostics,
        totalEvents: 1,
        sourceUids: [source.uid],
        normalizedAssignmentUids: [source.uid],
      },
    };
    const result = await run(config({ mode: "dry-run" }), {
      gateway,
      provider: new FakeProvider(proposedFeed),
    });
    expect(result.plan?.coursesToUpdate).toHaveLength(1);
    expect(result.counts.coursesUpdated).toBe(1);
    expect(gateway.writes).toEqual([]);
  });

  it("ordinary calendar events do not produce a warning run status", async () => {
    const gateway = new FakeGateway();
    const ordinaryFeed: AssignmentFeed = {
      ...emptyFeed,
      diagnostics: {
        ...emptyFeed.diagnostics,
        totalEvents: 1,
        sourceUids: ["calendar-event"],
        events: [
          {
            kind: "ignored",
            reason: "ordinary-calendar-event",
            uid: "calendar-event",
            indicators: [],
          },
        ],
      },
    };
    const result = await run(config(), {
      gateway,
      provider: new FakeProvider(ordinaryFeed),
    });
    expect(result.status).toBe("Success");
    expect(result.warnings).toEqual([]);
  });

  it("validate warns for unsafe feed diagnostics without writing data", async () => {
    const gateway = new FakeGateway();
    const unsafeFeed: AssignmentFeed = {
      ...emptyFeed,
      diagnostics: {
        ...emptyFeed.diagnostics,
        totalEvents: 3,
        quarantinedUids: ["secret-uid"],
        events: [
          { kind: "suspicious", reason: "assignment-like-event", indicators: [] },
          { kind: "malformed", reason: "unparseable-event", indicators: [] },
          {
            kind: "duplicate",
            reason: "duplicate-source-uid",
            uid: "secret-uid",
            indicators: [],
          },
        ],
      },
    };
    const result = await run(config({ mode: "validate" }), {
      gateway,
      provider: new FakeProvider(unsafeFeed),
    });
    expect(result.status).toBe("Warning");
    expect(result.counts).toMatchObject({
      suspiciousEvents: 1,
      malformedEvents: 1,
      duplicateUids: 1,
    });
    expect(JSON.stringify(result.warnings)).not.toContain("secret-uid");
    expect(gateway.writes).toEqual([]);
  });

  it("deterministically normalized cancellations do not force validate warnings", async () => {
    const cancelled = assignmentCreate("cancelled").source;
    const cancelledFeed: AssignmentFeed = {
      ...emptyFeed,
      cancelledAssignments: [cancelled],
      diagnostics: {
        ...emptyFeed.diagnostics,
        totalEvents: 1,
        normalizedAssignmentUids: [cancelled.uid],
        quarantinedUids: [cancelled.uid],
        events: [
          {
            kind: "cancelled",
            reason: "cancelled-assignment",
            uid: cancelled.uid,
            indicators: [],
          },
        ],
      },
    };
    const result = await run(config({ mode: "validate" }), {
      gateway: new FakeGateway(),
      provider: new FakeProvider(cancelledFeed),
    });
    expect(result.status).toBe("Success");
    expect(result.counts.cancelledAssignments).toBe(1);
  });

  it("fails validate for a provider-declared incomplete feed without data writes", async () => {
    const gateway = new FakeGateway();
    const result = await run(config({ mode: "validate" }), {
      gateway,
      provider: new FakeProvider({
        ...emptyFeed,
        diagnostics: { ...emptyFeed.diagnostics, complete: false },
      }),
    });
    expect(result.status).toBe("Failed");
    expect(gateway.writes).toEqual([]);
  });

  it("38 retries Notion rate limits with bounded backoff", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const retries: string[] = [];
    const retryMetrics = createRunMetrics();
    const value = await withRetry(
      () => {
        attempts += 1;
        if (attempts < 3)
          return Promise.reject(Object.assign(new Error("rate limited"), { status: 429 }));
        return Promise.resolve("ok");
      },
      {
        operation: "page-create",
        baseDelayMs: 1,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
        onRetry: (operation) => retries.push(operation),
        metrics: retryMetrics,
      },
    );
    expect(value).toBe("ok");
    expect(attempts).toBe(3);
    expect(sleeps).toHaveLength(2);
    expect(retries).toEqual(["page-create", "page-create"]);
    expect(retryMetrics.notionRequests).toBe(3);
    expect(retryMetrics.requestsByOperation["page-create"]).toBe(3);
  });

  it("retries deterministic page-property updates after transient failures", async () => {
    let attempts = 0;
    await withRetry(
      () => {
        attempts += 1;
        if (attempts === 1)
          return Promise.reject(Object.assign(new Error("temporary"), { status: 503 }));
        return Promise.resolve();
      },
      { operation: "property-update", baseDelayMs: 0, sleep: () => Promise.resolve() },
    );
    expect(attempts).toBe(2);
  });

  it("does not blindly retry non-idempotent creates or block appends", async () => {
    for (const operation of ["page-create", "block-append"] as const) {
      let attempts = 0;
      await expect(
        withRetry(
          () => {
            attempts += 1;
            return Promise.reject(Object.assign(new Error("ambiguous"), { status: 503 }));
          },
          { operation, baseDelayMs: 0, sleep: () => Promise.resolve() },
        ),
      ).rejects.toThrow("ambiguous");
      expect(attempts).toBe(1);
    }
  });

  it.each(["read", "property-update"] as const)(
    "counts %s retries and physical requests without duplicating logical success",
    async (operation) => {
      const metrics = createRunMetrics();
      let attempts = 0;
      await withRetry(
        () => {
          attempts += 1;
          return attempts === 1
            ? Promise.reject(Object.assign(new Error("transient"), { status: 503 }))
            : Promise.resolve();
        },
        { operation, metrics, baseDelayMs: 0, sleep: () => Promise.resolve() },
      );
      expect(metrics.notionRequests).toBe(2);
      expect(metrics.readRetries + metrics.propertyUpdateRetries).toBe(1);
    },
  );

  it("39 skips removal writes after an active assignment write fails", async () => {
    const gateway = new FakeGateway();
    gateway.failOnAssignmentWrite = true;
    const plan: SyncPlan = {
      coursesToCreate: [],
      coursesToUpdate: [],
      assignmentsToCreate: [],
      assignmentsToUpdate: [
        {
          pageId: "assignment-active",
          source: {
            uid: "uid",
            title: "Changed",
            inferredType: "Other",
          },
          courseKey: "page:course",
          properties: { title: "Changed" },
          verifyDescription: false,
          descriptionHash: managedDescriptionHash(undefined),
          missingEvidenceCleared: false,
        },
      ],
      assignmentsToRemove: [
        {
          pageId: "assignment-remove",
          uid: "removed",
          title: "Removed",
          coursePageIds: [],
          removed: false,
          reason: "persistent-absence",
          markRemoved: true,
          clearMissingEvidence: false,
        },
      ],
      assignmentsMissingEvidenceToUpdate: [],
      missingCandidatesObserved: 0,
      unchanged: 0,
      skipped: 0,
      warnings: [],
    };
    const counts: RunCounts = {
      feedItems: 1,
      assignmentsParsed: 1,
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
    await expect(applyPlan(gateway, config(), plan, counts)).rejects.toThrow("write failed");
    expect(gateway.writes.some((write) => write.id === "assignment-remove")).toBe(false);
    expect(counts.removed).toBe(0);
  });

  it("tracks a partial course-enrichment failure separately from assignment updates", async () => {
    const gateway = new StatefulFakeGateway();
    gateway.updateFailures.push({ id: "course", status: 503, applied: false });
    const plan: SyncPlan = {
      coursesToCreate: [],
      coursesToUpdate: [
        { pageId: "course", canvasCourseId: "123", syncUpdatedAt: "2026-07-13T00:00:00Z" },
      ],
      assignmentsToCreate: [],
      assignmentsToUpdate: [],
      assignmentsToRemove: [],
      assignmentsMissingEvidenceToUpdate: [],
      missingCandidatesObserved: 0,
      unchanged: 0,
      skipped: 0,
      warnings: [],
    };
    const appliedCounts = counts();
    let failure: ApplyPlanError | undefined;
    try {
      await applyPlan(gateway, config(), plan, appliedCounts);
    } catch (error) {
      if (error instanceof ApplyPlanError) failure = error;
      else throw error;
    }
    expect(failure?.execution.failedOperation).toMatchObject({ kind: "course-update" });
    expect(appliedCounts.coursesUpdated).toBe(0);
    expect(appliedCounts.updated).toBe(0);
  });

  it("applies a cancelled removal without writing Notion-owned fields", async () => {
    const gateway = new FakeGateway();
    const plan: SyncPlan = {
      coursesToCreate: [],
      coursesToUpdate: [],
      assignmentsToCreate: [],
      assignmentsToUpdate: [],
      assignmentsToRemove: [
        {
          pageId: "assignment-cancelled",
          uid: "cancelled",
          title: "Cancelled",
          coursePageIds: ["course"],
          personalStatus: "Done",
          priority: "High",
          assignmentType: "Exam",
          overrideDueDate: "2026-07-20T20:00:00.000Z",
          canvasMissingSince: "2026-07-12T00:00:00Z",
          canvasMissingCount: 1,
          removed: false,
          canvasState: "Active",
          reason: "explicit-cancellation",
          markRemoved: true,
          clearMissingEvidence: true,
        },
      ],
      assignmentsMissingEvidenceToUpdate: [],
      missingCandidatesObserved: 0,
      unchanged: 0,
      skipped: 0,
      warnings: [],
    };
    const counts: RunCounts = {
      feedItems: 1,
      assignmentsParsed: 0,
      cancelledAssignments: 1,
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
    await applyPlan(gateway, config(), plan, counts);
    const properties = gateway.writes[0]?.value as Record<string, unknown>;
    expect(properties).toHaveProperty("Removed from Canvas");
    expect(properties).toHaveProperty("Canvas State");
    expect(properties).toHaveProperty("Canvas Missing Since", { date: null });
    expect(properties).toHaveProperty("Canvas Missing Count", { number: null });
    expect(properties).not.toHaveProperty("Personal Status");
    expect(properties).not.toHaveProperty("Priority");
    expect(properties).not.toHaveProperty("Assignment Type");
    expect(properties).not.toHaveProperty("Override Due Date");
    expect(counts.removed).toBe(1);
  });

  it("40 redacts exact secrets, bearer tokens, and feed query parameters", () => {
    const secretUrl = "https://canvas.example.edu/feeds/private.ics?token=super-secret";
    const message = safeError(
      new Error(`Failed ${secretUrl} Authorization: Bearer secret_abcdefghijk`),
      [secretUrl],
    );
    expect(message).not.toContain("super-secret");
    expect(message).not.toContain("secret_abcdefghijk");
    expect(message).toContain("[REDACTED]");
  });

  it("sanitizes stacks, causes, aggregate errors, and ignores arbitrary metadata", () => {
    const token = "secret_abcdefghijk";
    const cause = new Error(`cause ${token} https://canvas.example.edu/feed.ics?token=hidden`);
    cause.stack = `Error: ${token}\n    at loadFeed (feed.ts:10:2)`;
    const aggregate = new AggregateError(
      [cause, new Error("Authorization: Bearer oauth_abcdefghijk")],
      `outer ${token}`,
      { cause },
    ) as AggregateError & { metadata?: unknown; operation?: string };
    aggregate.metadata = { description: `private body ${token}` };
    aggregate.operation = "assignment-description-update";
    const diagnostic = safeDiagnostic(aggregate, [token]);
    const serialized = JSON.stringify(diagnostic);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("oauth_abcdefghijk");
    expect(serialized).not.toContain("canvas.example.edu");
    expect(serialized).not.toContain("private body");
    expect(serialized).toContain("loadFeed (feed.ts:10:2)");
    expect(diagnostic.operation).toBe("assignment-description-update");
    const bounded = safeDiagnostic(
      new AggregateError(
        Array.from({ length: 10 }, () => new Error("x".repeat(5000))),
        "y".repeat(5000),
      ),
    );
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(6000);
  });
});

describe("ambiguous create recovery", () => {
  it("recovers an applied assignment create after a statusless transport failure", async () => {
    const gateway = new StatefulFakeGateway();
    gateway.createFailures.push({ id: "assignments", code: "ECONNRESET", applied: true });
    const result = await createAssignment(
      gateway,
      "assignments",
      assignmentCreate(),
      "course",
      "America/Los_Angeles",
    );
    expect(result.recovered).toBe(true);
    expect(gateway.metrics.ambiguousWriteRecoveries).toBe(1);
    expect(gateway.metrics.assignmentPagesRecovered).toBe(1);
    expect(gateway.writes.filter((write) => write.kind === "create")).toHaveLength(1);
  });

  it("does not create again when statusless assignment recovery finds no page", async () => {
    const gateway = new StatefulFakeGateway();
    gateway.createFailures.push({ id: "assignments", code: "ETIMEDOUT", applied: false });
    await expect(
      createAssignment(
        gateway,
        "assignments",
        assignmentCreate(),
        "course",
        "America/Los_Angeles",
        { attempts: 2, delayMs: 0, sleep: () => Promise.resolve() },
      ),
    ).rejects.toThrow("creation was not retried");
    expect(gateway.writes.filter((write) => write.kind === "create")).toHaveLength(1);
  });

  it("recovers a statusless course create by Canvas Course ID", async () => {
    const gateway = new StatefulFakeGateway();
    gateway.createFailures.push({ id: "courses", code: "UND_ERR_SOCKET", applied: true });
    const result = await createCourse(gateway, "courses", {
      key: "id:123",
      title: "EE 10",
      courseCode: "EE 10",
      canvasCourseId: "123",
    });
    expect(result.recovered).toBe(true);
    expect(gateway.metrics.coursesRecovered).toBe(1);
    expect(gateway.writes.filter((write) => write.kind === "create")).toHaveLength(1);
  });

  it("keeps confirmed and recovered create metrics disjoint", async () => {
    const gateway = new StatefulFakeGateway();
    await createAssignment(
      gateway,
      "assignments",
      assignmentCreate("uid-normal"),
      "course",
      "America/Los_Angeles",
    );
    gateway.createFailures.push({ id: "assignments", code: "ECONNRESET", applied: true });
    await createAssignment(
      gateway,
      "assignments",
      assignmentCreate("uid-recovered"),
      "course",
      "America/Los_Angeles",
    );
    await createCourse(gateway, "courses", { key: "id:1", title: "Course 1", canvasCourseId: "1" });
    gateway.createFailures.push({ id: "courses", code: "ETIMEDOUT", applied: true });
    await createCourse(gateway, "courses", { key: "id:2", title: "Course 2", canvasCourseId: "2" });
    expect(gateway.metrics).toMatchObject({
      assignmentPagesCreated: 1,
      assignmentPagesRecovered: 1,
      coursesCreated: 1,
      coursesRecovered: 1,
    });
    expect(gateway.metrics.assignmentPagesCreated + gateway.metrics.assignmentPagesRecovered).toBe(
      2,
    );
    expect(gateway.metrics.coursesCreated + gateway.metrics.coursesRecovered).toBe(2);
  });

  it("counts physical recovery polls without changing logical create metrics", async () => {
    class CountingRecoveryGateway extends StatefulFakeGateway {
      public override async createPage(
        id: string,
        properties: Record<string, unknown>,
      ): Promise<string> {
        this.metrics.notionRequests += 1;
        this.metrics.requestsByOperation["page-create"] =
          (this.metrics.requestsByOperation["page-create"] ?? 0) + 1;
        return super.createPage(id, properties);
      }

      public override async queryDataSource(
        id: string,
        filter?: Record<string, unknown>,
      ): Promise<Array<Record<string, unknown>>> {
        this.metrics.notionRequests += 1;
        this.metrics.requestsByOperation.read = (this.metrics.requestsByOperation.read ?? 0) + 1;
        return super.queryDataSource(id, filter);
      }
    }
    const gateway = new CountingRecoveryGateway();
    gateway.createFailures.push({ id: "assignments", code: "ECONNRESET", applied: true });
    gateway.queryVisibilityMisses.set("assignments", 1);
    await createAssignment(
      gateway,
      "assignments",
      assignmentCreate(),
      "course",
      "America/Los_Angeles",
      { attempts: 2, delayMs: 0, sleep: () => Promise.resolve() },
    );
    expect(gateway.metrics.notionRequests).toBe(3);
    expect(gateway.metrics.requestsByOperation).toEqual({ "page-create": 1, read: 2 });
    expect(gateway.metrics.assignmentPagesCreated).toBe(0);
    expect(gateway.metrics.assignmentPagesRecovered).toBe(1);
  });

  it("does not increment the live confirmed-create count for a recovered assignment", async () => {
    class RecoveredAssignmentGateway extends StatefulFakeGateway {
      public override async listBlocks(pageId: string): Promise<Array<Record<string, unknown>>> {
        const blocks = await super.listBlocks(pageId);
        return pageId === "assignments-1" && blocks.length === 0
          ? [templateBlock("template")]
          : blocks;
      }
    }
    const gateway = new RecoveredAssignmentGateway();
    gateway.createFailures.push({ id: "assignments", code: "ECONNRESET", applied: true });
    const appliedCounts = counts();
    await applyPlan(
      gateway,
      config(),
      {
        coursesToCreate: [],
        coursesToUpdate: [],
        assignmentsToCreate: [assignmentCreate()],
        assignmentsToUpdate: [],
        assignmentsToRemove: [],
        assignmentsMissingEvidenceToUpdate: [],
        missingCandidatesObserved: 0,
        unchanged: 0,
        skipped: 0,
        warnings: [],
      },
      appliedCounts,
      { templateWait: { attempts: 2, delayMs: 0, sleep: () => Promise.resolve() } },
    );
    expect(appliedCounts.created).toBe(0);
    expect(gateway.metrics.assignmentPagesCreated).toBe(0);
    expect(gateway.metrics.assignmentPagesRecovered).toBe(1);
  });

  it("recovers an assignment that becomes visible on a later observation poll", async () => {
    const gateway = new StatefulFakeGateway();
    gateway.createFailures.push({ id: "assignments", status: 503, applied: true });
    gateway.queryVisibilityMisses.set("assignments", 1);
    const recovered = await createAssignment(
      gateway,
      "assignments",
      assignmentCreate(),
      "course",
      "America/Los_Angeles",
      { attempts: 2, delayMs: 0, sleep: () => Promise.resolve() },
    );
    expect(recovered.recovered).toBe(true);
    expect(gateway.writes.filter((write) => write.kind === "create")).toHaveLength(1);
  });

  it("recovers a course that becomes visible on a later observation poll", async () => {
    const gateway = new StatefulFakeGateway();
    gateway.createFailures.push({ id: "courses", status: 503, applied: true });
    gateway.queryVisibilityMisses.set("courses", 1);
    const recovered = await createCourse(
      gateway,
      "courses",
      { key: "id:123", title: "EE 10", canvasCourseId: "123" },
      { attempts: 2, delayMs: 0, sleep: () => Promise.resolve() },
    );
    expect(recovered.recovered).toBe(true);
    expect(gateway.writes.filter((write) => write.kind === "create")).toHaveLength(1);
  });

  it("fails explicitly when assignment recovery finds multiple matching pages", async () => {
    const gateway = new StatefulFakeGateway();
    gateway.seedPage("assignments", "assignment-1", { "Canvas UID": richText("uid-new") });
    gateway.seedPage("assignments", "assignment-2", { "Canvas UID": richText("uid-new") });
    gateway.createFailures.push({ id: "assignments", status: 503, applied: false });
    await expect(
      createAssignment(gateway, "assignments", assignmentCreate(), "course", "America/Los_Angeles"),
    ).rejects.toThrow("2 pages match");
  });
});

describe("template stabilization and recoverable initialization", () => {
  it("fails clearly when no template blocks ever appear", async () => {
    const gateway = new StatefulFakeGateway();
    await expect(
      waitForTemplate(gateway, "page", {
        attempts: 3,
        delayMs: 0,
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toThrow("did not stabilize");
  });

  it("waits through a growing template until the complete block set stabilizes", async () => {
    const gateway = new StatefulFakeGateway();
    const observations = [
      [templateBlock("one")],
      [templateBlock("one"), templateBlock("two")],
      [templateBlock("one"), templateBlock("two")],
    ];
    let observation = 0;
    gateway.listBlocks = (pageId: string) =>
      pageId === "page"
        ? Promise.resolve(observations[Math.min(observation++, observations.length - 1)]!)
        : Promise.resolve([]);
    await waitForTemplate(gateway, "page", {
      attempts: 3,
      delayMs: 0,
      sleep: () => Promise.resolve(),
    });
    expect(observation).toBe(3);
  });

  it("returns after two equivalent non-empty template observations", async () => {
    const gateway = new StatefulFakeGateway();
    gateway.seedBlock("page", templateBlock("stable"));
    let sleeps = 0;
    await waitForTemplate(gateway, "page", {
      attempts: 3,
      delayMs: 1,
      sleep: () => {
        sleeps += 1;
        return Promise.resolve();
      },
    });
    expect(sleeps).toBe(1);
  });

  it("leaves a page discoverable by Canvas UID when template waiting times out", async () => {
    const gateway = new StatefulFakeGateway();
    const plan: SyncPlan = {
      coursesToCreate: [],
      coursesToUpdate: [],
      assignmentsToCreate: [assignmentCreate()],
      assignmentsToUpdate: [],
      assignmentsToRemove: [],
      assignmentsMissingEvidenceToUpdate: [],
      missingCandidatesObserved: 0,
      unchanged: 0,
      skipped: 0,
      warnings: [],
    };
    const appliedCounts = counts();
    let failure: ApplyPlanError | undefined;
    try {
      await applyPlan(gateway, config(), plan, appliedCounts, {
        templateWait: { attempts: 2, delayMs: 0, sleep: () => Promise.resolve() },
      });
    } catch (error) {
      if (error instanceof ApplyPlanError) failure = error;
      else throw error;
    }
    const matches = await gateway.queryDataSource("assignments", {
      property: "Canvas UID",
      rich_text: { equals: "uid-new" },
    });
    expect(matches).toHaveLength(1);
    expect(appliedCounts.created).toBe(1);
    expect(failure?.execution.failedOperation?.kind).toBe("assignment-template-wait");
    expect(failure?.execution.partialAssignments[0]).toMatchObject({
      state: "requires-repair",
      completedSubsteps: ["assignment-page-create"],
    });
  });

  it("allows a later run to finish an assignment left incomplete by template timeout", async () => {
    const gateway = new StatefulFakeGateway();
    const createPlan: SyncPlan = {
      coursesToCreate: [],
      coursesToUpdate: [],
      assignmentsToCreate: [assignmentCreate()],
      assignmentsToUpdate: [],
      assignmentsToRemove: [],
      assignmentsMissingEvidenceToUpdate: [],
      missingCandidatesObserved: 0,
      unchanged: 0,
      skipped: 0,
      warnings: [],
    };
    await expect(
      applyPlan(gateway, config(), createPlan, counts(), {
        templateWait: { attempts: 2, delayMs: 0, sleep: () => Promise.resolve() },
      }),
    ).rejects.toThrow("assignment-template-wait");
    const pageId = (gateway.pages.get("assignments")?.[0]?.id as string) ?? "";
    gateway.seedBlock(pageId, templateBlock("template"));
    const updatePlan: SyncPlan = {
      coursesToCreate: [],
      coursesToUpdate: [],
      assignmentsToCreate: [],
      assignmentsToUpdate: [
        {
          pageId,
          source: { ...assignmentCreate().source, descriptionMarkdown: "Recovered description" },
          courseKey: "page:course",
          properties: {},
          verifyDescription: true,
          descriptionHash: managedDescriptionHash("Recovered description"),
          missingEvidenceCleared: false,
        },
      ],
      assignmentsToRemove: [],
      assignmentsMissingEvidenceToUpdate: [],
      missingCandidatesObserved: 0,
      unchanged: 0,
      skipped: 0,
      warnings: [],
    };
    const laterCounts = counts();
    const execution = await applyPlan(gateway, config(), updatePlan, laterCounts);
    expect(execution.assignmentsSynchronized).toHaveLength(1);
    expect(laterCounts.updated).toBe(1);
    expect(await readManagedDescription(gateway, pageId)).toBe("Recovered description");
  });
});

describe("managed descriptions", () => {
  function descriptionGateway(): StatefulFakeGateway {
    const gateway = new StatefulFakeGateway();
    gateway.seedBlock("page", {
      id: "user",
      type: "heading_2",
      heading_2: { rich_text: [{ plain_text: "Notes" }] },
    });
    gateway.seedBlock("page", toggle("managed", MANAGED_DESCRIPTION_TITLE));
    gateway.seedBlock("managed", {
      id: "old-child",
      type: "paragraph",
      paragraph: { rich_text: [{ plain_text: "Old description" }] },
    });
    return gateway;
  }

  function descriptionPlan(markdown: string): SyncPlan {
    return {
      coursesToCreate: [],
      coursesToUpdate: [],
      assignmentsToCreate: [],
      assignmentsToUpdate: [
        {
          pageId: "page",
          source: {
            uid: "uid",
            title: "Assignment",
            inferredType: "Other",
            descriptionMarkdown: markdown,
          },
          courseKey: "page:course",
          properties: {},
          verifyDescription: true,
          descriptionHash: managedDescriptionHash(markdown),
          missingEvidenceCleared: false,
        },
      ],
      assignmentsToRemove: [],
      assignmentsMissingEvidenceToUpdate: [],
      missingCandidatesObserved: 0,
      unchanged: 0,
      skipped: 0,
      warnings: [],
    };
  }

  it("reads assignment properties without routine page-body reads", async () => {
    const gateway = new StatefulFakeGateway();
    gateway.seedPage("assignments", "page", {
      Assignment: { title: [{ plain_text: "Assignment" }] },
      "Canvas UID": { rich_text: [{ plain_text: "uid" }] },
      "Canvas Description Hash": {
        rich_text: [{ plain_text: managedDescriptionHash("Old description") }],
      },
      "Canvas Description Verified At": { date: { start: "2026-07-01T00:00:00.000Z" } },
      Course: { relation: [{ id: "course" }] },
      "Canvas State": { select: { name: "Active" } },
      "Removed from Canvas": { checkbox: false },
      "Imported From": { select: { name: "Canvas ICS" } },
    });
    const assignments = await readAssignments(gateway, "assignments");
    expect(assignments[0]?.descriptionHash).toBe(managedDescriptionHash("Old description"));
    const source = {
      uid: "uid",
      title: "Assignment",
      courseName: "EE 10",
      inferredType: "Other" as const,
      descriptionMarkdown: "Old description",
    };
    const plan = buildPlan(
      {
        ...emptyFeed,
        assignments: [source],
        diagnostics: {
          ...emptyFeed.diagnostics,
          totalEvents: 1,
          sourceUids: [source.uid],
          normalizedAssignmentUids: [source.uid],
        },
      },
      assignments,
      [{ pageId: "course", title: "EE 10" }],
      {},
      false,
      new Date("2026-07-13T00:00:00Z"),
      gateway.metrics,
    );
    expect(plan.assignmentsToUpdate).toEqual([]);
    await applyPlan(gateway, config(), plan, counts());
    expect(gateway.metrics.assignmentBodyReads).toBe(0);
  });

  it("migrates a missing hash with one read and no replacement when the body matches", async () => {
    const gateway = descriptionGateway();
    await applyPlan(gateway, config(), descriptionPlan("Old description"), counts());
    expect(gateway.listBlocksCallCount("page")).toBe(1);
    expect(gateway.listBlocksCallCount("managed")).toBe(1);
    expect(gateway.totalListBlocksCalls()).toBe(2);
    expect(gateway.metrics.assignmentBodyReads).toBe(1);
    expect(gateway.metrics.descriptionReplacements).toBe(0);
    expect(gateway.writes.filter((write) => write.kind === "append")).toEqual([]);
    expect(JSON.stringify(gateway.writes)).toContain(managedDescriptionHash("Old description"));
  });

  it("repairs a missing canonical toggle and preserves user-owned template blocks", async () => {
    const gateway = new StatefulFakeGateway();
    gateway.seedBlock("page", {
      id: "user",
      type: "heading_2",
      heading_2: { rich_text: [{ plain_text: "Notes" }] },
    });
    await applyPlan(gateway, config(), descriptionPlan("New description"), counts());
    expect(gateway.listBlocksCallCount("page")).toBe(2);
    expect(gateway.totalListBlocksCalls()).toBe(3);
    const blocks = await gateway.listBlocks("page");
    expect(blocks.some((block) => block.id === "user")).toBe(true);
    expect(blocks.filter((block) => blockText(block) === MANAGED_DESCRIPTION_TITLE)).toHaveLength(
      1,
    );
    expect(gateway.metrics.descriptionIntegrityRepairs).toBe(1);
  });

  it("replaces a mismatched body before committing its hash", async () => {
    const gateway = descriptionGateway();
    await applyPlan(gateway, config(), descriptionPlan("New description"), counts());
    expect(gateway.listBlocksCallCount("page")).toBe(2);
    expect(gateway.listBlocksCallCount("managed")).toBe(1);
    expect(gateway.totalListBlocksCalls()).toBe(4);
    expect(await readManagedDescription(gateway, "page")).toBe("New description");
    expect(gateway.metrics.descriptionReplacements).toBe(1);
    expect(JSON.stringify(gateway.writes)).toContain(managedDescriptionHash("New description"));
  });

  it("does not advance the hash after a failed body write and repairs it on a later run", async () => {
    const gateway = descriptionGateway();
    gateway.appendFailures.push({ id: "page", status: 503, applied: false });
    const plan = descriptionPlan("New description");
    let failed: ApplyPlanError | undefined;
    try {
      await applyPlan(gateway, config(), plan, counts());
    } catch (error) {
      if (error instanceof ApplyPlanError) failed = error;
    }
    expect(failed?.execution.partialAssignments[0]).toMatchObject({
      pageId: "page",
      state: "requires-repair",
      failedSubstep: { kind: "assignment-description-update" },
    });
    expect(
      gateway.writes.some(
        (write) =>
          write.kind === "update" &&
          (JSON.stringify(write.value).includes("Canvas Description Hash") ||
            JSON.stringify(write.value).includes("Canvas Description Verified At")),
      ),
    ).toBe(false);
    await applyPlan(gateway, config(), plan, counts());
    expect(await readManagedDescription(gateway, "page")).toBe("New description");
    expect(JSON.stringify(gateway.writes)).toContain(managedDescriptionHash("New description"));
  });

  it("reduces duplicate canonical toggles to one without replacing a valid body", async () => {
    const gateway = descriptionGateway();
    gateway.seedBlock("page", toggle("duplicate", MANAGED_DESCRIPTION_TITLE));
    gateway.seedBlock("duplicate", {
      id: "duplicate-child",
      type: "paragraph",
      paragraph: { rich_text: [{ plain_text: "Old description" }] },
    });
    await applyPlan(gateway, config(), descriptionPlan("Old description"), counts());
    expect(gateway.listBlocksCallCount("page")).toBe(1);
    expect(gateway.listBlocksCallCount("managed")).toBe(1);
    expect(gateway.totalListBlocksCalls()).toBe(2);
    const blocks = await gateway.listBlocks("page");
    expect(blocks.filter((block) => blockText(block) === MANAGED_DESCRIPTION_TITLE)).toHaveLength(
      1,
    );
    expect(gateway.metrics.descriptionIntegrityRepairs).toBe(1);
    expect(gateway.metrics.descriptionReplacements).toBe(0);
  });

  it("cleans pending replacement toggles before advancing verification metadata", async () => {
    const gateway = descriptionGateway();
    gateway.seedBlock("page", toggle("pending", PENDING_MANAGED_DESCRIPTION_TITLE));
    gateway.seedBlock("page", toggle("pending-duplicate", PENDING_MANAGED_DESCRIPTION_TITLE));
    await applyPlan(gateway, config(), descriptionPlan("Old description"), counts());
    expect(gateway.listBlocksCallCount("page")).toBe(1);
    expect(gateway.listBlocksCallCount("managed")).toBe(1);
    expect(gateway.totalListBlocksCalls()).toBe(2);
    expect(
      (await gateway.listBlocks("page")).filter(
        (block) => blockText(block) === PENDING_MANAGED_DESCRIPTION_TITLE,
      ),
    ).toHaveLength(0);
    expect(gateway.metrics.descriptionIntegrityRepairs).toBe(1);
  });

  it("updates only the verification timestamp when a due audit finds a valid body", async () => {
    const gateway = descriptionGateway();
    const plan = descriptionPlan("Old description");
    plan.assignmentsToUpdate[0]!.descriptionHashNeedsUpdate = false;
    await applyPlan(gateway, config(), plan, counts(), {
      now: new Date("2026-07-13T12:00:00.000Z"),
    });
    const metadataWrite = gateway.writes.find(
      (write) =>
        write.kind === "update" &&
        JSON.stringify(write.value).includes("Canvas Description Verified At"),
    );
    expect(metadataWrite).toBeDefined();
    expect(JSON.stringify(metadataWrite?.value)).not.toContain("Canvas Description Hash");
    expect(JSON.stringify(metadataWrite?.value)).not.toContain("Last Synced");
    expect(gateway.metrics.descriptionIntegrityAuditsRun).toBe(1);
    expect(gateway.metrics.descriptionIntegrityAuditsPassed).toBe(1);
    expect(gateway.metrics.descriptionIntegrityRepairs).toBe(0);
    expect(gateway.metrics.descriptionReplacements).toBe(0);
  });

  it("writes a new page hash and verification timestamp only after body verification", async () => {
    const gateway = new StatefulFakeGateway();
    gateway.seedBlock("assignments-1", {
      id: "template",
      type: "heading_2",
      heading_2: { rich_text: [{ plain_text: "Notes" }] },
    });
    const createPlan: SyncPlan = {
      coursesToCreate: [],
      coursesToUpdate: [],
      assignmentsToCreate: [assignmentCreate()],
      assignmentsToUpdate: [],
      assignmentsToRemove: [],
      assignmentsMissingEvidenceToUpdate: [],
      missingCandidatesObserved: 0,
      unchanged: 0,
      skipped: 0,
      warnings: [],
    };
    await applyPlan(gateway, config(), createPlan, counts(), {
      now: new Date("2026-07-13T12:00:00.000Z"),
      templateWait: { attempts: 2, delayMs: 0, sleep: () => Promise.resolve() },
    });
    const metadataIndex = gateway.writes.findIndex(
      (write) =>
        write.kind === "update" &&
        JSON.stringify(write.value).includes("Canvas Description Verified At"),
    );
    const verificationIndex = gateway.writes.findIndex((write) => write.kind === "update-block");
    expect(metadataIndex).toBeGreaterThan(verificationIndex);
    expect(JSON.stringify(gateway.writes[metadataIndex]?.value)).toContain(
      "Canvas Description Hash",
    );
    expect(JSON.stringify(gateway.writes[metadataIndex]?.value)).toContain(
      "Canvas Description Verified At",
    );
  });

  it("preserves the old managed section when replacement creation fails", async () => {
    const gateway = descriptionGateway();
    gateway.appendFailures.push({ id: "page", status: 503, applied: false });
    await expect(replaceManagedDescription(gateway, "page", "New description")).rejects.toThrow(
      "0 replacements found",
    );
    expect((await gateway.listBlocks("page")).some((block) => block.id === "managed")).toBe(true);
  });

  it("reconciles a statusless marker append without duplicate permanent sections", async () => {
    const gateway = descriptionGateway();
    gateway.appendFailures.push({ id: "page", code: "ECONNRESET", applied: true });
    await replaceManagedDescription(gateway, "page", "New description");
    expect(gateway.listBlocksCallCount("page")).toBe(3);
    expect(gateway.listBlocksCallCount("managed")).toBe(1);
    expect(gateway.totalListBlocksCalls()).toBe(6);
    const blocks = await gateway.listBlocks("page");
    expect(blocks.filter((block) => blockText(block) === MANAGED_DESCRIPTION_TITLE)).toHaveLength(
      1,
    );
    expect(
      blocks.filter((block) => blockText(block) === PENDING_MANAGED_DESCRIPTION_TITLE),
    ).toHaveLength(0);
  });

  it("resumes a statusless child append from its verified prefix", async () => {
    const gateway = descriptionGateway();
    gateway.seedBlock("page", toggle("pending", PENDING_MANAGED_DESCRIPTION_TITLE));
    gateway.appendFailures.push({
      id: "pending",
      code: "UND_ERR_SOCKET",
      applied: true,
      appliedCount: 1,
    });
    await replaceManagedDescription(gateway, "page", "New description");
    expect(gateway.listBlocksCallCount("page")).toBe(2);
    expect(gateway.listBlocksCallCount("managed")).toBe(1);
    expect(gateway.listBlocksCallCount("pending")).toBe(2);
    expect(gateway.totalListBlocksCalls()).toBeLessThanOrEqual(5);
    expect(await readManagedDescription(gateway, "page")).toBe("New description");
    expect(
      (await gateway.listBlocks("page")).filter(
        (block) => blockText(block) === MANAGED_DESCRIPTION_TITLE,
      ),
    ).toHaveLength(1);
  });

  it("successfully replaces exactly one managed toggle and preserves user content", async () => {
    const gateway = descriptionGateway();
    await replaceManagedDescription(gateway, "page", "New description");
    const blocks = await gateway.listBlocks("page");
    expect(blocks.some((block) => block.id === "user")).toBe(true);
    expect(blocks.filter((block) => blockText(block) === MANAGED_DESCRIPTION_TITLE)).toHaveLength(
      1,
    );
    expect(gateway.writes).toContainEqual({ kind: "delete", id: "managed" });
  });
});

describe("ambiguity-safe block deletion", () => {
  it("accepts a statusless delete when observation shows the block is absent", async () => {
    const gateway = new StatefulFakeGateway();
    gateway.seedBlock("page", templateBlock("target"));
    gateway.deleteFailures.push({ id: "target", code: "ECONNRESET", applied: true });
    await deleteBlockReconciled(gateway, "page", "target");
    expect(await gateway.listBlocks("page")).toHaveLength(0);
    expect(gateway.writes.filter((write) => write.kind === "delete")).toHaveLength(1);
  });

  it("performs one justified follow-up after a statusless unapplied delete", async () => {
    const gateway = new StatefulFakeGateway();
    gateway.seedBlock("page", templateBlock("target"));
    gateway.deleteFailures.push({ id: "target", code: "ETIMEDOUT", applied: false });
    await deleteBlockReconciled(gateway, "page", "target");
    expect(await gateway.listBlocks("page")).toHaveLength(0);
    expect(gateway.writes.filter((write) => write.kind === "delete")).toHaveLength(2);
  });

  it("treats a 404 follow-up as completion after an ambiguous delete", async () => {
    class StaleObservationGateway extends StatefulFakeGateway {
      private stale = true;

      public override async listBlocks(pageId: string): Promise<Array<Record<string, unknown>>> {
        const blocks = await super.listBlocks(pageId);
        if (pageId === "page" && this.stale && blocks.length === 0) {
          this.stale = false;
          return [templateBlock("target")];
        }
        return blocks;
      }
    }
    const gateway = new StaleObservationGateway();
    gateway.seedBlock("page", templateBlock("target"));
    gateway.deleteFailures.push(
      { id: "target", status: 503, applied: true },
      { id: "target", status: 404, applied: false },
    );
    await deleteBlockReconciled(gateway, "page", "target");
    expect(gateway.writes.filter((write) => write.kind === "delete")).toHaveLength(2);
  });

  it.each([400, 403])(
    "keeps definite validation and authorization failures fatal (%s)",
    async (status) => {
      const gateway = new StatefulFakeGateway();
      gateway.seedBlock("page", templateBlock("target"));
      gateway.deleteFailures.push({ id: "target", status, applied: false });
      await expect(deleteBlockReconciled(gateway, "page", "target")).rejects.toMatchObject({
        status,
      });
      expect(await gateway.listBlocks("page")).toHaveLength(1);
    },
  );
});

describe("partial execution and Sync Log recovery", () => {
  it("reports which missing-evidence writes persisted before a partial failure", async () => {
    const gateway = new StatefulFakeGateway();
    gateway.updateFailures.push({ id: "assignment-b", status: 400, applied: false });
    const plan: SyncPlan = {
      coursesToCreate: [],
      coursesToUpdate: [],
      assignmentsToCreate: [],
      assignmentsToUpdate: [],
      assignmentsMissingEvidenceToUpdate: ["assignment-a", "assignment-b"].map((pageId) => ({
        pageId,
        canvasMissingSince: "2026-07-13T12:00:00Z",
        canvasMissingCount: 1,
        transition: "observed" as const,
      })),
      assignmentsToRemove: [],
      missingCandidatesObserved: 2,
      unchanged: 0,
      skipped: 0,
      warnings: [],
    };
    const appliedCounts = counts();
    let failure: ApplyPlanError | undefined;
    try {
      await applyPlan(gateway, config(), plan, appliedCounts);
    } catch (error) {
      if (error instanceof ApplyPlanError) failure = error;
      else throw error;
    }
    expect(appliedCounts.missingAdvanced).toBe(1);
    expect(failure?.execution.appliedOperations).toContainEqual({
      kind: "assignment-missing-evidence-update",
      target: "assignment-a",
    });
    expect(failure?.execution.failedOperation).toMatchObject({
      kind: "assignment-missing-evidence-update",
      target: "assignment-b",
    });
  });

  it("records only applied updates and leaves removals not attempted after failure", async () => {
    const gateway = new StatefulFakeGateway();
    gateway.updateFailures.push({ id: "assignment-b", status: 400, applied: false });
    const plan: SyncPlan = {
      coursesToCreate: [],
      coursesToUpdate: [],
      assignmentsToCreate: [],
      assignmentsToUpdate: ["assignment-a", "assignment-b"].map((pageId) => ({
        pageId,
        source: {
          uid: `uid-${pageId}`,
          title: "Changed",
          inferredType: "Other" as const,
        },
        courseKey: "page:course",
        properties: { title: "Changed" },
        verifyDescription: false,
        descriptionHash: managedDescriptionHash(undefined),
        missingEvidenceCleared: false,
      })),
      assignmentsToRemove: [
        {
          pageId: "assignment-remove",
          uid: "removed",
          title: "Removed",
          coursePageIds: [],
          removed: false,
          reason: "persistent-absence",
          markRemoved: true,
          clearMissingEvidence: false,
        },
      ],
      assignmentsMissingEvidenceToUpdate: [],
      missingCandidatesObserved: 0,
      unchanged: 0,
      skipped: 0,
      warnings: [],
    };
    const appliedCounts = counts();
    let failure: ApplyPlanError | undefined;
    try {
      await applyPlan(gateway, config(), plan, appliedCounts);
    } catch (error) {
      if (error instanceof ApplyPlanError) failure = error;
      else throw error;
    }
    expect(
      failure?.execution.appliedOperations
        .filter((item) => item.kind === "assignment-property-update")
        .map((item) => item.target),
    ).toEqual(["assignment-a"]);
    expect(failure?.execution.failedOperation?.target).toBe("assignment-b");
    expect(failure?.execution.notAttempted.map((item) => item.target)).toEqual([
      "assignment-remove",
    ]);
    expect(appliedCounts.updated).toBe(1);
    expect(appliedCounts.removed).toBe(0);

    const result: RunResult = {
      status: "Failed",
      counts: appliedCounts,
      warnings: [],
      errors: [failure?.message ?? "failed"],
      metrics: createRunMetrics(),
      plan,
      ...(failure ? { execution: failure.execution } : {}),
    };
    await writeSyncLog(
      gateway,
      config(),
      "2026-07-13T00:00:00.000Z",
      "2026-07-13T00:01:00.000Z",
      result,
    );
    const logPage = (gateway.pages.get("log") ?? [])[0]!;
    const logBlocks = await managedChildren(gateway, logPage.id as string);
    const successfulHeading = logBlocks.findIndex(
      (block) => blockText(block) === "Applied operations",
    );
    const failedHeading = logBlocks.findIndex(
      (block) => blockText(block) === "Failed or ambiguous operation",
    );
    const successfulText = logBlocks
      .slice(successfulHeading, failedHeading)
      .map(blockText)
      .join(" ");
    expect(successfulText).toContain("assignment-a");
    expect(successfulText).not.toContain("assignment-b");
  });

  it("records durable page creation and template completion when description setup fails", async () => {
    const gateway = new StatefulFakeGateway();
    gateway.seedBlock("assignments-1", templateBlock("template"));
    gateway.appendFailures.push({ id: "assignments-1", status: 503, applied: false });
    const plan: SyncPlan = {
      coursesToCreate: [],
      coursesToUpdate: [],
      assignmentsToCreate: [
        {
          ...assignmentCreate(),
          source: { ...assignmentCreate().source, descriptionMarkdown: "Description" },
        },
      ],
      assignmentsToUpdate: [],
      assignmentsToRemove: [],
      assignmentsMissingEvidenceToUpdate: [],
      missingCandidatesObserved: 0,
      unchanged: 0,
      skipped: 0,
      warnings: [],
    };
    const appliedCounts = counts();
    let failure: ApplyPlanError | undefined;
    try {
      await applyPlan(gateway, config(), plan, appliedCounts, {
        templateWait: { attempts: 2, delayMs: 0, sleep: () => Promise.resolve() },
      });
    } catch (error) {
      if (error instanceof ApplyPlanError) failure = error;
      else throw error;
    }
    expect(appliedCounts.created).toBe(1);
    expect(failure?.execution.partialAssignments[0]).toMatchObject({
      completedSubsteps: ["assignment-page-create", "assignment-template-wait"],
      failedSubstep: { kind: "assignment-description-update" },
    });
    expect(failure?.execution.assignmentsSynchronized).toHaveLength(0);

    const logResult: RunResult = {
      status: "Failed",
      counts: appliedCounts,
      warnings: [],
      errors: [failure?.message ?? "failed"],
      metrics: createRunMetrics(),
      plan,
      ...(failure ? { execution: failure.execution } : {}),
    };
    await writeSyncLog(
      gateway,
      config({ GITHUB_RUN_ID: "partial-create" }),
      "start",
      "finish",
      logResult,
    );
    const logPageId = gateway.pages.get("log")?.[0]?.id as string;
    const partialText = (await managedChildren(gateway, logPageId)).map(blockText).join(" ");
    expect(partialText).toContain("Partial operations");
    expect(partialText).toContain("assignment-template-wait");
    expect(partialText).toContain("requires repair at assignment-description-update");
  });

  it("does not count an update as complete when properties succeed but description repair fails", async () => {
    const gateway = new StatefulFakeGateway();
    gateway.appendFailures.push({ id: "assignment", status: 503, applied: false });
    const plan: SyncPlan = {
      coursesToCreate: [],
      coursesToUpdate: [],
      assignmentsToCreate: [],
      assignmentsToUpdate: [
        {
          pageId: "assignment",
          source: {
            uid: "uid",
            title: "Changed",
            descriptionMarkdown: "Changed description",
            inferredType: "Other",
          },
          courseKey: "page:course",
          properties: { title: "Changed" },
          verifyDescription: true,
          descriptionHash: managedDescriptionHash("new"),
          missingEvidenceCleared: false,
        },
      ],
      assignmentsToRemove: [],
      assignmentsMissingEvidenceToUpdate: [],
      missingCandidatesObserved: 0,
      unchanged: 0,
      skipped: 0,
      warnings: [],
    };
    const appliedCounts = counts();
    let failure: ApplyPlanError | undefined;
    try {
      await applyPlan(gateway, config(), plan, appliedCounts);
    } catch (error) {
      if (error instanceof ApplyPlanError) failure = error;
      else throw error;
    }
    expect(appliedCounts.updated).toBe(0);
    expect(failure?.execution.partialAssignments[0]).toMatchObject({
      intent: "update",
      completedSubsteps: ["assignment-property-update"],
      failedSubstep: { kind: "assignment-description-update" },
    });
    expect(failure?.execution.assignmentsSynchronized).toHaveLength(0);
  });

  it("repairs a Sync Log whose managed body contains only its first half", async () => {
    const gateway = new StatefulFakeGateway();
    const runConfig = config({ GITHUB_RUN_ID: "repair-half" });
    await writeSyncLog(gateway, runConfig, "start", "finish", result(["first error"]));
    const pageId = gateway.pages.get("log")?.[0]?.id as string;
    const marker = (await gateway.listBlocks(pageId)).find(
      (block) => blockText(block) === MANAGED_SYNC_LOG_TITLE,
    )!;
    const markerId = marker.id as string;
    const complete = await gateway.listBlocks(markerId);
    gateway.blocks.set(markerId, complete.slice(0, Math.floor(complete.length / 2)));

    const readsBeforeRepair = gateway.totalListBlocksCalls();
    await writeSyncLog(gateway, runConfig, "start", "finish-2", result(["first error"]));
    expect(gateway.totalListBlocksCalls() - readsBeforeRepair).toBe(4);
    const repaired = await managedChildren(gateway, pageId);
    expect(repaired.map(blockText).filter((value) => value === "Errors")).toHaveLength(1);
    expect(
      (await gateway.listBlocks(pageId)).filter(
        (block) => blockText(block) === MANAGED_SYNC_LOG_TITLE,
      ),
    ).toHaveLength(1);
  });

  it("updates stale Sync Log properties and managed result details on rerun", async () => {
    const gateway = new StatefulFakeGateway();
    const runConfig = config({ GITHUB_RUN_ID: "stale-details" });
    await writeSyncLog(gateway, runConfig, "start", "finish-1", result(["old error"]));
    await writeSyncLog(gateway, runConfig, "start", "finish-2", result(["new error"]));
    const page = gateway.pages.get("log")![0]!;
    const body = (await managedChildren(gateway, page.id as string)).map(blockText).join(" ");
    expect(body).toContain("new error");
    expect(body).not.toContain("old error");
    expect(
      gateway.writes.filter((write) => write.kind === "update" && write.id === page.id),
    ).toHaveLength(1);
  });

  it("reconciles a partial ambiguous Sync Log body append without duplicate sections", async () => {
    const gateway = new StatefulFakeGateway();
    seedLogPage(gateway, "log-page", "partial-append");
    gateway.seedBlock("log-page", toggle("pending-log", PENDING_MANAGED_SYNC_LOG_TITLE));
    gateway.appendFailures.push({
      id: "pending-log",
      status: 503,
      applied: true,
      appliedCount: 3,
    });
    await writeSyncLog(
      gateway,
      config({ GITHUB_RUN_ID: "partial-append" }),
      "start",
      "finish",
      result(["error"]),
    );
    const root = await gateway.listBlocks("log-page");
    expect(root.filter((block) => blockText(block) === MANAGED_SYNC_LOG_TITLE)).toHaveLength(1);
    expect(
      root.filter((block) => blockText(block) === PENDING_MANAGED_SYNC_LOG_TITLE),
    ).toHaveLength(0);
  });

  it("preserves user-created blocks outside the managed Sync Log section", async () => {
    const gateway = new StatefulFakeGateway();
    seedLogPage(gateway, "log-page", "user-content");
    gateway.seedBlock("log-page", templateBlock("user-note", "User note"));
    await writeSyncLog(
      gateway,
      config({ GITHUB_RUN_ID: "user-content" }),
      "start",
      "finish",
      result(),
    );
    expect((await gateway.listBlocks("log-page")).some((block) => block.id === "user-note")).toBe(
      true,
    );
  });

  it("recovers statusless Sync Log creation and never creates a duplicate", async () => {
    const gateway = new StatefulFakeGateway();
    gateway.createFailures.push({ id: "log", code: "ECONNRESET", applied: true });
    const result: RunResult = {
      status: "Failed",
      counts: counts(),
      warnings: [],
      errors: ["assignment-update assignment-a: Notion request failed with status 503"],
      metrics: createRunMetrics(),
    };
    const runConfig = config({ GITHUB_RUN_ID: "12345" });
    await writeSyncLog(gateway, runConfig, "start", "finish", result);
    await writeSyncLog(gateway, runConfig, "start", "finish-2", result);
    expect(
      gateway.writes.filter((write) => write.kind === "create" && write.id === "log"),
    ).toHaveLength(1);
    expect(gateway.pages.get("log")).toHaveLength(1);
  });

  it("recovers a Sync Log page that becomes visible on a later observation poll", async () => {
    const gateway = new StatefulFakeGateway();
    gateway.createFailures.push({ id: "log", status: 503, applied: true });
    gateway.queryVisibilityMisses.set("log", 2);
    await writeSyncLog(
      gateway,
      config({ GITHUB_RUN_ID: "visible-later" }),
      "start",
      "finish",
      result(),
      { attempts: 2, delayMs: 0, sleep: () => Promise.resolve() },
    );
    expect(gateway.pages.get("log")).toHaveLength(1);
    expect(
      gateway.writes.filter((write) => write.kind === "create" && write.id === "log"),
    ).toHaveLength(1);
  });

  it("does not retry an ambiguous Sync Log create when no page is visible", async () => {
    const gateway = new StatefulFakeGateway();
    gateway.createFailures.push({ id: "log", status: 503, applied: false });
    const result = await run(config(), {
      gateway,
      provider: new FakeProvider(emptyFeed),
    });
    expect(result.status).toBe("Failed");
    expect(
      gateway.writes.filter((write) => write.kind === "create" && write.id === "log"),
    ).toHaveLength(1);
  });
});
