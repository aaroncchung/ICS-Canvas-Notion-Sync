import { describe, expect, it } from "vitest";
import { run } from "../../src/cli.js";
import { withRetry, type NotionGateway } from "../../src/notion/client.js";
import {
  MANAGED_DESCRIPTION_TITLE,
  replaceManagedDescription,
} from "../../src/notion/descriptions.js";
import { safeError } from "../../src/observability/redaction.js";
import { applyPlan } from "../../src/sync/reconcile.js";
import type { AssignmentFeed, RunCounts, SyncPlan } from "../../src/types.js";
import { config, FakeGateway, FakeProvider } from "../helpers.js";

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

describe("managed descriptions", () => {
  it("replaces only the managed toggle and preserves user template blocks", async () => {
    const writes: Array<{ kind: string; id: string }> = [];
    const gateway: NotionGateway = {
      retrieveDataSource: () => Promise.resolve({}),
      queryDataSource: () => Promise.resolve([]),
      createPage: () => Promise.resolve("page"),
      updatePage: () => Promise.resolve(),
      listBlocks: () =>
        Promise.resolve([
          { id: "user", type: "heading_2", heading_2: { rich_text: [{ plain_text: "Notes" }] } },
          {
            id: "managed",
            type: "toggle",
            toggle: { rich_text: [{ plain_text: MANAGED_DESCRIPTION_TITLE }] },
          },
        ]),
      appendBlocks: (id, children) => {
        writes.push({ kind: "append", id });
        return Promise.resolve(children.map((_, index) => `new-${index}`));
      },
      deleteBlock: (id) => {
        writes.push({ kind: "delete", id });
        return Promise.resolve();
      },
    };
    await replaceManagedDescription(gateway, "page", "New description");
    expect(writes).toContainEqual({ kind: "delete", id: "managed" });
    expect(writes).not.toContainEqual({ kind: "delete", id: "user" });
    expect(writes.filter((write) => write.kind === "append")).toHaveLength(2);
  });
});
