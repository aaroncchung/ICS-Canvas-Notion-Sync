import { afterEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { blockBatch, paragraph, paragraphs, toggle, type Block } from "../../src/notion/blocks.ts";
import { OfficialNotionGateway } from "../../src/notion/client.ts";
import {
  MANAGED_DESCRIPTION_TITLE,
  PENDING_MANAGED_DESCRIPTION_TITLE,
  managedDescriptionHash,
  replaceManagedDescription,
  waitForTemplate,
} from "../../src/notion/descriptions.ts";
import {
  blockText,
  createManagedSectionSnapshot,
  reconcileManagedSection,
} from "../../src/notion/managed-section.ts";
import { MANAGED_SYNC_LOG_TITLE, writeSyncLog } from "../../src/notion/sync-log.ts";
import { operationSections } from "../../src/observability/report-content.ts";
import { runMetrics, workCounts } from "../../src/observability/run-report.ts";
import {
  ApplyPlanError,
  applyPlan,
  emptyExecutionResult,
  plannedOperations,
} from "../../src/sync/reconcile.ts";
import type { SyncPlan } from "../../src/types.ts";
import { config, FakeGateway, readManagedDescription, runResult } from "../helpers.ts";
import { setTimeout as sleep } from "node:timers/promises";

vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn(async () => {}) }));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const titles = { managed: MANAGED_DESCRIPTION_TITLE, pending: PENDING_MANAGED_DESCRIPTION_TITLE };
const source = {
  uid: "uid",
  title: "Assignment",
  inferredType: "Other" as const,
  descriptionMarkdown: "Description",
};
const now = () => new Date("2026-09-14T12:00:00Z");
function plan(): SyncPlan {
  return {
    coursesToCreate: [],
    coursesToUpdate: [],
    assignmentsToCreate: [],
    assignmentsToUpdate: [
      {
        pageId: "page",
        source,
        courseKey: "page:course",
        properties: { canvasDueDate: "2026-10-01" },
        verifyDescription: true,
        descriptionHash: managedDescriptionHash(source.descriptionMarkdown),
        descriptionHashNeedsUpdate: false,
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
function seedDescription(gateway: FakeGateway, text = "Description"): void {
  gateway.seedPage("assignments", "page", {});
  gateway.seedBlock("page", {
    ...toggle(MANAGED_DESCRIPTION_TITLE, [paragraph(text)]),
    id: "managed",
  });
}

/** Exercise the real SDK, pagination, payloads, and physical counters without live writes. */
function transport(backing = new FakeGateway()) {
  vi.useFakeTimers();
  const fetch = vi.fn(async (input: string, init: RequestInit) => {
    const url = new URL(input);
    const serialized = typeof init.body === "string" ? init.body : "";
    const body = serialized ? (JSON.parse(serialized) as Record<string, unknown>) : {};
    expect(Buffer.byteLength(serialized)).toBeLessThan(500_000);
    const checkChildren = (children: Block[]) => {
      expect(children.length).toBeLessThanOrEqual(100);
      for (const block of children) {
        const nested = (block[block.type as string] as Block)?.children;
        if (Array.isArray(nested)) checkChildren(nested as Block[]);
      }
    };
    if (Array.isArray(body.children)) checkChildren(body.children as Block[]);
    const [, , resource, id, action] = url.pathname.split("/");
    let result: unknown;
    if (resource === "blocks" && action === "children" && init.method === "GET") {
      const blocks = await backing.listBlocks(id!);
      const offset = Number(url.searchParams.get("start_cursor") ?? 0);
      const next = offset + 100 < blocks.length ? String(offset + 100) : null;
      result = {
        results: blocks.slice(offset, offset + 100),
        next_cursor: next,
        has_more: next !== null,
      };
    } else if (resource === "blocks" && action === "children") {
      const ids = await backing.appendBlocks(id!, body.children as Block[]);
      result = { results: ids.map((id) => ({ id })) };
    } else if (resource === "blocks" && init.method === "PATCH") {
      await backing.updateBlock(id!, body);
      result = { id };
    } else if (resource === "blocks" && init.method === "DELETE") {
      await backing.deleteBlock(id!);
      result = { id };
    } else if (resource === "pages" && init.method === "POST") {
      const parent = body.parent as { data_source_id: string };
      result = {
        id: await backing.createPage(parent.data_source_id, body.properties as Block, {
          ...(body.children ? { children: body.children as Block[] } : {}),
        }),
      };
    } else if (resource === "pages" && init.method === "PATCH") {
      await backing.updatePage(id!, body.properties as Block);
      result = { id };
    } else if (resource === "data_sources" && action === "query") {
      result = {
        results: await backing.queryDataSource(id!, body.filter as Block),
        next_cursor: null,
      };
    } else throw new Error(`Unexpected request ${init.method} ${url.pathname}`);
    return new Response(JSON.stringify(result), {
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetch);
  return { gateway: new OfficialNotionGateway("test", pino({ level: "silent" })), backing, fetch };
}

async function drain<T>(work: Promise<T>): Promise<T> {
  const settled = work.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.runAllTimersAsync();
  const result = await settled;
  if ("error" in result) throw result.error;
  return result.value;
}

describe("Notion write request budgets", () => {
  it.each([100, 1000, 2000])(
    "uses linear physical reads and writes for %i managed blocks",
    async (count) => {
      const { gateway, fetch } = transport();
      const blocks = Array.from({ length: count }, (_, index) => paragraph(`Block ${index}`));
      await drain(
        (async () => {
          const snapshot = await createManagedSectionSnapshot(gateway, "page", titles, blocks);
          await reconcileManagedSection(gateway, snapshot);
        })(),
      );
      expect(gateway.requestMetrics.requestsByOperation).toEqual({
        read: count / 100 + 2,
        "block-append": count / 100,
        "property-update": 1,
      });
      expect(fetch).toHaveBeenCalledTimes((2 * count) / 100 + 3);
    },
  );

  it("creates an assignment in eight requests including unchanged template stabilization", async () => {
    const { gateway, backing, fetch } = transport();
    backing.simulateDefaultTemplate = true;
    const createPlan = plan();
    createPlan.assignmentsToCreate = [{ source, courseKey: "page:course" }];
    createPlan.assignmentsToUpdate = [];
    const execution = await drain(applyPlan(gateway, config(), createPlan, { now }));
    expect(execution.assignmentsSynchronized).toHaveLength(1);
    expect(gateway.requestMetrics.requestsByOperation).toEqual({
      "page-create": 1,
      read: 4,
      "block-append": 1,
      "property-update": 2,
    });
    expect(fetch).toHaveBeenCalledTimes(8);
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(backing.listBlocksCallCount("assignments-1")).toBe(3); // two polls + promotion
    const create = JSON.parse(
      fetch.mock.calls.find(([, init]) => init.method === "POST")![1].body as string,
    ) as Block;
    expect(create).toHaveProperty("template");
    expect(create).not.toHaveProperty("children");
    expect(create.properties).not.toHaveProperty("Canvas Description Hash");
  });

  it.each([false, true])(
    "verifies the body before a single property commit (repair=%s)",
    async (repair) => {
      const { gateway, backing, fetch } = transport();
      seedDescription(backing, repair ? "Old" : "Description");
      const execution = await drain(applyPlan(gateway, config(), plan(), { now }));
      expect(fetch).toHaveBeenCalledTimes(repair ? 8 : 3);
      expect(gateway.requestMetrics.requestsByOperation).toEqual(
        repair
          ? { read: 4, "block-append": 1, "property-update": 2, delete: 1 }
          : { read: 2, "property-update": 1 },
      );
      expect(execution.appliedOperations.map(({ kind }) => kind)).toEqual([
        "assignment-description-update",
        "assignment-property-update",
        "assignment-description-hash-update",
      ]);
      const commits = backing.writes.filter((value) => value.kind === "update");
      expect(commits).toHaveLength(1);
      const properties = commits[0]!.value as Block;
      expect(properties).toHaveProperty("Canvas Due Date");
      expect(properties).toHaveProperty("Canvas Description Verified At");
      if (repair) expect(properties).toHaveProperty("Canvas Description Hash");
      else expect(properties).not.toHaveProperty("Canvas Description Hash");
      expect(runMetrics(plan(), execution).descriptionIntegrityAuditsPassed).toBe(repair ? 0 : 1);
    },
  );

  it("creates a large-run Sync Log in two requests, retaining full failure and partial details", async () => {
    const { gateway, backing, fetch } = transport();
    const large = plan();
    large.assignmentsToUpdate = [];
    large.assignmentsToCreate = Array.from({ length: 5000 }, (_, index) => ({
      source: { ...source, uid: `uid-${index}` },
      courseKey: "page:course",
    }));
    const operations = plannedOperations(large);
    const execution = emptyExecutionResult();
    execution.appliedOperations = operations.slice(0, 10000);
    execution.failedOperation = {
      ...operations[10000]!,
      outcome: "ambiguous",
      message: "Lost connection",
    };
    execution.notAttempted = operations.slice(10001);
    execution.partialAssignments = [
      {
        intent: "create",
        target: "important-uid",
        pageId: "important-page",
        state: "requires-repair",
        completedSubsteps: ["assignment-page-create"],
        failedSubstep: execution.failedOperation,
      },
    ];
    const result = runResult({
      plan: large,
      execution,
      status: "Failed",
      errors: ["Failure detail ".repeat(300)],
    });
    await drain(writeSyncLog(gateway, config(), "start", "finish", result));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(gateway.requestMetrics.requestsByOperation).toEqual({ read: 1, "sync-log-create": 1 });
    const text = [...backing.blocks.values()].flat().map(blockText).join("");
    expect(text).toContain("20000 operations total");
    expect(text).toContain("10000 operations total");
    expect(text).toContain("important-uid -> important-page");
    expect(text).toContain("[ambiguous]: Lost connection");
    expect(text).toContain(result.errors[0]);
    expect([...backing.blocks.values()].flat().length).toBeLessThan(50);
  });

  it("reuses an unchanged workflow log with four requests and no body writes", async () => {
    const { gateway, backing, fetch } = transport();
    const runConfig = config({ GITHUB_RUN_ID: "rerun" });
    await drain(writeSyncLog(gateway, runConfig, "start", "finish", runResult()));
    const before = fetch.mock.calls.length;
    await drain(writeSyncLog(gateway, runConfig, "start", "finish-2", runResult()));
    expect(fetch.mock.calls.length - before).toBe(4);
    expect(backing.writes.map((value) => value.kind)).toEqual(["create", "update"]);
    expect(backing.pages.get("log")).toHaveLength(1);
  });

  it("keeps oversized failure details intact using the paginated fallback", async () => {
    const { gateway, backing, fetch } = transport();
    const detail = "Failure detail ".repeat(20000);
    await drain(
      writeSyncLog(gateway, config(), "start", "finish", runResult({ errors: [detail] })),
    );
    expect(fetch.mock.calls.length).toBeLessThan(12);
    expect([...backing.blocks.values()].flat().map(blockText).join("")).toContain(detail);
    expect(backing.pages.get("log")).toHaveLength(1);
  });
});

describe("batched write safety", () => {
  it("reports relation-resolution failure before description work or property requests", async () => {
    const gateway = new FakeGateway();
    const work = plan();
    work.assignmentsToUpdate[0]!.properties.coursePageId = "unresolved";
    let failure: ApplyPlanError | undefined;
    try {
      await applyPlan(gateway, config(), work);
    } catch (error) {
      if (!(error instanceof ApplyPlanError)) throw error;
      failure = error;
    }
    expect(failure?.execution.failedOperation?.kind).toBe("assignment-property-update");
    expect(failure?.execution.notAttempted.map((value) => value.kind)).toEqual([
      "assignment-description-update",
      "assignment-description-hash-update",
    ]);
    expect(failure?.execution.partialAssignments).toEqual([]);
    expect(gateway.totalListBlocksCalls()).toBe(0);
    expect(gateway.writes).toEqual([]);
  });
  it("still waits for nested template growth and returns the last observed roots", async () => {
    const gateway = new FakeGateway();
    gateway.seedBlock("page", { ...toggle("Template", [paragraph("First")]), id: "template" });
    const list = gateway.listBlocks.bind(gateway);
    let polls = 0;
    vi.spyOn(gateway, "listBlocks").mockImplementation(async (id) => {
      if (id === "template" && ++polls === 2) gateway.seedBlock(id, paragraph("Second"));
      return list(id);
    });
    const pause = vi.fn(async () => {});
    const roots = await waitForTemplate(gateway, "page", { sleep: pause });
    expect(polls).toBe(3);
    expect(pause.mock.calls).toHaveLength(2);
    const reads = gateway.listBlocksCallCount("page");
    await replaceManagedDescription(gateway, "page", "Description", undefined, roots);
    expect(gateway.listBlocksCallCount("page") - reads).toBe(1); // promotion only
    expect(gateway.blocks.get("template")!.map(blockText)).toEqual(["First", "Second"]);
  });

  it("never splits a surrogate pair across paragraph chunks", () => {
    const text = `${"a".repeat(1899)}😀${"b".repeat(1899)}😀`;
    const chunks = paragraphs(text).map(blockText);
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(1900);
      expect(chunk).not.toMatch(/\p{Surrogate}/u);
    }
    expect(paragraphs("")).toEqual([]);
    expect(paragraphs("x".repeat(3800)).map(blockText)).toEqual([
      "x".repeat(1900),
      "x".repeat(1900),
    ]);
  });

  it("keeps Unicode batches within byte and block limits", () => {
    const blocks = Array.from({ length: 200 }, () => paragraph("漢".repeat(1900)));
    let offset = 0;
    while (offset < blocks.length) {
      const batch = blockBatch(blocks, offset);
      expect(batch.length).toBeLessThan(100);
      expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThan(400_000);
      offset += batch.length;
    }
    expect(offset).toBe(200);
  });

  it.each(["partial", "invisible", "corrupt"])(
    "observes an ambiguous later chunk before resuming (%s)",
    async (mode) => {
      const gateway = new FakeGateway();
      seedDescription(gateway, "Old");
      const blocks = Array.from({ length: 250 }, (_, index) => paragraph(`Block ${index}`));
      const append = gateway.appendBlocks.bind(gateway);
      let injected = false;
      vi.spyOn(gateway, "appendBlocks").mockImplementation(async (id, children) => {
        if (id !== "page" && !injected) {
          injected = true;
          if (mode !== "invisible")
            await append(id, mode === "corrupt" ? [paragraph("Wrong")] : children.slice(0, 25));
          throw Object.assign(new Error("Lost response"), { code: "ECONNRESET" });
        }
        return append(id, children);
      });
      const snapshot = await createManagedSectionSnapshot(gateway, "page", titles, blocks);
      if (mode === "partial") {
        await reconcileManagedSection(gateway, snapshot);
        expect(gateway.writes.filter((write) => write.kind === "append")).toHaveLength(4);
        const marker = gateway.blocks
          .get("page")!
          .find((block) => blockText(block) === MANAGED_DESCRIPTION_TITLE)!;
        expect(gateway.blocks.get(marker.id as string)!.map(blockText)).toEqual(
          blocks.map(blockText),
        );
      } else {
        await expect(reconcileManagedSection(gateway, snapshot)).rejects.toThrow(
          /no visible progress|ambiguous/,
        );
        expect(await readManagedDescription(gateway, "page")).toBe("Old");
        expect(gateway.writes.some((write) => write.kind === "delete")).toBe(false);
      }
    },
  );

  it("does not blindly append children after an ambiguous marker with invisible children", async () => {
    const gateway = new FakeGateway();
    seedDescription(gateway, "Old");
    const append = gateway.appendBlocks.bind(gateway);
    vi.spyOn(gateway, "appendBlocks").mockImplementationOnce(async (id) => {
      await append(id, [toggle(PENDING_MANAGED_DESCRIPTION_TITLE)]);
      throw Object.assign(new Error("Lost response"), { code: "ECONNRESET" });
    });
    await expect(replaceManagedDescription(gateway, "page", "New")).rejects.toThrow(
      "no verified child progress",
    );
    expect(gateway.writes.filter((write) => write.kind === "append")).toHaveLength(1);
    expect(await readManagedDescription(gateway, "page")).toBe("Old");
  });

  it("recovers missing append IDs through observation without duplicating the marker", async () => {
    const gateway = new FakeGateway();
    const append = gateway.appendBlocks.bind(gateway);
    vi.spyOn(gateway, "appendBlocks").mockImplementationOnce(async (id, children) => {
      await append(id, children);
      return [];
    });
    await replaceManagedDescription(gateway, "page", "Description");
    expect(gateway.writes.filter((value) => value.kind === "append")).toHaveLength(1);
    expect(await readManagedDescription(gateway, "page")).toBe("Description");
  });

  it("verifies acknowledged chunks before deleting old content or committing metadata", async () => {
    const gateway = new FakeGateway();
    seedDescription(gateway, "Old");
    const append = gateway.appendBlocks.bind(gateway);
    vi.spyOn(gateway, "appendBlocks").mockImplementation(async (id, children) => {
      const ids = await append(id, children);
      if (id === "page") gateway.seedBlock(ids[0]!, paragraph("Unexpected"));
      return ids;
    });
    await expect(applyPlan(gateway, config(), plan())).rejects.toThrow("could not be verified");
    expect(await readManagedDescription(gateway, "page")).toBe("Old");
    const writes = gateway.writes.filter((write) => write.kind === "update");
    expect(writes).toHaveLength(1);
    expect(writes[0]!.value).toHaveProperty("Canvas Due Date");
    expect(writes[0]!.value).not.toHaveProperty("Canvas Description Hash");
    expect(writes[0]!.value).not.toHaveProperty("Canvas Description Verified At");
  });

  it.each([false, true])(
    "preserves independent writes and ambiguity after a combined commit failure (applied=%s)",
    async (applied) => {
      const gateway = new FakeGateway();
      seedDescription(gateway);
      gateway.failUpdate({ id: "page", code: "ECONNRESET", applied });
      let failure: ApplyPlanError | undefined;
      try {
        await applyPlan(gateway, config(), plan(), { now });
      } catch (error) {
        if (!(error instanceof ApplyPlanError)) throw error;
        failure = error;
      }
      expect(failure?.execution.failedOperation).toMatchObject({
        kind: "assignment-description-hash-update",
        outcome: "ambiguous",
      });
      expect(failure?.execution.appliedOperations.map((value) => value.kind)).toEqual([
        "assignment-description-update",
        "assignment-property-update",
      ]);
      expect(failure?.execution.notAttempted).toEqual([]);
      expect(failure?.execution.partialAssignments).toHaveLength(1);
      expect(workCounts(plan(), failure!.execution).updated).toBe(0);
      const writes = gateway.writes.filter((write) => write.kind === "update");
      expect(writes).toHaveLength(2);
      expect(writes[1]!.value).not.toHaveProperty("Canvas Description Verified At");
      const execution = await applyPlan(gateway, config(), plan(), { now });
      expect(execution.assignmentsSynchronized).toHaveLength(1);
      expect(runMetrics(plan(), execution).descriptionIntegrityAuditsPassed).toBe(1);
    },
  );

  it.each(["description", "metadata"])(
    "records both failures when the %s and independent properties fail",
    async (phase) => {
      const gateway = new FakeGateway();
      seedDescription(gateway);
      if (phase === "description")
        vi.spyOn(gateway, "listBlocks").mockRejectedValue(new Error("Body unavailable"));
      gateway.failUpdate(
        { id: "page", status: 400, applied: false },
        { id: "page", status: 403, applied: false },
      );
      const work = plan();
      work.assignmentsToUpdate.push({
        ...work.assignmentsToUpdate[0]!,
        pageId: "later",
        verifyDescription: false,
      });
      let failure: ApplyPlanError | undefined;
      try {
        await applyPlan(gateway, config(), work);
      } catch (error) {
        if (!(error instanceof ApplyPlanError)) throw error;
        failure = error;
      }
      const execution = failure!.execution;
      expect(execution.additionalFailures).toMatchObject([{ kind: "assignment-property-update" }]);
      expect(execution.notAttempted.map((value) => value.target)).toContain("later");
      expect(execution.notAttempted).not.toContainEqual({
        kind: "assignment-property-update",
        target: "page",
      });
      expect(runMetrics(work, execution).descriptionIntegrityAuditsRun).toBe(1);
      expect(workCounts(work, execution).updated).toBe(0);
      const failures = operationSections(runResult({ execution })).find(
        (value) => value.title === "Failed or ambiguous operation",
      )!;
      expect(failures.lines).toHaveLength(2);
    },
  );

  it("recovers a partially visible initial Sync Log body and preserves user content on rerun", async () => {
    const gateway = new FakeGateway();
    const create = gateway.createPage.bind(gateway);
    vi.spyOn(gateway, "createPage").mockImplementationOnce(async (id, properties, options) => {
      const pageId = await create(id, properties, options);
      const marker = gateway.blocks.get(pageId)![0]!;
      gateway.blocks.set(marker.id as string, gateway.blocks.get(marker.id as string)!.slice(0, 3));
      gateway.seedBlock(pageId, { ...paragraph("User notes"), id: "user" });
      throw Object.assign(new Error("Lost create response"), { code: "ECONNRESET" });
    });
    const runConfig = config({ GITHUB_RUN_ID: "same-run" });
    await writeSyncLog(gateway, runConfig, "start", "finish", runResult());
    await writeSyncLog(
      gateway,
      runConfig,
      "start",
      "finish",
      runResult({ errors: ["Latest error"] }),
    );
    expect(gateway.pages.get("log")).toHaveLength(1);
    expect(gateway.writes.filter((value) => value.kind === "create")).toHaveLength(1);
    const pageId = gateway.pages.get("log")![0]!.id as string;
    const root = gateway.blocks.get(pageId)!;
    expect(root.filter((value) => blockText(value) === MANAGED_SYNC_LOG_TITLE)).toHaveLength(1);
    expect(root.some((value) => value.id === "user")).toBe(true);
    expect([...gateway.blocks.values()].flat().map(blockText).join("\n")).toContain("Latest error");
  });
});
