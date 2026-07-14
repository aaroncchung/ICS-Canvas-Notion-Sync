import { describe, expect, it } from "vitest";
import { parseIcs } from "../../src/canvas/parse-ics.js";
import { createAssignment } from "../../src/notion/assignments.js";
import { buildPlan } from "../../src/sync/plan.js";
import type {
  AssignmentFeed,
  AssignmentRecord,
  CourseRecord,
  ExternalAssignment,
} from "../../src/types.js";
import { FakeGateway, rules } from "../helpers.js";

const course: CourseRecord = {
  pageId: "course-page",
  title: "EE 10",
  courseCode: "EE 10",
  canvasCourseId: "123",
};

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
      assignmentsParsed: assignments.length,
      sourceUids,
      normalizedAssignmentUids: [...assignments, ...cancelledAssignments].map(
        (assignment) => assignment.uid,
      ),
      quarantinedUids: [],
      events: [],
      ignoredEventCount: 0,
      complete: true,
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
) {
  return buildPlan(value, existing, courses, aliases, false, new Date("2026-07-13T12:00:00Z"));
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
    expect(result.assignmentsToRemove).toHaveLength(0);
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

  it("protects a raw assignment UID that could not be normalized", () => {
    const malformed = event(
      "UID:uid-1\nDTSTART:20260720T200000Z\nURL:https://canvas.example.edu/courses/123/assignments/456",
    );
    const other = event(
      "UID:uid-other\nDTSTART:20260801T200000Z\nSUMMARY:Different assignment [EE 10]\nURL:https://canvas.example.edu/courses/123/assignments/999",
    );
    const value = parseIcs(calendar(`${malformed}\n${other}`), rules);
    expect(planFeed(value).assignmentsToRemove).toHaveLength(0);
  });

  it("protects a duplicate source UID from removal", () => {
    const duplicate = event(
      "UID:uid-1\nDTSTART:20260720T200000Z\nSUMMARY:Homework 1 [EE 10]\nURL:https://canvas.example.edu/courses/123/assignments/456",
    );
    const value = parseIcs(calendar(`${duplicate}\n${duplicate}`), rules);
    expect(planFeed(value).assignmentsToRemove).toHaveLength(0);
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

  it("marks a cancelled existing assignment removed while retaining Notion-owned values", () => {
    const existing = record({ priority: "High", assignmentType: "Quiz" });
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
      personalStatus: "Done",
      priority: "High",
      assignmentType: "Quiz",
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
        ignoredEventCount: 1,
      },
    });
    expect(planFeed(value, []).warnings).toEqual([]);
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
          canvasAssignmentId: "999",
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
