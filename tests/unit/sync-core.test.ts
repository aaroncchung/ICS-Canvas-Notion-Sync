import { describe, expect, it } from "vitest";
import { readAssignments } from "../../src/notion/assignments.js";
import { createRunMetrics } from "../../src/notion/client.js";
import { managedDescriptionHash } from "../../src/notion/descriptions.js";
import { buildPlan } from "../../src/sync/plan.js";
import { ApplyPlanError, applyPlan, plannedOperations } from "../../src/sync/reconcile.js";
import type { AssignmentRecord, CourseRecord, ExternalAssignment } from "../../src/types.js";
import { assignmentFeed, config, FakeGateway, runCounts } from "../helpers.js";

const now = new Date("2026-07-13T12:00:00Z");
const timezone = "America/Los_Angeles";
const biology: CourseRecord = { pageId: "biology", title: "Biology 101", courseCode: "BIO101" };
function source(uid: string, fields: Partial<ExternalAssignment> = {}): ExternalAssignment {
  return { uid, title: uid, courseName: "Bio", inferredType: "Other", ...fields };
}
function record(uid: string, fields: Partial<AssignmentRecord> = {}): AssignmentRecord {
  return {
    uid,
    pageId: uid,
    title: uid,
    coursePageIds: [],
    removed: false,
    canvasState: "Active",
    descriptionHash: managedDescriptionHash(undefined),
    descriptionVerifiedAt: now.toISOString(),
    ...fields,
  };
}
function plan(
  sources: ExternalAssignment[],
  records: AssignmentRecord[] = [],
  courses: CourseRecord[] = [],
) {
  const metrics = createRunMetrics();
  const feed = assignmentFeed({
    assignments: sources,
    diagnostics: {
      totalEvents: sources.length,
      sourceUids: sources.map((value) => value.uid),
      normalizedAssignmentUids: sources.map((value) => value.uid),
      quarantinedUids: [],
      events: [],
      complete: true,
    },
  });
  return { result: buildPlan(feed, records, courses, {}, false, timezone, now, metrics), metrics };
}

describe("finalized reconciliation decisions", () => {
  it("links every existing assignment to the same newly planned course and converges after apply", async () => {
    const sources = [source("one"), source("two")];
    const records = [record("one"), record("two")];
    const { result } = plan(sources, records);
    expect(result.coursesToCreate).toHaveLength(1);
    expect(result.assignmentsToUpdate.map((value) => value.properties.coursePageId)).toEqual([
      "name:bio",
      "name:bio",
    ]);
    const gateway = new FakeGateway();
    for (const value of records)
      gateway.seedPage("assignments", value.pageId, {
        Assignment: { title: [{ plain_text: value.title }] },
        "Canvas UID": { rich_text: [{ plain_text: value.uid }] },
        "Canvas Description Hash": { rich_text: [{ plain_text: value.descriptionHash }] },
        "Canvas Description Verified At": { date: { start: value.descriptionVerifiedAt } },
        "Canvas State": { select: { name: "Active" } },
      });
    await applyPlan(gateway, config(), result, runCounts(), { now: () => now });
    const updated = await readAssignments(gateway, "assignments");
    expect(updated.map((value) => value.coursePageIds)).toEqual([["courses-1"], ["courses-1"]]);
    const next = plan(sources, updated, [{ pageId: "courses-1", title: "Bio" }]).result;
    expect(next.assignmentsToUpdate).toEqual([]);
    expect(next.coursesToCreate).toEqual([]);
    expect(next.unchanged).toBe(2);
  });

  it.each([false, true])(
    "settles late course evidence before deciding assignments (reverse=%s)",
    (reverse) => {
      const sources = [source("one"), source("two", { courseCode: "BIO101" })];
      const { result } = plan(reverse ? sources.reverse() : sources, [record("one")], [biology]);
      expect(result.coursesToCreate).toEqual([]);
      expect(result.assignmentsToUpdate[0]?.properties.coursePageId).toBe("page:biology");
      expect(result.assignmentsToCreate[0]?.courseKey).toBe("page:biology");
    },
  );

  it.each([false, true])(
    "preserves redirected metadata and blocks incompatible destinations (conflict=%s)",
    (conflict) => {
      const { result } = plan(
        [source("one", { canvasCourseId: "7" }), source("two", { courseCode: "BIO101" })],
        [record("one")],
        [{ ...biology, ...(conflict ? { canvasCourseId: "9" } : {}) }],
      );
      expect(result.coursesToCreate).toEqual([]);
      if (conflict) {
        expect(result.assignmentsToUpdate).toEqual([]);
        expect(result.assignmentsToCreate).toEqual([]);
        expect(result.coursesToUpdate).toEqual([]);
        expect(result.warnings.some((value) => value.code === "course-metadata-conflict")).toBe(
          true,
        );
      } else expect(result.coursesToUpdate[0]?.canvasCourseId).toBe("7");
    },
  );

  it("rejects a Canvas ID that contradicts one planned earlier in the run", () => {
    // "one" plans a provisional course by name; "two" and "three" both reach the existing
    // course through that provisional name, and disagree about its Canvas ID.
    const { result } = plan(
      [
        source("one"),
        source("two", { canvasCourseId: "9", courseCode: "BIO101" }),
        source("three", { canvasCourseId: "7", courseCode: "BIO101" }),
      ],
      [],
      [biology],
    );
    expect(result.coursesToUpdate).toEqual([]);
    expect(result.assignmentsToCreate).toEqual([]);
    expect(
      result.warnings.filter((value) => value.code === "course-metadata-conflict"),
    ).toHaveLength(1);
  });

  it("does not count conflict-blocked unchanged assignments or avoided reads", () => {
    const { result, metrics } = plan(
      [source("one", { canvasCourseId: "7" }), source("two", { canvasCourseId: "9" })],
      [record("one", { coursePageIds: ["bio"] })],
      [{ pageId: "bio", title: "Bio" }],
    );
    expect(result.unchanged).toBe(0);
    expect(result.skipped).toBe(2);
    expect(result.assignmentsToUpdate).toEqual([]);
    expect(metrics.descriptionBodyReadsAvoided).toBe(0);
  });

  it("protects absent duplicate Notion UIDs from removal evidence", () => {
    const { result } = plan(
      [source("present")],
      [
        record("missing", {
          canvasDueDate: "2026-07-14",
          canvasMissingSince: "2026-07-12",
          canvasMissingCount: 2,
        }),
        record("missing", { pageId: "duplicate", canvasDueDate: "2026-07-14" }),
      ],
    );
    expect(result.assignmentsToRemove).toEqual([]);
    expect(result.assignmentsMissingEvidenceToUpdate).toEqual([]);
  });

  it("rechecks duplicate protection after resolving a course from later evidence", () => {
    const { result } = plan(
      [source("new-uid", { title: "Same assignment" }), source("bridge", { courseCode: "BIO101" })],
      [record("old-uid", { title: "Same assignment", coursePageIds: ["biology"] })],
      [biology],
    );
    expect(result.assignmentsToCreate.map((value) => value.source.uid)).toEqual(["bridge"]);
    expect(result.warnings.some((value) => value.code === "possible-assignment-duplicate")).toBe(
      true,
    );
  });

  it.each([0, 1, 2])(
    "resolves a shared Canvas course ID wherever the bridging source appears (bridge=%s)",
    (position) => {
      const sources = [
        source("one", { canvasCourseId: "7" }),
        source("two", { canvasCourseId: "7" }),
      ];
      sources.splice(position, 0, source("bridge", { canvasCourseId: "7", courseCode: "BIO101" }));
      const { result } = plan(sources, [], [biology]);
      expect(result.coursesToCreate).toEqual([]);
      expect(result.assignmentsToCreate.map((value) => value.courseKey)).toEqual([
        "page:biology",
        "page:biology",
        "page:biology",
      ]);
      expect(result.coursesToUpdate[0]?.canvasCourseId).toBe("7");
      expect(result.warnings).toEqual([]);
    },
  );

  it("omits provisional identities from ambiguity warnings", () => {
    const other: CourseRecord = { pageId: "other", title: "Other", courseCode: "OTH" };
    const { result } = plan(
      [
        source("one", { canvasCourseId: "7" }),
        source("two", { canvasCourseId: "7", courseCode: "BIO101" }),
        source("three", { courseCode: "OTH" }),
        source("four", { canvasCourseId: "7" }),
      ],
      [],
      [biology, other],
    );
    const ambiguities = result.warnings.filter((value) => value.code === "ambiguous-course");
    expect(ambiguities.length).toBeGreaterThan(0);
    for (const warning of ambiguities) {
      expect(warning.details?.length).toBeGreaterThan(0);
      expect(warning.details?.some((id) => id.startsWith("planned-course:"))).toBe(false);
    }
  });

  it("keeps competing source labels ambiguous", () => {
    const { result } = plan(
      [
        source("one", { courseCode: "BIO101" }),
        source("two", { courseCode: "BIO102" }),
        source("unknown"),
      ],
      [],
      [biology, { pageId: "biology2", title: "Biology 102", courseCode: "BIO102" }],
    );
    expect(result.coursesToCreate).toEqual([]);
    expect(result.assignmentsToCreate.map((value) => value.source.uid)).toEqual(["one", "two"]);
    expect(result.warnings.some((value) => value.code === "ambiguous-course")).toBe(true);
  });

  it.each([false, true])(
    "propagates an ambiguous destination to provisional course members (reverse=%s)",
    (reverse) => {
      const sources = [source("unknown"), source("ambiguous", { courseCode: "BIO101" })];
      const { result } = plan(
        reverse ? sources.reverse() : sources,
        [],
        [biology, { ...biology, pageId: "duplicate" }],
      );
      expect(result.coursesToCreate).toEqual([]);
      expect(result.assignmentsToCreate).toEqual([]);
      expect(result.skipped).toBe(2);
    },
  );

  it("does not mutate snapshots or a plan during apply", async () => {
    const sources = [Object.freeze(source("one", { courseCode: "BIO101" }))];
    const courses = [Object.freeze({ ...biology })];
    Object.freeze(sources);
    Object.freeze(courses);
    const { result } = plan(sources, [], courses);
    const before = structuredClone(result);
    const gateway = new FakeGateway();
    gateway.simulateDefaultTemplate = true;
    await applyPlan(gateway, config(), result, runCounts(), {
      now: () => now,
      templateWait: { attempts: 2, sleep: async () => {} },
    });
    expect(result).toEqual(before);
  });
});

describe("execution ledger", () => {
  it("accounts for a relation-resolution failure and withholds all remaining work", async () => {
    const { result } = plan([source("one"), source("two")]);
    result.assignmentsToCreate[0]!.courseKey = "unresolvable";
    const gateway = new FakeGateway();
    let failure: ApplyPlanError | undefined;
    try {
      await applyPlan(gateway, config(), result, runCounts());
    } catch (error) {
      if (!(error instanceof ApplyPlanError)) throw error;
      failure = error;
    }
    expect(failure?.execution.failedOperation?.kind).toBe("assignment-page-create");
    expect(failure?.execution.notAttempted).toEqual(plannedOperations(result).slice(2));
    expect(gateway.assignments).toEqual([]);
  });
});
