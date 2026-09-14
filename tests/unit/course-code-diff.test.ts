import { describe, expect, it } from "vitest";
import {
  compareCourseExtraction,
  legacyCourseCode,
  renderReport,
} from "../../scripts/course-code-diff.js";
import type { AssignmentRecord, CourseRecord, ExternalAssignment } from "../../src/types.js";
import { assignmentFeed } from "../helpers.js";

const now = new Date("2026-09-14T12:00:00Z");

function source(uid: string, courseName: string): ExternalAssignment {
  return { uid, title: uid, courseName, inferredType: "Other" };
}

function record(uid: string, coursePageIds: string[]): AssignmentRecord {
  return { uid, pageId: `page-${uid}`, title: uid, coursePageIds, removed: false };
}

function compare(
  assignments: ExternalAssignment[],
  courses: CourseRecord[],
  existingAssignments: AssignmentRecord[] = [],
) {
  const feed = assignmentFeed({
    assignments,
    diagnostics: {
      totalEvents: assignments.length,
      sourceUids: assignments.map((item) => item.uid),
      normalizedAssignmentUids: assignments.map((item) => item.uid),
      quarantinedUids: [],
      events: [],
      complete: true,
    },
  });
  return compareCourseExtraction({
    feed,
    existingAssignments,
    courses,
    aliases: {},
    notionTimezone: "America/Los_Angeles",
    now,
  });
}

describe("course-code extraction comparison", () => {
  it("reproduces the legacy case-insensitive first-match behavior", () => {
    expect(legacyCourseCode("Fall 2026 Biology")).toBe("Fall 2026");
    expect(legacyCourseCode("FA26 CS 101")).toBe("FA26");
    expect(legacyCourseCode("EE 10")).toBe("EE 10");
    expect(legacyCourseCode(undefined)).toBeUndefined();
  });

  it("reports code-only differences when the course destination is unchanged", () => {
    const biology: CourseRecord = { pageId: "bio", title: "Fall 2026 Biology" };
    const diff = compare(
      [source("one", "Fall 2026 Biology"), source("two", "EE 10")],
      [biology, { pageId: "ee", title: "EE 10", courseCode: "EE 10" }],
      [record("one", ["bio"]), record("two", ["ee"])],
    );
    expect(diff.assignments.map((item) => [item.before.code, item.after.code])).toEqual([
      ["Fall 2026", undefined],
      ["EE 10", "EE 10"],
    ]);
    expect(diff.assignments.map((item) => item.destinationChanged)).toEqual([false, false]);
    expect(diff.assignments[0]?.after.destination).toMatchObject({
      kind: "matched",
      method: "exact-title",
    });
    expect(diff.summary).toEqual({
      assignments: 2,
      codeChanges: 1,
      destinationChanges: 0,
      planDestinationChanges: 0,
      planCodeChanges: 0,
    });
    expect(diff.plan.every((field) => !field.changed)).toBe(true);
    expect(renderReport(diff)).toContain("Verdict: No course destination changes.");
  });

  it("flags a destination change when only the legacy code linked the course", () => {
    // The Notion course was renamed, so only its stored (legacy) code still matches the label.
    const renamed: CourseRecord = { pageId: "bio", title: "Biology", courseCode: "Fall 2026" };
    const diff = compare([source("one", "Fall 2026 Biology")], [renamed]);
    expect(diff.assignments[0]).toMatchObject({
      before: { code: "Fall 2026", destination: { kind: "matched", method: "exact-code" } },
      after: { destination: { kind: "create" } },
      codeChanged: true,
      destinationChanged: true,
    });
    expect(diff.summary.destinationChanges).toBe(1);
    expect(diff.summary.planDestinationChanges).toBeGreaterThan(0);
    expect(diff.plan.find((field) => field.field === "Courses to create (keys)")?.changed).toBe(
      true,
    );
    expect(renderReport(diff)).toContain("Course destination changes found");
  });

  it("separates planned course-code differences from destination differences", () => {
    const diff = compare([source("one", "FA26 CS 101")], []);
    expect(diff.assignments[0]).toMatchObject({
      before: { code: "FA26", destination: { kind: "create" } },
      after: { code: "CS 101", destination: { kind: "create" } },
      codeChanged: true,
      destinationChanged: false,
    });
    expect(diff.summary).toMatchObject({
      destinationChanges: 0,
      planDestinationChanges: 0,
      planCodeChanges: 1,
    });
    const report = renderReport(diff);
    expect(report).toContain("| Courses to create (codes) |");
    expect(report).not.toContain("FA26 CS 101");
    expect(report).not.toContain("page-");
  });
});
