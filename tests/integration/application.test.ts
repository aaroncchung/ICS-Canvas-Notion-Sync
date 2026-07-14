import { describe, expect, it } from "vitest";
import { run } from "../../src/cli.js";
import { createAssignment } from "../../src/notion/assignments.js";
import { withRetry } from "../../src/notion/client.js";
import { createCourse } from "../../src/notion/courses.js";
import {
  MANAGED_DESCRIPTION_TITLE,
  PENDING_MANAGED_DESCRIPTION_TITLE,
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
      assignmentsToCreate: [assignmentCreate()],
      assignmentsToUpdate: [],
      assignmentsToRemove: [],
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
      assignmentsToCreate: [assignmentCreate()],
      assignmentsToUpdate: [],
      assignmentsToRemove: [],
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
      assignmentsToCreate: [],
      assignmentsToUpdate: [
        {
          pageId,
          source: { ...assignmentCreate().source, descriptionMarkdown: "Recovered description" },
          courseKey: "page:course",
          properties: {},
          updateDescription: true,
          reactivate: false,
        },
      ],
      assignmentsToRemove: [],
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

describe("ambiguity-safe block deletion", () => {
  it("accepts an ambiguous delete when observation shows the block is absent", async () => {
    const gateway = new StatefulFakeGateway();
    gateway.seedBlock("page", templateBlock("target"));
    gateway.deleteFailures.push({ id: "target", status: 503, applied: true });
    await deleteBlockReconciled(gateway, "page", "target");
    expect(await gateway.listBlocks("page")).toHaveLength(0);
    expect(gateway.writes.filter((write) => write.kind === "delete")).toHaveLength(1);
  });

  it("performs one justified follow-up delete when the block remains", async () => {
    const gateway = new StatefulFakeGateway();
    gateway.seedBlock("page", templateBlock("target"));
    gateway.deleteFailures.push({ id: "target", status: 503, applied: false });
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
      assignmentsToCreate: [
        {
          ...assignmentCreate(),
          source: { ...assignmentCreate().source, descriptionMarkdown: "Description" },
        },
      ],
      assignmentsToUpdate: [],
      assignmentsToRemove: [],
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
      assignmentsToCreate: [],
      assignmentsToUpdate: [
        {
          pageId: "assignment",
          source: {
            uid: "uid",
            title: "Changed",
            descriptionMarkdown: "Changed description",
            inferredType: "Other",
            rawClassificationEvidence: [],
          },
          courseKey: "page:course",
          properties: { title: "Changed" },
          updateDescription: true,
          reactivate: false,
        },
      ],
      assignmentsToRemove: [],
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

    await writeSyncLog(gateway, runConfig, "start", "finish-2", result(["first error"]));
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
