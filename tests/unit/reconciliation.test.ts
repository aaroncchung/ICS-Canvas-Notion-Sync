import { describe, expect, it } from "vitest";
import { createAssignment } from "../../src/notion/assignments.js";
import { buildPlan } from "../../src/sync/plan.js";
import type {
  AssignmentFeed,
  AssignmentRecord,
  CourseRecord,
  ExternalAssignment,
} from "../../src/types.js";
import { FakeGateway } from "../helpers.js";

const course: CourseRecord = {
  pageId: "course-page",
  title: "EE 10",
  courseCode: "EE 10",
  canvasCourseId: "123",
};

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
    rawClassificationEvidence: ["canvas-assignment-route"],
    ...overrides,
  };
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
    managedDescription: "Original description",
    personalStatus: "Done",
    removed: false,
    canvasState: "Active",
    importedFrom: "Canvas ICS",
    ...overrides,
  };
}

function feed(assignments: ExternalAssignment[], totalEvents = assignments.length): AssignmentFeed {
  return {
    assignments,
    diagnostics: {
      totalEvents,
      assignmentsParsed: assignments.length,
      duplicateUids: [],
      malformedEvents: 0,
      skippedEvents: [],
      complete: true,
    },
  };
}

function plan(
  assignments: ExternalAssignment[],
  existing: AssignmentRecord[] = [record()],
  courses: CourseRecord[] = [course],
  aliases: Record<string, string> = {},
) {
  return buildPlan(
    feed(assignments),
    existing,
    courses,
    aliases,
    false,
    new Date("2026-07-13T12:00:00Z"),
  );
}

describe("plan-first reconciliation", () => {
  it("a repeated run is unchanged and creates no duplicate", () => {
    const result = plan([source()]);
    expect(result.assignmentsToCreate).toHaveLength(0);
    expect(result.assignmentsToUpdate).toHaveLength(0);
    expect(result.unchanged).toBe(1);
  });
  it("16-18 plans changed title, due date, and description", () => {
    const result = plan([
      source({
        title: "Homework 1 revised",
        dueAt: "2026-07-21T20:00:00.000Z",
        descriptionPlainText: "Changed description",
        descriptionMarkdown: "Changed description",
      }),
    ]);
    expect(result.assignmentsToUpdate[0]).toMatchObject({
      updateDescription: true,
      properties: {
        title: "Homework 1 revised",
        canvasDueDate: "2026-07-21T20:00:00.000Z",
        effectiveDueDate: "2026-07-21T20:00:00.000Z",
        rawDescription: "Changed description",
      },
    });
  });

  it("20 flags a same-looking assignment with a changed UID", () => {
    const result = plan([source({ uid: "new-uid" })]);
    expect(result.assignmentsToCreate).toHaveLength(0);
    expect(
      result.warnings.some((warning) => warning.code === "possible-assignment-duplicate"),
    ).toBe(true);
  });

  it("24 creates a new course and assignment", () => {
    const result = plan([source()], [], []);
    expect(result.coursesToCreate).toHaveLength(1);
    expect(result.assignmentsToCreate).toHaveLength(1);
  });

  it("25 uses a configured course alias", () => {
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

  it("26 skips an ambiguous course match", () => {
    const ambiguousSource = source();
    delete ambiguousSource.canvasCourseId;
    const result = plan([ambiguousSource], [], [course, { ...course, pageId: "course-page-2" }]);
    expect(result.assignmentsToCreate).toHaveLength(0);
    expect(result.warnings.some((warning) => warning.code === "ambiguous-course")).toBe(true);
  });

  it("27 generates a name when only a course ID exists", () => {
    const unnamedSource = source();
    delete unnamedSource.courseName;
    delete unnamedSource.courseCode;
    const result = plan([unnamedSource], [], []);
    expect(result.coursesToCreate[0]?.title).toBe("Canvas Course 123");
    expect(result.warnings.some((warning) => warning.code === "unnamed-course")).toBe(true);
  });

  it("28 updates Canvas-owned fields on Done assignments without status writes", () => {
    const update = plan([source({ title: "Changed" })]).assignmentsToUpdate[0];
    expect(update?.properties.title).toBe("Changed");
    expect(update?.properties).not.toHaveProperty("personalStatus");
  });

  it("29 leaves priority blank on creation", async () => {
    const gateway = new FakeGateway();
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

  it("30 captures a manual Effective Due Date edit as an override", () => {
    const update = plan(
      [source({ dueAt: "2026-07-22T20:00:00.000Z" })],
      [record({ effectiveDueDate: "2026-07-25T20:00:00.000Z" })],
    ).assignmentsToUpdate[0];
    expect(update?.properties.overrideDueDate).toBe("2026-07-25T20:00:00.000Z");
    expect(update?.properties.effectiveDueDate).toBeUndefined();
  });

  it("31 preserves an existing Override Due Date", () => {
    const override = "2026-07-25T20:00:00.000Z";
    const update = plan(
      [source({ dueAt: "2026-07-22T20:00:00.000Z" })],
      [record({ overrideDueDate: override, effectiveDueDate: override })],
    ).assignmentsToUpdate[0];
    expect(update?.properties.effectiveDueDate).toBeUndefined();
    expect(update?.properties.overrideDueDate).toBeUndefined();
    expect(update?.properties.canvasDueDate).toBe("2026-07-22T20:00:00.000Z");
  });

  it("32 clears the override when Effective Due Date returns to Canvas", () => {
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

  it("33 marks an absent in-window assignment removed", () => {
    const other = source({
      uid: "uid-other",
      title: "Different assignment",
      canvasAssignmentId: "999",
      canvasUrl: "https://canvas.example.edu/courses/123/assignments/999",
      dueAt: "2026-08-01T20:00:00.000Z",
    });
    expect(plan([other], [record()]).assignmentsToRemove).toHaveLength(1);
  });

  it("34 reactivates a reappearing removed assignment", () => {
    const update = plan([source()], [record({ removed: true, canvasState: "Removed" })])
      .assignmentsToUpdate[0];
    expect(update?.properties).toMatchObject({ removed: false, canvasState: "Active" });
  });

  it("35 suppresses removal on an unexpectedly empty feed", () => {
    const result = plan([], [record()]);
    expect(result.assignmentsToRemove).toHaveLength(0);
    expect(result.warnings.some((warning) => warning.code === "unexpected-empty-feed")).toBe(true);
  });

  it("36 suppresses removal at 1,000 feed items", () => {
    const result = buildPlan(
      feed([], 1000),
      [record()],
      [course],
      {},
      false,
      new Date("2026-07-13T12:00:00Z"),
    );
    expect(result.assignmentsToRemove).toHaveLength(0);
    expect(result.warnings.some((warning) => warning.code === "removals-feed-limit")).toBe(true);
  });

  it("37 honors removal-disabled mode", () => {
    const result = buildPlan(
      feed([]),
      [record()],
      [course],
      {},
      true,
      new Date("2026-07-13T12:00:00Z"),
    );
    expect(result.assignmentsToRemove).toHaveLength(0);
  });

  it("preserves all Notion-owned fields on removal", () => {
    const removed = plan(
      [
        source({
          uid: "uid-other",
          title: "Different assignment",
          canvasUrl: "https://canvas.example.edu/courses/123/assignments/999",
          dueAt: "2026-08-01T20:00:00.000Z",
        }),
      ],
      [record({ priority: "High", assignmentType: "Quiz" })],
    ).assignmentsToRemove[0];
    expect(removed).toMatchObject({
      personalStatus: "Done",
      priority: "High",
      assignmentType: "Quiz",
    });
  });
});
