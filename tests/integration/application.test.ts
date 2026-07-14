import { describe, expect, it } from "vitest";
import { run } from "../../src/cli.js";
import { createAssignment } from "../../src/notion/assignments.js";
import { withRetry } from "../../src/notion/client.js";
import { createCourse } from "../../src/notion/courses.js";
import {
  MANAGED_DESCRIPTION_TITLE,
  PENDING_MANAGED_DESCRIPTION_TITLE,
  replaceManagedDescription,
} from "../../src/notion/descriptions.js";
import { writeSyncLog } from "../../src/notion/sync-log.js";
import { safeError } from "../../src/observability/redaction.js";
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
    assignmentsParsed: 0,
    sourceUids: [],
    normalizedAssignmentUids: [],
    quarantinedUids: [],
    events: [],
    ignoredEventCount: 0,
    complete: true,
  },
};

function counts(): RunCounts {
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

function assignmentCreate(uid = "uid-new"): AssignmentCreate {
  return {
    courseKey: "page:course",
    source: {
      uid,
      title: "Homework",
      inferredType: "Homework",
      rawClassificationEvidence: [],
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
          rawClassificationEvidence: ["canvas-assignment-route"],
        },
      ],
      cancelledAssignments: [],
      diagnostics: {
        ...emptyFeed.diagnostics,
        totalEvents: 1,
        assignmentsParsed: 1,
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

  it("24 validate mode performs no data writes", async () => {
    const gateway = new FakeGateway();
    const result = await run(config({ mode: "validate" }), {
      gateway,
      provider: new FakeProvider(emptyFeed),
    });
    expect(result.status).toBe("Success");
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
        ignoredEventCount: 1,
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

  it("38 retries Notion rate limits with bounded backoff", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
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
      },
    );
    expect(value).toBe("ok");
    expect(attempts).toBe(3);
    expect(sleeps).toHaveLength(2);
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

  it("39 skips removal writes after an active assignment write fails", async () => {
    const gateway = new FakeGateway();
    gateway.failOnAssignmentWrite = true;
    const plan: SyncPlan = {
      coursesToCreate: [],
      assignmentsToCreate: [],
      assignmentsToUpdate: [
        {
          pageId: "assignment-active",
          source: {
            uid: "uid",
            title: "Changed",
            inferredType: "Other",
            rawClassificationEvidence: [],
          },
          courseKey: "page:course",
          properties: { title: "Changed" },
          updateDescription: false,
          reactivate: false,
        },
      ],
      assignmentsToRemove: [
        {
          pageId: "assignment-remove",
          uid: "removed",
          title: "Removed",
          coursePageIds: [],
          removed: false,
        },
      ],
      unchanged: 0,
      skipped: 0,
      warnings: [],
    };
    const counts: RunCounts = {
      feedItems: 1,
      assignmentsParsed: 1,
      created: 0,
      updated: 0,
      removed: 0,
      unchanged: 0,
      skipped: 0,
      warningCount: 0,
    };
    await expect(applyPlan(gateway, config(), plan, counts)).rejects.toThrow("write failed");
    expect(gateway.writes.some((write) => write.id === "assignment-remove")).toBe(false);
    expect(counts.removed).toBe(0);
  });

  it("applies a cancelled removal without writing Notion-owned fields", async () => {
    const gateway = new FakeGateway();
    const plan: SyncPlan = {
      coursesToCreate: [],
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
          removed: false,
          canvasState: "Active",
        },
      ],
      unchanged: 0,
      skipped: 0,
      warnings: [],
    };
    const counts: RunCounts = {
      feedItems: 1,
      assignmentsParsed: 0,
      created: 0,
      updated: 0,
      removed: 0,
      unchanged: 0,
      skipped: 0,
      warningCount: 0,
    };
    await applyPlan(gateway, config(), plan, counts);
    const properties = gateway.writes[0]?.value as Record<string, unknown>;
    expect(properties).toHaveProperty("Removed from Canvas");
    expect(properties).toHaveProperty("Canvas State");
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
});

describe("ambiguous create recovery", () => {
  it("recovers an applied assignment create after a 503 without creating again", async () => {
    const gateway = new StatefulFakeGateway();
    gateway.createFailures.push({ id: "assignments", status: 503, applied: true });
    const result = await createAssignment(
      gateway,
      "assignments",
      assignmentCreate(),
      "course",
      "America/Los_Angeles",
    );
    expect(result.recovered).toBe(true);
    expect(gateway.writes.filter((write) => write.kind === "create")).toHaveLength(1);
  });

  it("leaves an unobserved assignment create ambiguous with one bounded attempt", async () => {
    const gateway = new StatefulFakeGateway();
    gateway.createFailures.push({ id: "assignments", status: 503, applied: false });
    await expect(
      createAssignment(gateway, "assignments", assignmentCreate(), "course", "America/Los_Angeles"),
    ).rejects.toThrow("creation was not retried");
    expect(gateway.writes.filter((write) => write.kind === "create")).toHaveLength(1);
  });

  it("recovers an applied course create by Canvas Course ID", async () => {
    const gateway = new StatefulFakeGateway();
    gateway.createFailures.push({ id: "courses", status: 503, applied: true });
    const result = await createCourse(gateway, "courses", {
      key: "id:123",
      title: "EE 10",
      courseCode: "EE 10",
      canvasCourseId: "123",
    });
    expect(result.recovered).toBe(true);
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

  it("preserves the old managed section when replacement creation fails", async () => {
    const gateway = descriptionGateway();
    gateway.appendFailures.push({ id: "page", status: 503, applied: false });
    await expect(replaceManagedDescription(gateway, "page", "New description")).rejects.toThrow(
      "0 replacements found",
    );
    expect((await gateway.listBlocks("page")).some((block) => block.id === "managed")).toBe(true);
  });

  it("reconciles an ambiguous toggle append without duplicate permanent sections", async () => {
    const gateway = descriptionGateway();
    gateway.appendFailures.push({ id: "page", status: 503, applied: true });
    await replaceManagedDescription(gateway, "page", "New description");
    const blocks = await gateway.listBlocks("page");
    expect(blocks.filter((block) => blockText(block) === MANAGED_DESCRIPTION_TITLE)).toHaveLength(
      1,
    );
    expect(
      blocks.filter((block) => blockText(block) === PENDING_MANAGED_DESCRIPTION_TITLE),
    ).toHaveLength(0);
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

describe("partial execution and Sync Log recovery", () => {
  it("records only applied updates and leaves removals not attempted after failure", async () => {
    const gateway = new StatefulFakeGateway();
    gateway.updateFailures.push({ id: "assignment-b", status: 400, applied: false });
    const plan: SyncPlan = {
      coursesToCreate: [],
      assignmentsToCreate: [],
      assignmentsToUpdate: ["assignment-a", "assignment-b"].map((pageId) => ({
        pageId,
        source: {
          uid: `uid-${pageId}`,
          title: "Changed",
          inferredType: "Other" as const,
          rawClassificationEvidence: [],
        },
        courseKey: "page:course",
        properties: { title: "Changed" },
        updateDescription: false,
        reactivate: false,
      })),
      assignmentsToRemove: [
        {
          pageId: "assignment-remove",
          uid: "removed",
          title: "Removed",
          coursePageIds: [],
          removed: false,
        },
      ],
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
    expect(failure?.execution.assignmentsUpdated.map((item) => item.target)).toEqual([
      "assignment-a",
    ]);
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
    const logBlocks = await gateway.listBlocks(logPage.id as string);
    const successfulHeading = logBlocks.findIndex(
      (block) => blockText(block) === "Successfully applied changes",
    );
    const failedHeading = logBlocks.findIndex(
      (block) => blockText(block) === "Failed or ambiguous change",
    );
    const successfulText = logBlocks
      .slice(successfulHeading, failedHeading)
      .map(blockText)
      .join(" ");
    expect(successfulText).toContain("assignment-a");
    expect(successfulText).not.toContain("assignment-b");
  });

  it("recovers ambiguous Sync Log creation and never creates a duplicate", async () => {
    const gateway = new StatefulFakeGateway();
    gateway.createFailures.push({ id: "log", status: 503, applied: true });
    const result: RunResult = {
      status: "Failed",
      counts: counts(),
      warnings: [],
      errors: ["assignment-update assignment-a: Notion request failed with status 503"],
    };
    const runConfig = config({ GITHUB_RUN_ID: "12345" });
    await writeSyncLog(gateway, runConfig, "start", "finish", result);
    await writeSyncLog(gateway, runConfig, "start", "finish-2", result);
    expect(
      gateway.writes.filter((write) => write.kind === "create" && write.id === "log"),
    ).toHaveLength(1);
    expect(gateway.pages.get("log")).toHaveLength(1);
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
