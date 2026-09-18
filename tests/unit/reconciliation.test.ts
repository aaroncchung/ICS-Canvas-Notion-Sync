import { runMetrics } from "../../src/observability/run-report.ts";
import { describe, expect, it, vi } from "vitest";
import { parseIcs } from "../../src/canvas/parse-ics.ts";
import { DEFAULT_MISSING_EVIDENCE_MINIMUM_HOURS } from "../../src/config.ts";
import { normalizeCourse } from "../../src/course-normalization.ts";
import { createAssignment } from "../../src/notion/assignments.ts";
import {
  descriptionIntegrityAuditDecision,
  managedDescriptionHash,
} from "../../src/notion/descriptions.ts";
import { datesEqual } from "../../src/sync/date-resolution.ts";
import { buildPlan, feedDiagnosticSummary, feedWarnings } from "../../src/sync/plan.ts";
import { applyPlan } from "../../src/sync/reconcile.ts";
import type {
  AssignmentFeed,
  AssignmentRecord,
  CourseRecord,
  ExternalAssignment,
  Trigger,
} from "../../src/types.ts";
import { assignmentTypeMatcher, config, FakeGateway } from "../helpers.ts";

// Spied, never stubbed: the planning work per source is observable without production counters.
vi.mock(import("../../src/course-normalization.ts"), { spy: true });

const course: CourseRecord = {
  pageId: "course-page",
  title: "EE 10",
  courseCode: "EE 10",
  canvasCourseId: "123",
};
const notionTimezone = "America/Los_Angeles";
const DAY_MS = 24 * 60 * 60 * 1000;

function calendar(events: string): string {
  return `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Test//EN\n${events}\nEND:VCALENDAR`;
}

function event(values: string): string {
  return `BEGIN:VEVENT\n${values}\nEND:VEVENT`;
}

function source(overrides: Partial<ExternalAssignment> = {}): ExternalAssignment {
  return {
    uid: "uid-1",
    title: "Homework 1",
    courseName: "EE 10",
    courseCode: "EE 10",
    canvasCourseId: "123",
    canvasAssignmentId: "456",
    canvasUrl: "https://canvas.example.edu/courses/123/assignments/456",
    dueAt: "2026-07-20T20:00:00.000Z",
    descriptionPlainText: "Original description",
    descriptionMarkdown: "Original description",
    inferredType: "Homework",
    ...overrides,
  };
}

function sourceWithoutDueDate(): ExternalAssignment {
  const value = source();
  delete value.dueAt;
  return value;
}

function record(overrides: Partial<AssignmentRecord> = {}): AssignmentRecord {
  return {
    pageId: "assignment-page",
    uid: "uid-1",
    title: "Homework 1",
    coursePageIds: ["course-page"],
    canvasUrl: "https://canvas.example.edu/courses/123/assignments/456",
    canvasDueDate: "2026-07-20T20:00:00.000Z",
    effectiveDueDate: "2026-07-20T20:00:00.000Z",
    descriptionExcerpt: "Original description",
    descriptionHash: managedDescriptionHash("Original description"),
    descriptionVerifiedAt: "2026-07-01T00:00:00.000Z",
    removed: false,
    canvasState: "Active",
    ...overrides,
  };
}

function feed(
  assignments: ExternalAssignment[],
  totalEvents = assignments.length,
  options: {
    cancelledAssignments?: ExternalAssignment[];
    diagnostics?: Partial<AssignmentFeed["diagnostics"]>;
  } = {},
): AssignmentFeed {
  const cancelledAssignments = options.cancelledAssignments ?? [];
  const sourceUids = [...assignments, ...cancelledAssignments].map((assignment) => assignment.uid);
  return {
    assignments,
    cancelledAssignments,
    diagnostics: {
      totalEvents,
      sourceUids,
      normalizedAssignmentUids: [...assignments, ...cancelledAssignments].map(
        (assignment) => assignment.uid,
      ),
      quarantinedUids: [],
      events: [],
      ...options.diagnostics,
    },
  };
}

function plan(
  assignments: ExternalAssignment[],
  existing: AssignmentRecord[] = [record()],
  courses: CourseRecord[] = [course],
  aliases: Record<string, string> = {},
) {
  return planFeed(feed(assignments), existing, courses, aliases);
}

function planFeed(
  value: AssignmentFeed,
  existing: AssignmentRecord[] = [record()],
  courses: CourseRecord[] = [course],
  aliases: Record<string, string> = {},
  trigger: Trigger = "scheduled",
  now = new Date("2026-07-13T12:00:00Z"),
) {
  return buildPlan(value, existing, courses, { aliases, notionTimezone, now, trigger });
}

function planWithMetrics(existing: AssignmentRecord, now = new Date("2026-07-13T12:00:00Z")) {
  const result = buildPlan(feed([source()]), [existing], [course], { notionTimezone, now });
  return { metrics: runMetrics(result), result };
}

function auditDateForReason(reason: "deferred" | "scheduled-slot", verifiedAt: string): Date {
  for (let age = 30; age < 60; age += 1) {
    const now = new Date(Date.parse(verifiedAt) + age * DAY_MS);
    if (
      descriptionIntegrityAuditDecision("uid-1", verifiedAt, notionTimezone, now).reason === reason
    ) {
      return now;
    }
  }
  throw new Error(`No ${reason} audit date found`);
}

function courseConflictPlan(
  ordering: "auditable-first" | "conflicting-first",
  existing: AssignmentRecord,
  now = new Date("2026-07-13T12:00:00Z"),
) {
  const auditable = source({ uid: existing.uid });
  const conflicting = source({
    uid: "conflicting",
    title: "Conflicting metadata source",
    canvasCourseId: "999",
    canvasAssignmentId: "999",
    canvasUrl: "https://canvas.example.edu/courses/999/assignments/999",
    dueAt: "2026-08-30T20:00:00.000Z",
  });
  const assignments =
    ordering === "auditable-first" ? [auditable, conflicting] : [conflicting, auditable];
  const result = buildPlan(
    feed(assignments),
    [existing],
    [{ pageId: "course-page", title: "EE 10", courseCode: "EE 10" }],
    { notionTimezone, now },
  );
  return { metrics: runMetrics(result), result };
}

describe("plan-first reconciliation", () => {
  it("a repeated run is unchanged and creates no duplicate", () => {
    const result = plan([source()]);
    expect(result.assignmentsToCreate).toHaveLength(0);
    expect(result.assignmentsToUpdate).toHaveLength(0);
    expect(result.unchanged).toBe(1);
  });

  it("matching description hashes avoid validation work and increment the avoidance metric", () => {
    const { result } = planWithMetrics(record());
    expect(result.assignmentsToUpdate).toEqual([]);
    expect(runMetrics(result).descriptionUpdatesAvoided).toBe(1);
    expect(runMetrics(result).descriptionBodyReadsAvoided).toBe(1);
    expect(runMetrics(result).descriptionIntegrityAuditsDue).toBe(0);
    expect(runMetrics(result).descriptionIntegrityAuditsDeferred).toBe(0);
  });

  it.each([undefined, "not-a-timestamp", "2026-07-13T18:00:00.000Z"])(
    "schedules an immediate integrity audit for verification timestamp %s",
    (descriptionVerifiedAt) => {
      const existing = record();
      if (descriptionVerifiedAt === undefined) delete existing.descriptionVerifiedAt;
      else existing.descriptionVerifiedAt = descriptionVerifiedAt;
      const { result } = planWithMetrics(existing);
      expect(result.assignmentsToUpdate[0]).toMatchObject({
        verifyDescription: true,
        descriptionHashNeedsUpdate: false,
      });
      expect(runMetrics(result).descriptionIntegrityAuditsDue).toBe(1);
      expect(runMetrics(result).descriptionIntegrityAuditsDeferred).toBe(0);
    },
  );

  it("counts an eligible matching hash outside its slot as deferred exactly once", () => {
    const verifiedAt = "2026-05-20T12:00:00.000Z";
    const { result } = planWithMetrics(
      record({ descriptionVerifiedAt: verifiedAt }),
      auditDateForReason("deferred", verifiedAt),
    );
    expect(result.assignmentsToUpdate).toEqual([]);
    expect(runMetrics(result).descriptionIntegrityAuditsDue).toBe(0);
    expect(runMetrics(result).descriptionIntegrityAuditsDeferred).toBe(1);
    expect(runMetrics(result).descriptionUpdatesAvoided).toBe(1);
    expect(runMetrics(result).descriptionBodyReadsAvoided).toBe(1);
  });

  it("counts an eligible matching hash on its slot as due", () => {
    const verifiedAt = "2026-05-20T12:00:00.000Z";
    const { result } = planWithMetrics(
      record({ descriptionVerifiedAt: verifiedAt }),
      auditDateForReason("scheduled-slot", verifiedAt),
    );
    expect(result.assignmentsToUpdate[0]?.verifyDescription).toBe(true);
    expect(runMetrics(result).descriptionIntegrityAuditsDue).toBe(1);
    expect(runMetrics(result).descriptionIntegrityAuditsDeferred).toBe(0);
  });

  it("counts a matching hash at maximum age as due", () => {
    const result = buildPlan(
      feed([source()]),
      [record({ descriptionVerifiedAt: "2026-05-14T12:00:00.000Z" })],
      [course],
      { notionTimezone, now: new Date("2026-07-13T12:00:00Z") },
    );
    expect(result.assignmentsToUpdate[0]).toMatchObject({
      verifyDescription: true,
      descriptionHashNeedsUpdate: false,
    });
    expect(runMetrics(result).descriptionIntegrityAuditsDue).toBe(1);
    expect(runMetrics(result).descriptionIntegrityAuditsDeferred).toBe(0);
  });

  it("plans changed title, due date, and description", () => {
    const result = plan([
      source({
        title: "Homework 1 revised",
        dueAt: "2026-07-21T20:00:00.000Z",
        descriptionPlainText: "Changed description",
        descriptionMarkdown: "Changed description",
      }),
    ]);
    expect(result.assignmentsToUpdate[0]).toMatchObject({
      verifyDescription: true,
      properties: {
        title: "Homework 1 revised",
        canvasDueDate: "2026-07-21T20:00:00.000Z",
        effectiveDueDate: "2026-07-21T20:00:00.000Z",
        rawDescription: "Changed description",
      },
    });
  });

  it("flags a same-looking assignment with a changed UID", () => {
    const result = plan([source({ uid: "new-uid" })]);
    expect(result.assignmentsToCreate).toHaveLength(0);
    expect(result.assignmentsToRemove).toHaveLength(0);
    expect(
      result.warnings.some((warning) => warning.code === "possible-assignment-duplicate"),
    ).toBe(true);
  });

  it("creates a new course and assignment", () => {
    const result = buildPlan(feed([source()]), [], [], {
      notionTimezone,
      now: new Date("2026-07-13T12:00:00Z"),
    });
    expect(result.coursesToCreate).toHaveLength(1);
    expect(result.assignmentsToCreate).toHaveLength(1);
    expect(runMetrics(result).descriptionIntegrityAuditsDue).toBe(1);
    expect(runMetrics(result).descriptionIntegrityAuditsDeferred).toBe(0);
  });

  it.each(["rich-first", "name-first"] as const)(
    "reuses one planned course creation with %s source ordering",
    (ordering) => {
      const rich = source({ uid: "rich", title: "Rich assignment" });
      const nameOnly = source({ uid: "name-only", title: "Name-only assignment" });
      delete nameOnly.canvasCourseId;
      delete nameOnly.courseCode;
      const assignments = ordering === "rich-first" ? [rich, nameOnly] : [nameOnly, rich];

      const result = plan(assignments, [], []);

      expect(result.coursesToCreate).toHaveLength(1);
      expect(result.assignmentsToCreate).toHaveLength(2);
      expect(new Set(result.assignmentsToCreate.map((item) => item.courseKey)).size).toBe(1);
    },
  );

  it.each(["rich-first", "id-first"] as const)(
    "reuses planned Canvas ID enrichment with %s source ordering",
    (ordering) => {
      const rich = source({ uid: "rich", title: "Rich assignment" });
      const idOnly = source({ uid: "id-only", title: "ID-only assignment" });
      delete idOnly.courseName;
      delete idOnly.courseCode;
      const assignments = ordering === "rich-first" ? [rich, idOnly] : [idOnly, rich];

      const result = plan(assignments, [], [{ pageId: "existing-course", title: "EE 10" }]);

      expect(result.coursesToCreate).toEqual([]);
      expect(result.coursesToUpdate).toEqual([
        expect.objectContaining({ pageId: "existing-course", canvasCourseId: "123" }),
      ]);
      expect(result.assignmentsToCreate.map((item) => item.courseKey)).toEqual([
        "page:existing-course",
        "page:existing-course",
      ]);
    },
  );

  it("uses a configured course alias", () => {
    const aliasCourse: CourseRecord = {
      pageId: course.pageId,
      title: "Engineering 1",
      ...(course.canvasCourseId ? { canvasCourseId: course.canvasCourseId } : {}),
      ...(course.url ? { url: course.url } : {}),
    };
    const aliasSource = source({ courseName: "EN 1" });
    delete aliasSource.courseCode;
    delete aliasSource.canvasCourseId;
    const result = plan([aliasSource], [], [aliasCourse], { "EN 1": "Engineering 1" });
    expect(result.coursesToCreate).toHaveLength(0);
    expect(result.assignmentsToCreate[0]?.courseKey).toBe("page:course-page");
  });

  it("skips an ambiguous course match", () => {
    const ambiguousSource = source();
    delete ambiguousSource.canvasCourseId;
    const result = plan([ambiguousSource], [], [course, { ...course, pageId: "course-page-2" }]);
    expect(result.assignmentsToCreate).toHaveLength(0);
    expect(result.warnings.some((warning) => warning.code === "ambiguous-course")).toBe(true);
  });

  it("stops at ambiguous exact and normalized course identifiers in source order", () => {
    const exactCodeSource = source({ courseCode: "SHARED" });
    delete exactCodeSource.canvasCourseId;
    delete exactCodeSource.courseName;
    const exact = plan(
      [exactCodeSource],
      [],
      [
        { pageId: "exact-two", title: "Second", courseCode: "SHARED" },
        { pageId: "exact-one", title: "First", courseCode: "SHARED" },
      ],
    );
    expect(exact.warnings[0]?.message).toContain("exact-code");
    expect(exact.warnings[0]?.details).toEqual(["exact-two", "exact-one"]);

    const normalizedSource = source({ courseName: "data_science" });
    delete normalizedSource.canvasCourseId;
    delete normalizedSource.courseCode;
    const normalized = plan(
      [normalizedSource],
      [],
      [
        { pageId: "normalized-two", title: "Data-Science" },
        { pageId: "normalized-one", title: "Data Science" },
      ],
    );
    expect(normalized.warnings[0]?.message).toContain("normalized-name-or-code");
    expect(normalized.warnings[0]?.details).toEqual(["normalized-two", "normalized-one"]);
  });

  it("skips an alias that resolves to multiple courses", () => {
    const aliasSource = source({ courseName: "EN 1" });
    delete aliasSource.courseCode;
    delete aliasSource.canvasCourseId;
    const matches: CourseRecord[] = [
      { pageId: "one", title: "Engineering 1" },
      { pageId: "two", title: "Engineering 1" },
    ];
    const result = plan([aliasSource], [], matches, { "EN 1": "Engineering 1" });
    expect(result.assignmentsToCreate).toEqual([]);
    expect(result.warnings[0]?.message).toContain("configured-alias");
  });

  it("treats conflicting applicable aliases as ambiguous regardless of property order", () => {
    const aliased = source({ courseName: "Name Alias", courseCode: "Code Alias" });
    delete aliased.canvasCourseId;
    const courses: CourseRecord[] = [
      { pageId: "course-one", title: "Target One" },
      { pageId: "course-two", title: "Target Two" },
    ];
    const existing = record({ removed: true, canvasState: "Removed" });
    const entries = [
      ["Name Alias", "Target One"],
      ["Code Alias", "Target Two"],
    ] as const;

    for (const aliases of [
      Object.fromEntries(entries),
      Object.fromEntries([...entries].reverse()),
    ]) {
      const result = plan([aliased], [existing], courses, aliases);
      expect(result.coursesToCreate).toEqual([]);
      expect(result.assignmentsToCreate).toEqual([]);
      expect(result.assignmentsToUpdate).toEqual([
        expect.objectContaining({
          pageId: existing.pageId,
          properties: { removed: false, canvasState: "Active" },
          verifyDescription: false,
        }),
      ]);
      expect(result.assignmentsToRemove).toEqual([]);
      expect(result.warnings).toContainEqual(
        expect.objectContaining({
          code: "ambiguous-course",
          details: ["course-one", "course-two"],
        }),
      );
    }
  });

  it("accepts multiple applicable aliases that resolve to the same course", () => {
    const aliased = source({ courseName: "Name Alias", courseCode: "Code Alias" });
    delete aliased.canvasCourseId;
    const result = plan([aliased], [], [{ pageId: "course-one", title: "Target One" }], {
      "Name Alias": "Target One",
      "Code Alias": "Target One",
    });

    expect(result.assignmentsToCreate[0]?.courseKey).toBe("page:course-one");
    expect(result.warnings).not.toContainEqual(
      expect.objectContaining({ code: "ambiguous-course" }),
    );
  });

  it("generates a name when only a course ID exists", () => {
    const unnamedSource = source();
    delete unnamedSource.courseName;
    delete unnamedSource.courseCode;
    const result = plan([unnamedSource], [], []);
    expect(result.coursesToCreate[0]?.title).toBe("Canvas Course 123");
    expect(result.warnings.some((warning) => warning.code === "unnamed-course")).toBe(true);
  });

  it("skips assignments whose course has no usable identity", () => {
    const unidentified = source();
    delete unidentified.canvasCourseId;
    delete unidentified.courseName;
    delete unidentified.courseCode;
    const result = plan([unidentified]);
    expect(result.assignmentsToCreate).toEqual([]);
    expect(result.assignmentsToUpdate).toEqual([]);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "unidentified-course" }),
    );
  });

  it("plans blank-field course metadata enrichment without counting an assignment update", () => {
    const blankCourse: CourseRecord = { pageId: "course-page", title: "EE 10" };
    const result = plan([source()], [], [blankCourse]);
    expect(result.coursesToUpdate).toEqual([
      expect.objectContaining({
        pageId: "course-page",
        canvasCourseId: "123",
        canvasUrl: "https://canvas.example.edu/courses/123",
        syncUpdatedAt: "2026-07-13T12:00:00.000Z",
      }),
    ]);
    expect(result.assignmentsToCreate).toHaveLength(1);
    expect(result.assignmentsToUpdate).toHaveLength(0);
  });

  it("refreshes Sync Updated At whenever course metadata is actually enriched", () => {
    const result = plan(
      [source()],
      [],
      [
        {
          pageId: "course-page",
          title: "EE 10",
          canvasCourseId: "123",
          syncUpdatedAt: "2026-06-01T00:00:00.000Z",
        },
      ],
    );
    expect(result.coursesToUpdate[0]).toMatchObject({
      canvasUrl: "https://canvas.example.edu/courses/123",
      syncUpdatedAt: "2026-07-13T12:00:00.000Z",
    });
  });

  it("does not enrich course metadata that already agrees", () => {
    const completeCourse: CourseRecord = {
      ...course,
      url: "https://canvas.example.edu/courses/123",
      syncUpdatedAt: "2026-07-01T00:00:00.000Z",
    };
    expect(plan([source()], [], [completeCourse]).coursesToUpdate).toEqual([]);
  });

  it.each([
    [{ canvasCourseId: "999" }, "Canvas Course ID"],
    [{ canvasCourseId: "123", url: "https://canvas.example.edu/courses/other" }, "Canvas URL"],
  ] as const)("blocks assignment work for conflicting course metadata", (overrides, field) => {
    const result = plan([source()], [], [{ ...course, ...overrides }]);
    expect(result.assignmentsToCreate).toEqual([]);
    expect(result.coursesToUpdate).toEqual([]);
    const warning = result.warnings.find((item) => item.code === "course-metadata-conflict");
    expect(warning?.message).toContain(field);
  });

  it("blocks a planned course enrichment when later source metadata conflicts", () => {
    const first = source({ uid: "first", title: "First" });
    const second = source({ uid: "second", title: "Second", canvasCourseId: "999" });
    const result = plan([first, second], [], [{ pageId: "course-page", title: "EE 10" }]);

    expect(result.coursesToUpdate).toEqual([]);
    expect(result.assignmentsToCreate).toEqual([]);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "course-metadata-conflict", details: ["course-page"] }),
    );
  });

  it("removes audit and create metrics pruned by a later course conflict", () => {
    const existing = record({ uid: "auditable" });
    delete existing.descriptionVerifiedAt;
    const { result } = courseConflictPlan("auditable-first", existing);

    expect(result.assignmentsToCreate).toEqual([]);
    expect(result.assignmentsToUpdate).toEqual([]);
    expect(runMetrics(result).descriptionIntegrityAuditsDue).toBe(0);
    expect(runMetrics(result).descriptionIntegrityAuditsDeferred).toBe(0);
  });

  it("keeps finalized audit metrics independent of conflicting source order", () => {
    const existing = record({ uid: "auditable" });
    delete existing.descriptionVerifiedAt;
    const forward = courseConflictPlan("auditable-first", existing);
    const reversed = courseConflictPlan("conflicting-first", existing);

    expect(reversed.result).toEqual(forward.result);
    expect(reversed.metrics).toEqual(forward.metrics);
    expect(forward.metrics.descriptionIntegrityAuditsDue).toBe(0);
  });

  it("does not count an audit when conflict pruning retains only lifecycle properties", () => {
    const existing = record({ uid: "auditable", removed: true, canvasState: "Removed" });
    delete existing.descriptionVerifiedAt;
    const { result } = courseConflictPlan("auditable-first", existing);

    expect(result.assignmentsToUpdate).toEqual([
      expect.objectContaining({
        pageId: existing.pageId,
        properties: { removed: false, canvasState: "Active" },
        verifyDescription: false,
      }),
    ]);
    expect(runMetrics(result).descriptionIntegrityAuditsDue).toBe(0);
    expect(runMetrics(result).descriptionIntegrityAuditsDeferred).toBe(0);
  });

  it("excludes conflict-blocked deferrals and avoidances in either source order", () => {
    const verifiedAt = "2026-05-20T12:00:00.000Z";
    const now = auditDateForReason("deferred", verifiedAt);
    const existing = record({ uid: "auditable", descriptionVerifiedAt: verifiedAt });
    const forward = courseConflictPlan("auditable-first", existing, now);
    const reversed = courseConflictPlan("conflicting-first", existing, now);

    expect({
      coursesToCreate: reversed.result.coursesToCreate,
      coursesToUpdate: reversed.result.coursesToUpdate,
      assignmentsToCreate: reversed.result.assignmentsToCreate,
      assignmentsToUpdate: reversed.result.assignmentsToUpdate,
    }).toEqual({
      coursesToCreate: forward.result.coursesToCreate,
      coursesToUpdate: forward.result.coursesToUpdate,
      assignmentsToCreate: forward.result.assignmentsToCreate,
      assignmentsToUpdate: forward.result.assignmentsToUpdate,
    });
    for (const { result } of [forward, reversed]) {
      expect(runMetrics(result).descriptionIntegrityAuditsDue).toBe(0);
      expect(runMetrics(result).descriptionIntegrityAuditsDeferred).toBe(0);
      expect(runMetrics(result).descriptionUpdatesAvoided).toBe(0);
      expect(runMetrics(result).descriptionBodyReadsAvoided).toBe(0);
    }
  });

  it("detects a Canvas URL conflict against metadata enriched earlier in the plan", () => {
    const first = source({ uid: "first", title: "First" });
    const second = source({
      uid: "second",
      title: "Second",
      canvasUrl: "https://other.example.edu/courses/123/assignments/999",
    });
    const result = plan(
      [first, second],
      [],
      [{ pageId: "course-page", title: "EE 10", canvasCourseId: "123" }],
    );

    expect(result.coursesToUpdate).toEqual([]);
    expect(result.assignmentsToCreate).toEqual([]);
    const warning = result.warnings.find((item) => item.code === "course-metadata-conflict");
    expect(warning?.message).toContain("Canvas URL");
  });

  it("a description hash version change deliberately schedules revalidation", () => {
    const oldVersion = managedDescriptionHash("Original description", "canvas-description:v0");
    const { result } = planWithMetrics(record({ descriptionHash: oldVersion }));
    expect(result.assignmentsToUpdate[0]?.verifyDescription).toBe(true);
    expect(runMetrics(result).descriptionIntegrityAuditsDue).toBe(1);
    expect(runMetrics(result).descriptionIntegrityAuditsDeferred).toBe(0);
  });

  it("counts pages stored in an older description format as format upgrades", () => {
    const legacy = managedDescriptionHash("Original description", "canvas-description:v2");
    const { result, metrics } = planWithMetrics(record({ descriptionHash: legacy }));
    expect(result.planning?.descriptionFormatUpgrades).toBe(1);
    expect(metrics.descriptionFormatUpgrades).toBe(1);
    expect(result.assignmentsToUpdate[0]?.verifyDescription).toBe(true);
    // A current-format hash that merely changed content is a plain audit, not an upgrade.
    const changed = planWithMetrics(record({ descriptionHash: managedDescriptionHash("Other") }));
    expect(changed.metrics.descriptionFormatUpgrades).toBe(0);
    expect(changed.metrics.descriptionIntegrityAuditsDue).toBe(1);
    expect(planWithMetrics(record()).metrics.descriptionFormatUpgrades).toBe(0);
  });

  it("updates Canvas-owned fields on Done assignments without status writes", () => {
    const update = plan([source({ title: "Changed" })]).assignmentsToUpdate[0];
    expect(update?.properties.title).toBe("Changed");
    expect(update?.properties).not.toHaveProperty("personalStatus");
  });

  it("leaves priority blank on creation", async () => {
    const gateway = new FakeGateway();
    gateway.simulateDefaultTemplate = true;
    await createAssignment(
      gateway,
      "assignments",
      { source: source(), courseKey: "page:x" },
      "x",
      "America/Los_Angeles",
    );
    const properties = gateway.writes[0]?.value as Record<string, unknown>;
    expect(properties).not.toHaveProperty("Priority");
  });

  it("captures a manual Effective Due Date edit as an override", () => {
    const update = plan(
      [source({ dueAt: "2026-07-22T20:00:00.000Z" })],
      [record({ effectiveDueDate: "2026-07-25T20:00:00.000Z" })],
    ).assignmentsToUpdate[0];
    expect(update?.properties.overrideDueDate).toBe("2026-07-25T20:00:00.000Z");
    expect(update?.properties.effectiveDueDate).toBeUndefined();
  });

  it("preserves an existing Override Due Date", () => {
    const override = "2026-07-25T20:00:00.000Z";
    const update = plan(
      [source({ dueAt: "2026-07-22T20:00:00.000Z" })],
      [record({ overrideDueDate: override, effectiveDueDate: override })],
    ).assignmentsToUpdate[0];
    expect(update?.properties.effectiveDueDate).toBeUndefined();
    expect(update?.properties.overrideDueDate).toBeUndefined();
    expect(update?.properties.canvasDueDate).toBe("2026-07-22T20:00:00.000Z");
  });

  it("clears the override when Effective Due Date returns to Canvas", () => {
    const update = plan(
      [source()],
      [
        record({
          overrideDueDate: "2026-07-25T20:00:00.000Z",
          effectiveDueDate: "2026-07-20T20:00:00.000Z",
        }),
      ],
    ).assignmentsToUpdate[0];
    expect(update?.properties.overrideDueDate).toBeNull();
  });

  it("captures a manual Effective Due Date when Canvas has no due date", () => {
    const current = record({ effectiveDueDate: "2026-07-25" });
    delete current.canvasDueDate;
    const update = plan([sourceWithoutDueDate()], [current]).assignmentsToUpdate[0];
    expect(update?.properties.overrideDueDate).toBe("2026-07-25");
    expect(update?.properties.effectiveDueDate).toBeUndefined();
  });

  it("keeps a no-Canvas-date override when Canvas later adds or changes a due date", () => {
    const current = record({
      effectiveDueDate: "2026-07-25",
      overrideDueDate: "2026-07-25",
    });
    delete current.canvasDueDate;
    const first = plan([source({ dueAt: "2026-07-20" })], [current]).assignmentsToUpdate[0];
    expect(first?.properties.effectiveDueDate).toBeUndefined();
    expect(first?.properties.overrideDueDate).toBeUndefined();

    const changed = plan(
      [source({ dueAt: "2026-07-22" })],
      [{ ...current, canvasDueDate: "2026-07-20" }],
    ).assignmentsToUpdate[0];
    expect(changed?.properties.effectiveDueDate).toBeUndefined();
    expect(changed?.properties.overrideDueDate).toBeUndefined();
  });

  it("recaptures a cleared override while Effective Due Date still differs from Canvas", () => {
    const update = plan(
      [source({ dueAt: "2026-07-20" })],
      [
        record({
          canvasDueDate: "2026-07-20",
          effectiveDueDate: "2026-07-25",
        }),
      ],
    ).assignmentsToUpdate[0];
    expect(update?.properties.overrideDueDate).toBe("2026-07-25");
  });

  it("leaves all blank dates blank and normalizes equivalent date-only values", () => {
    const current = record();
    delete current.canvasDueDate;
    delete current.effectiveDueDate;
    const blank = plan([sourceWithoutDueDate()], [current]);
    expect(blank.assignmentsToUpdate).toHaveLength(0);

    const normalized = plan(
      [source({ dueAt: "2026-07-20T20:00:00.000Z" })],
      [record({ canvasDueDate: "2026-07-20", effectiveDueDate: "2026-07-20" })],
    );
    expect(normalized.assignmentsToUpdate).toHaveLength(0);
  });

  it("compares mixed due dates in the configured Notion timezone across local midnight", () => {
    const beforeMidnight = "2026-07-14T06:59:00.000Z";
    const afterMidnight = "2026-07-14T07:01:00.000Z";
    expect(datesEqual("2026-07-13", beforeMidnight, notionTimezone)).toBe(true);
    expect(datesEqual(beforeMidnight, "2026-07-13", notionTimezone)).toBe(true);
    expect(datesEqual("2026-07-14", beforeMidnight, notionTimezone)).toBe(false);
    expect(datesEqual("2026-07-14", afterMidnight, notionTimezone)).toBe(true);
    expect(datesEqual(afterMidnight, "2026-07-14", notionTimezone)).toBe(true);
    expect(datesEqual("2026-07-13", afterMidnight, notionTimezone)).toBe(false);
  });

  it("handles DST, timestamp instants, and date-only equality independently", () => {
    expect(datesEqual("2026-03-08", "2026-03-08T09:30:00.000Z", notionTimezone)).toBe(true);
    expect(datesEqual("2026-03-08", "2026-03-08T10:30:00.000Z", notionTimezone)).toBe(true);
    expect(
      datesEqual("2026-07-14T06:30:00.000Z", "2026-07-13T23:30:00.000-07:00", notionTimezone),
    ).toBe(true);
    expect(datesEqual("2026-07-13", "2026-07-13", notionTimezone)).toBe(true);
    expect(datesEqual("2026-07-13", "2026-07-14", notionTimezone)).toBe(false);
  });

  it("captures and clears overrides using timezone-aware mixed-date semantics", () => {
    const captured = plan(
      [source({ dueAt: "2026-07-14" })],
      [
        record({
          canvasDueDate: "2026-07-14",
          effectiveDueDate: "2026-07-14T06:30:00.000Z",
        }),
      ],
    ).assignmentsToUpdate[0];
    expect(captured?.properties.overrideDueDate).toBe("2026-07-14T06:30:00.000Z");

    const cleared = plan(
      [source({ dueAt: "2026-07-13" })],
      [
        record({
          canvasDueDate: "2026-07-13",
          effectiveDueDate: "2026-07-14T06:30:00.000Z",
          overrideDueDate: "2026-07-15",
        }),
      ],
    ).assignmentsToUpdate[0];
    expect(cleared?.properties.overrideDueDate).toBeNull();
    expect(cleared?.properties.effectiveDueDate).toBeUndefined();
  });

  it("treats a first absent in-window assignment as a candidate", () => {
    const other = source({
      uid: "uid-other",
      title: "Different assignment",
      canvasAssignmentId: "999",
      canvasUrl: "https://canvas.example.edu/courses/123/assignments/999",
      dueAt: "2026-08-01T20:00:00.000Z",
    });
    const result = plan([other], [record()]);
    expect(result.assignmentsToRemove).toHaveLength(0);
    expect(result.assignmentsMissingEvidenceToUpdate).toEqual([
      {
        pageId: "assignment-page",
        canvasMissingSince: "2026-07-13T12:00:00.000Z",
        canvasMissingCount: 1,
        transition: "observed",
      },
    ]);
  });

  it("protects a raw assignment UID that could not be normalized", () => {
    const malformed = event(
      "UID:uid-1\nDTSTART:20260720T200000Z\nURL:https://canvas.example.edu/courses/123/assignments/456",
    );
    const other = event(
      "UID:uid-other\nDTSTART:20260801T200000Z\nSUMMARY:Different assignment [EE 10]\nURL:https://canvas.example.edu/courses/123/assignments/999",
    );
    const value = parseIcs(calendar(`${malformed}\n${other}`), assignmentTypeMatcher);
    expect(planFeed(value).assignmentsToRemove).toHaveLength(0);
  });

  it("protects a duplicate source UID from removal", () => {
    const duplicate = event(
      "UID:uid-1\nDTSTART:20260720T200000Z\nSUMMARY:Homework 1 [EE 10]\nURL:https://canvas.example.edu/courses/123/assignments/456",
    );
    const value = parseIcs(calendar(`${duplicate}\n${duplicate}`), assignmentTypeMatcher);
    expect(planFeed(value).assignmentsToRemove).toHaveLength(0);
  });

  it("does not advance unrelated absence evidence when source UID data is duplicated", () => {
    const duplicate = event(
      "UID:uid-other\nDTSTART:20260720T200000Z\nSUMMARY:Other [EE 10]\nURL:https://canvas.example.edu/courses/123/assignments/999",
    );
    const value = parseIcs(calendar(`${duplicate}\n${duplicate}`), assignmentTypeMatcher);
    const result = planFeed(value, [
      record({ canvasMissingSince: "2026-07-12T00:00:00Z", canvasMissingCount: 1 }),
    ]);
    expect(result.assignmentsMissingEvidenceToUpdate).toHaveLength(0);
    expect(result.warnings.some((warning) => warning.code === "removals-unsafe-duplicate")).toBe(
      true,
    );
  });

  it("does not match title and date across different Canvas courses", () => {
    const otherCourse: CourseRecord = {
      pageId: "other-course-page",
      title: "CS 20",
      courseCode: "CS 20",
      canvasCourseId: "999",
    };
    const incoming = source({
      uid: "new-uid",
      courseName: "CS 20",
      courseCode: "CS 20",
      canvasCourseId: "999",
      canvasAssignmentId: "888",
      canvasUrl: "https://canvas.example.edu/courses/999/assignments/888",
    });
    const result = plan([incoming], [record()], [course, otherCourse]);
    expect(result.assignmentsToCreate).toHaveLength(1);
    expect(
      result.warnings.some((warning) => warning.code === "possible-assignment-duplicate"),
    ).toBe(false);
  });

  it("matches title and date when course evidence is compatible", () => {
    const incoming = source({ uid: "new-uid" });
    delete incoming.canvasAssignmentId;
    delete incoming.canvasUrl;
    const candidate = record();
    delete candidate.canvasUrl;
    const result = plan([incoming], [candidate]);
    expect(result.assignmentsToCreate).toHaveLength(0);
    expect(
      result.warnings.some((warning) => warning.code === "possible-assignment-duplicate"),
    ).toBe(true);
  });

  it("uses an exact normalized Canvas assignment URL as strong duplicate evidence", () => {
    const incoming = source({
      uid: "new-uid",
      title: "Unrelated title",
      dueAt: "2026-08-02T20:00:00.000Z",
      canvasUrl: "https://canvas.example.edu/courses/123/assignments/456/?module_item_id=9",
    });
    delete incoming.canvasAssignmentId;
    const result = plan([incoming]);
    expect(result.assignmentsToCreate).toHaveLength(0);
    expect(
      result.warnings.some((warning) => warning.code === "possible-assignment-duplicate"),
    ).toBe(true);
  });

  it.each([
    ["different malformed URLs", "not a url", "also not a url"],
    ["a malformed and a missing URL", "not a url", undefined],
  ])("does not use %s as duplicate evidence", (_name, sourceUrl, candidateUrl) => {
    const incoming = source({
      uid: "new-uid",
      title: "Different title",
      dueAt: "2026-08-02T20:00:00.000Z",
      canvasUrl: sourceUrl,
    });
    delete incoming.canvasAssignmentId;
    const existing = record({
      uid: "old-uid",
      title: "Original title",
      canvasDueDate: "2026-07-20T20:00:00.000Z",
      ...(candidateUrl === undefined ? {} : { canvasUrl: candidateUrl }),
    });
    if (candidateUrl === undefined) delete existing.canvasUrl;
    const result = plan([incoming], [existing]);
    expect(result.assignmentsToCreate).toHaveLength(1);
    expect(
      result.warnings.some((warning) => warning.code === "possible-assignment-duplicate"),
    ).toBe(false);
  });

  it("still uses an explicit assignment ID when URL evidence is omitted", () => {
    const incoming = source({
      uid: "new-uid",
      title: "Different title",
      dueAt: "2026-08-02T20:00:00.000Z",
    });
    delete incoming.canvasUrl;
    const result = plan([incoming]);
    expect(result.assignmentsToCreate).toEqual([]);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: "possible-assignment-duplicate",
        details: ["assignment-page"],
      }),
    );
  });

  it("uses a Canvas assignment ID as duplicate evidence independently of the URL", () => {
    const incoming = source({
      uid: "new-uid",
      title: "Different title",
      dueAt: "2026-08-02T20:00:00.000Z",
      canvasAssignmentId: "456",
      canvasUrl: "https://other.example.edu/courses/999/assignments/999",
    });
    const result = plan([incoming]);
    expect(result.assignmentsToCreate).toEqual([]);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: "possible-assignment-duplicate",
        details: ["assignment-page"],
      }),
    );
  });

  it("uses timezone-aware mixed dates when protecting possible duplicates", () => {
    const incoming = source({
      uid: "new-uid",
      dueAt: "2026-07-14T06:30:00.000Z",
    });
    delete incoming.canvasAssignmentId;
    delete incoming.canvasUrl;
    const existing = record({ uid: "old-uid", canvasDueDate: "2026-07-13" });
    delete existing.canvasUrl;
    const result = plan([incoming], [existing]);
    expect(result.assignmentsToCreate).toEqual([]);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: "possible-assignment-duplicate",
        details: [existing.pageId],
      }),
    );
  });

  it("retains duplicate candidate and duplicate Notion UID page ordering", () => {
    const candidates = [
      record({ pageId: "page-two", uid: "old-two" }),
      record({ pageId: "page-one", uid: "old-one" }),
    ];
    const duplicate = plan([source({ uid: "new-uid" })], candidates);
    expect(duplicate.warnings[0]?.details).toEqual(["page-two", "page-one"]);

    const duplicateUid = plan(
      [source()],
      [record({ pageId: "uid-two" }), record({ pageId: "uid-one" })],
    );
    expect(duplicateUid.warnings[0]).toMatchObject({
      code: "duplicate-notion-uid",
      details: ["uid-two", "uid-one"],
    });
  });

  it("uses the assignment indexes for cancelled new UIDs", () => {
    const value = feed([], 1, {
      cancelledAssignments: [
        source({
          uid: "cancelled-new",
          canvasUrl: "https://canvas.example.edu/courses/123/assignments/456/?module=1",
        }),
      ],
    });
    const result = planFeed(value);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: "possible-assignment-duplicate",
        details: ["assignment-page"],
      }),
    );
  });

  it("keeps diagnostic counts, details, and warning order stable", () => {
    const value = feed([], 5, {
      diagnostics: {
        events: [
          { kind: "ignored", reason: "ordinary-calendar-event", indicators: [] },
          {
            kind: "suspicious",
            reason: "assignment-like-event",
            uid: "suspicious",
            indicators: [],
          },
          {
            kind: "duplicate",
            reason: "duplicate-source-uid",
            uid: "duplicate-one",
            indicators: [],
          },
          {
            kind: "malformed",
            reason: "malformed-assignment-event",
            uid: "malformed",
            indicators: [],
          },
          {
            kind: "duplicate",
            reason: "duplicate-source-uid",
            uid: "duplicate-two",
            indicators: [],
          },
        ],
      },
    });
    expect(feedDiagnosticSummary(value)).toMatchObject({
      ignoredEvents: 1,
      suspiciousEvents: 1,
      malformedEvents: 1,
      duplicateUids: 2,
    });
    expect(feedWarnings(value)).toEqual([
      {
        code: "duplicate-source-uids",
        message: "2 duplicate source UID(s) were quarantined",
        details: ["duplicate UID redacted", "duplicate UID redacted"],
      },
      {
        code: "malformed-events",
        message: "1 malformed assignment-like event(s) were quarantined",
      },
      {
        code: "suspicious-feed-events",
        message: "1 assignment-like event(s) were quarantined",
        details: ["assignment-like-event"],
      },
    ]);
  });

  it("reuses one plan timestamp for every course enrichment", () => {
    const now = new Date("2026-07-13T12:00:00Z");
    const toISOString = vi
      .spyOn(now, "toISOString")
      .mockReturnValueOnce("2026-07-13T12:00:00.000Z")
      .mockReturnValue("2026-07-13T12:00:01.000Z");
    const assignments = [
      source({
        uid: "one",
        title: "One assignment",
        canvasCourseId: "1",
        canvasAssignmentId: "101",
        canvasUrl: "https://canvas.example.edu/courses/1/assignments/101",
        courseName: "One",
        courseCode: "ONE",
      }),
      source({
        uid: "two",
        title: "Two assignment",
        canvasCourseId: "2",
        canvasAssignmentId: "102",
        canvasUrl: "https://canvas.example.edu/courses/2/assignments/102",
        courseName: "Two",
        courseCode: "TWO",
      }),
    ];
    const result = buildPlan(
      feed(assignments),
      [
        record({
          pageId: "missing",
          uid: "missing",
          title: "Missing assignment",
          coursePageIds: ["course-one"],
          canvasUrl: "https://canvas.example.edu/courses/1/assignments/999",
        }),
      ],
      [
        { pageId: "course-one", title: "One" },
        { pageId: "course-two", title: "Two" },
      ],
      { notionTimezone, now },
    );
    expect(toISOString).toHaveBeenCalledTimes(1);
    expect(result.coursesToUpdate.map((update) => update.syncUpdatedAt)).toEqual([
      "2026-07-13T12:00:00.000Z",
      "2026-07-13T12:00:00.000Z",
    ]);
  });

  it("builds linear indexes instead of rescanning full collections per source assignment", () => {
    const size = 400;
    const courses = Array.from({ length: size }, (_, index): CourseRecord => ({
      pageId: `course-${index}`,
      title: `Course ${index}`,
      courseCode: `CODE ${index}`,
      canvasCourseId: String(index),
    }));
    const existing = Array.from({ length: size }, (_, index): AssignmentRecord =>
      record({
        pageId: `existing-${index}`,
        uid: `existing-${index}`,
        title: `Existing ${index}`,
        coursePageIds: [`course-${index}`],
        canvasUrl: `https://canvas.example.edu/courses/${index}/assignments/${index}`,
      }),
    );
    const assignments = Array.from({ length: size }, (_, index): ExternalAssignment =>
      source({
        uid: `incoming-${index}`,
        title: `Incoming ${index}`,
        courseName: `Course ${index}`,
        courseCode: `CODE ${index}`,
        canvasCourseId: String(index),
        canvasAssignmentId: String(10_000 + index),
        canvasUrl: `https://canvas.example.edu/courses/${index}/assignments/${10_000 + index}`,
      }),
    );
    const normalizations = vi.mocked(normalizeCourse);
    normalizations.mockClear();
    const result = buildPlan(feed(assignments), existing, courses, {
      notionTimezone,
      now: new Date("2026-07-13T12:00:00Z"),
    });
    expect(result.assignmentsToCreate).toHaveLength(size);
    // Two labels per course for the index, then two per source for matching, duplicate
    // screening, and settling. A rescan would multiply any of these by the course count.
    expect(normalizations.mock.calls).toHaveLength(size * 8);
  });

  it("does not create an active assignment for a cancelled new event", () => {
    const value = feed([], 1, {
      cancelledAssignments: [source({ uid: "cancelled-new" })],
      diagnostics: {
        sourceUids: ["cancelled-new"],
        quarantinedUids: ["cancelled-new"],
        events: [
          {
            kind: "cancelled",
            reason: "cancelled-assignment",
            uid: "cancelled-new",
            indicators: ["status-cancelled"],
          },
        ],
      },
    });
    const result = planFeed(value, []);
    expect(result.assignmentsToCreate).toHaveLength(0);
    expect(result.assignmentsToUpdate).toHaveLength(0);
    expect(result.assignmentsToRemove).toHaveLength(0);
  });

  it("marks a cancelled existing assignment removed and clears its missing evidence", () => {
    const existing = record({
      canvasMissingSince: "2026-07-12T00:00:00Z",
      canvasMissingCount: 1,
    });
    const value = feed([], 1, {
      cancelledAssignments: [source()],
      diagnostics: {
        sourceUids: ["uid-1"],
        quarantinedUids: ["uid-1"],
        events: [
          {
            kind: "cancelled",
            reason: "cancelled-assignment",
            uid: "uid-1",
            indicators: ["status-cancelled"],
          },
        ],
      },
    });
    expect(planFeed(value, [existing]).assignmentsToRemove[0]).toMatchObject({
      pageId: "assignment-page",
      reason: "explicit-cancellation",
      clearMissingEvidence: true,
    });
  });

  it("ignores ordinary calendar events without plan warnings", () => {
    const value = feed([], 1, {
      diagnostics: {
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
    });
    expect(planFeed(value, []).warnings).toEqual([]);
  });

  it("preserves existing assignments when the feed contains only ordinary events", () => {
    const value = feed([], 1, {
      diagnostics: {
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
    });
    const result = planFeed(value);
    expect(result.assignmentsToRemove).toHaveLength(0);
    expect(
      result.warnings.some((warning) => warning.code === "unexpected-no-assignment-signals"),
    ).toBe(true);
  });

  it("observes an absent assignment when ordinary events accompany a valid one", () => {
    const existing = [record(), record({ pageId: "assignment-absent", uid: "uid-absent" })];
    const value = feed([source()], 2, {
      diagnostics: {
        sourceUids: ["uid-1", "calendar-event"],
        events: [
          {
            kind: "ignored",
            reason: "ordinary-calendar-event",
            uid: "calendar-event",
            indicators: [],
          },
        ],
      },
    });
    const result = planFeed(value, existing);
    expect(result.assignmentsToRemove).toHaveLength(0);
    expect(result.assignmentsMissingEvidenceToUpdate.map((item) => item.pageId)).toEqual([
      "assignment-absent",
    ]);
  });

  it("warns for suspicious assignment-like events", () => {
    const value = feed([], 1, {
      diagnostics: {
        sourceUids: ["suspicious-event"],
        quarantinedUids: ["suspicious-event"],
        events: [
          {
            kind: "suspicious",
            reason: "assignment-like-event",
            uid: "suspicious-event",
            indicators: ["assignment-category"],
          },
        ],
      },
    });
    expect(
      planFeed(value, []).warnings.some((warning) => warning.code === "suspicious-feed-events"),
    ).toBe(true);
  });

  it("reactivates a reappearing removed assignment", () => {
    const update = plan(
      [source()],
      [
        record({
          removed: true,
          canvasState: "Removed",
          canvasMissingSince: "2026-07-12T00:00:00Z",
          canvasMissingCount: 2,
        }),
      ],
    ).assignmentsToUpdate[0];
    expect(update?.properties).toMatchObject({ removed: false, canvasState: "Active" });
    expect(update?.properties.canvasMissingSince).toBeNull();
    expect(update?.properties.canvasMissingCount).toBeNull();
  });

  it.each([
    {
      name: "an ambiguous course match",
      incoming: (() => {
        const value = source({ title: "Unsafe changed title" });
        delete value.canvasCourseId;
        return value;
      })(),
      courses: [course, { ...course, pageId: "course-page-2" }],
      warning: "ambiguous-course",
      existingCoursePageId: "existing-course",
    },
    {
      name: "no usable course identity",
      incoming: (() => {
        const value = source({ title: "Unsafe changed title" });
        delete value.canvasCourseId;
        delete value.courseName;
        delete value.courseCode;
        return value;
      })(),
      courses: [course],
      warning: "unidentified-course",
      existingCoursePageId: "existing-course",
    },
    {
      name: "conflicting course metadata",
      incoming: source({ title: "Unsafe changed title" }),
      courses: [{ ...course, canvasCourseId: "999" }],
      warning: "course-metadata-conflict",
      existingCoursePageId: "course-page",
    },
  ])("reactivates an exact UID despite $name without unsafe updates", (testCase) => {
    const existing = record({
      coursePageIds: [testCase.existingCoursePageId],
      removed: true,
      canvasState: "Removed",
      canvasMissingSince: "2026-07-12T00:00:00.000Z",
      canvasMissingCount: 2,
    });
    const result = plan([testCase.incoming], [existing], testCase.courses);
    expect(result.assignmentsToUpdate).toHaveLength(1);
    expect(result.assignmentsToUpdate[0]).toMatchObject({
      pageId: existing.pageId,
      courseKey: `page:${testCase.existingCoursePageId}`,
      properties: {
        removed: false,
        canvasState: "Active",
        canvasMissingSince: null,
        canvasMissingCount: null,
      },
      verifyDescription: false,
      missingEvidenceCleared: true,
    });
    expect(result.assignmentsToUpdate[0]?.properties).toEqual({
      removed: false,
      canvasState: "Active",
      canvasMissingSince: null,
      canvasMissingCount: null,
    });
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: testCase.warning }));
  });

  it("does not reactivate duplicate Notion UID matches speculatively", () => {
    const duplicateMatches = [
      record({ pageId: "duplicate-one", removed: true, canvasState: "Removed" }),
      record({ pageId: "duplicate-two", removed: true, canvasState: "Removed" }),
    ];
    const result = plan([source()], duplicateMatches);
    expect(result.assignmentsToUpdate).toEqual([]);
    expect(result.assignmentsToRemove).toEqual([]);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: "duplicate-notion-uid",
        details: ["duplicate-one", "duplicate-two"],
      }),
    );
  });

  it("clears missing evidence when an active assignment reappears", () => {
    const update = plan(
      [source()],
      [
        record({
          canvasMissingSince: "2026-07-12T00:00:00Z",
          canvasMissingCount: 1,
        }),
      ],
    ).assignmentsToUpdate[0];
    expect(update?.missingEvidenceCleared).toBe(true);
    expect(update?.properties.canvasMissingSince).toBeNull();
    expect(update?.properties.canvasMissingCount).toBeNull();
    expect(update?.properties).not.toHaveProperty("personalStatus");
    expect(update?.properties).not.toHaveProperty("priority");
    expect(update?.properties).not.toHaveProperty("assignmentType");
  });

  it("requires both repeated scheduled evidence and the minimum interval", () => {
    const other = source({
      uid: "other",
      title: "Other",
      canvasAssignmentId: "999",
      canvasUrl: "https://canvas.example.edu/courses/123/assignments/999",
    });
    const beforeInterval = planFeed(feed([other]), [
      record({
        canvasMissingSince: "2026-07-13T10:00:00Z",
        canvasMissingCount: 1,
      }),
    ]);
    expect(beforeInterval.assignmentsToRemove).toHaveLength(0);
    expect(beforeInterval.assignmentsMissingEvidenceToUpdate[0]?.canvasMissingCount).toBe(2);

    const qualifyingNow = new Date(
      Date.parse("2026-07-13T10:00:00Z") + DEFAULT_MISSING_EVIDENCE_MINIMUM_HOURS * 60 * 60 * 1000,
    );
    const qualifying = planFeed(
      feed([other]),
      [
        record({
          canvasMissingSince: "2026-07-13T10:00:00Z",
          canvasMissingCount: 1,
        }),
      ],
      [course],
      {},
      "scheduled",
      qualifyingNow,
    );
    expect(qualifying.assignmentsToRemove[0]).toMatchObject({
      reason: "persistent-absence",
      canvasMissingCountAfter: 2,
    });
  });

  it("manual runs observe absence without advancing persistent evidence", () => {
    const result = planFeed(
      feed([
        source({
          uid: "other",
          title: "Other",
          canvasAssignmentId: "999",
          canvasUrl: "https://canvas.example.edu/courses/123/assignments/999",
        }),
      ]),
      [record({ canvasMissingSince: "2026-07-12T00:00:00Z", canvasMissingCount: 1 })],
      [course],
      {},
      "manual",
    );
    expect(result.assignmentsMissingEvidenceToUpdate).toHaveLength(0);
    expect(result.assignmentsToRemove).toHaveLength(0);
    expect(result.warnings.some((warning) => warning.code === "missing-candidates-manual")).toBe(
      true,
    );
  });

  it("unsafe feeds neither advance nor clear prior evidence for absent assignments", () => {
    const unsafe = feed([source({ uid: "other", title: "Other" })], 1000);
    const result = planFeed(unsafe, [
      record({ canvasMissingSince: "2026-07-12T00:00:00Z", canvasMissingCount: 1 }),
    ]);
    expect(result.assignmentsMissingEvidenceToUpdate).toHaveLength(0);
    expect(result.assignmentsToRemove).toHaveLength(0);
    expect(result.assignmentsToUpdate).toHaveLength(0);
  });

  it("an unsafe feed still clears evidence for its positively present active UID", () => {
    const result = planFeed(feed([source()], 1000), [
      record({ canvasMissingSince: "2026-07-12T00:00:00Z", canvasMissingCount: 1 }),
    ]);
    expect(result.assignmentsMissingEvidenceToUpdate).toHaveLength(0);
    expect(result.assignmentsToUpdate[0]?.properties).toMatchObject({
      canvasMissingSince: null,
      canvasMissingCount: null,
    });
  });

  it("suppresses removal on an unexpectedly empty feed", () => {
    const result = plan([], [record()]);
    expect(result.assignmentsToRemove).toHaveLength(0);
    expect(
      result.warnings.some((warning) => warning.code === "unexpected-no-assignment-signals"),
    ).toBe(true);
  });

  it("suppresses removal at 1,000 feed items", () => {
    const result = buildPlan(feed([], 1000), [record()], [course], {
      notionTimezone,
      now: new Date("2026-07-13T12:00:00Z"),
    });
    expect(result.assignmentsToRemove).toHaveLength(0);
    expect(result.warnings.some((warning) => warning.code === "removals-feed-limit")).toBe(true);
  });

  it("honors removal-disabled mode", () => {
    const result = buildPlan(feed([]), [record()], [course], {
      disableRemovals: true,
      notionTimezone,
      now: new Date("2026-07-13T12:00:00Z"),
    });
    expect(result.assignmentsToRemove).toHaveLength(0);
  });
});

describe("course keys survive apply", () => {
  const applyOptions = { now: () => new Date("2026-07-13T12:00:00Z") };

  // Course identity must come only from what each test states, so drop the defaults it omits.
  function unlinkedSource(overrides: Partial<ExternalAssignment> = {}): ExternalAssignment {
    const value = source(overrides);
    delete value.canvasUrl;
    if (overrides.canvasCourseId === undefined) delete value.canvasCourseId;
    if (overrides.courseCode === undefined) delete value.courseCode;
    return value;
  }

  it("relinks an assignment to another existing course using a resolvable key", async () => {
    const otherCourse: CourseRecord = { pageId: "course-page-2", title: "PHYS 5" };
    const moved = unlinkedSource({ courseName: "PHYS 5", courseCode: "PHYS 5" });
    const result = buildPlan(feed([moved]), [record()], [course, otherCourse], {
      notionTimezone,
      now: new Date("2026-07-13T12:00:00Z"),
    });

    // A bare page ID here is not a course key, so apply cannot resolve it.
    expect(result.assignmentsToUpdate[0]?.properties.coursePageId).toBe("page:course-page-2");

    const gateway = new FakeGateway();
    await applyPlan(gateway, config(), result, applyOptions);
    const write = gateway.writes.find(
      (entry) => entry.kind === "update" && entry.id === "assignment-page",
    );
    expect((write?.value as Record<string, unknown>).Course).toEqual({
      relation: [{ id: "course-page-2" }],
    });
  });

  it("rewrites a queued Course relation when its provisional course is redirected", async () => {
    const provisional = unlinkedSource({ uid: "uid-1", courseName: "Bio" });
    const resolving = unlinkedSource({
      uid: "uid-2",
      title: "Homework 2",
      courseName: "Bio",
      courseCode: "BIO101",
    });
    const result = buildPlan(
      feed([provisional, resolving]),
      [
        record({ uid: "uid-1", coursePageIds: [] }),
        record({ pageId: "assignment-page-2", uid: "uid-2", title: "Homework 2" }),
      ],
      [{ pageId: "course-page", title: "Biology 101", courseCode: "BIO101" }],
      { notionTimezone, now: new Date("2026-07-13T12:00:00Z") },
    );

    // The provisional create is dropped, so a relation still pointing at it would strand apply.
    expect(result.coursesToCreate).toHaveLength(0);
    const relinked = result.assignmentsToUpdate.find(
      (assignment) => assignment.pageId === "assignment-page",
    );
    expect(relinked?.properties.coursePageId).toBe("page:course-page");

    const gateway = new FakeGateway();
    await applyPlan(gateway, config(), result, applyOptions);
    const write = gateway.writes.find(
      (entry) => entry.kind === "update" && entry.id === "assignment-page",
    );
    expect((write?.value as Record<string, unknown>).Course).toEqual({
      relation: [{ id: "course-page" }],
    });
  });

  it("keeps a conflicted course blocked when its provisional key is redirected", async () => {
    const conflicted = unlinkedSource({ uid: "uid-1", courseName: "Bio", canvasCourseId: "1" });
    // Distinct assignment IDs so duplicate detection does not skip them before course matching.
    const conflicting = unlinkedSource({
      uid: "uid-2",
      title: "Homework 2",
      courseName: "Bio",
      canvasCourseId: "2",
      canvasAssignmentId: "457",
    });
    const redirecting = unlinkedSource({
      uid: "uid-3",
      title: "Homework 3",
      courseName: "Bio",
      courseCode: "BIO101",
      canvasAssignmentId: "458",
    });
    const result = buildPlan(
      feed([conflicted, conflicting, redirecting]),
      [record({ uid: "uid-1", coursePageIds: [] })],
      [{ pageId: "course-page", title: "Biology 101", courseCode: "BIO101" }],
      { notionTimezone, now: new Date("2026-07-13T12:00:00Z") },
    );

    // The plan reports the course as conflicted, so it must not also write the relation.
    expect(result.warnings.map((warning) => warning.code)).toContain("course-metadata-conflict");
    const relinked = result.assignmentsToUpdate.find(
      (assignment) => assignment.pageId === "assignment-page",
    );
    expect(relinked?.properties.coursePageId).toBeUndefined();

    const gateway = new FakeGateway();
    gateway.simulateDefaultTemplate = true;
    await applyPlan(gateway, config(), result, {
      ...applyOptions,
      templateWait: { attempts: 2, sleep: async () => {} },
    });
    const courseWrites = gateway.writes.filter(
      (entry) =>
        entry.kind === "update" &&
        entry.id === "assignment-page" &&
        (entry.value as Record<string, unknown>).Course,
    );
    expect(courseWrites).toHaveLength(0);
  });

  // Built from scratch so course identity comes only from the fields under test.
  function courseOnlySource(
    uid: string,
    overrides: Partial<ExternalAssignment>,
  ): ExternalAssignment {
    return { uid, title: `Assignment ${uid}`, inferredType: "Other", ...overrides };
  }

  it("does not reuse a planned course ID after a conflict drops a planned create", () => {
    const result = buildPlan(
      feed([
        courseOnlySource("uid-a", { courseName: "Intro Bio", canvasCourseId: "1" }),
        courseOnlySource("uid-b", { courseName: "Intro Bio", canvasCourseId: "2" }),
        courseOnlySource("uid-c", { courseName: "Chemistry" }),
        courseOnlySource("uid-d", { courseName: "Chemistry", canvasCourseId: "7" }),
        courseOnlySource("uid-e", { canvasCourseId: "7" }),
      ]),
      [],
      [],
      { notionTimezone, now: new Date("2026-07-13T12:00:00Z") },
    );

    // Chemistry is planned once; a colliding synthetic ID used to strand its Canvas course ID
    // and produce a second "Canvas Course 7" page for the same course.
    expect(result.coursesToCreate.map((entry) => entry.key)).toEqual(["name:chemistry"]);
    expect(result.coursesToCreate[0]?.canvasCourseId).toBe("7");
    expect(
      result.assignmentsToCreate
        .filter((assignment) => ["uid-c", "uid-d", "uid-e"].includes(assignment.source.uid))
        .map((assignment) => assignment.courseKey),
    ).toEqual(["name:chemistry", "name:chemistry", "name:chemistry"]);
  });
});
