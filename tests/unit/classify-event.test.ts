import { describe, expect, it } from "vitest";
import { classifyEvent } from "../../src/canvas/classify-event.ts";
import { buildCourseIndex, matchCourseFromIndex } from "../../src/sync/course-matcher.ts";

const assignmentUrl = "https://canvas.example.edu/courses/42/assignments/99";

describe("Canvas event classification", () => {
  it.each([
    ["relative", "Submit at /courses/42/assignments/99"],
    ["absolute", `Submit at ${assignmentUrl}`],
  ])("never takes identity from a %s description route", (_kind, description) => {
    expect(classifyEvent({ url: "https://zoom.example.com/meeting/123", description })).toEqual({
      kind: "suspicious",
      evidence: ["assignment-like-route"],
    });
  });

  it("does not let a description link turn a calendar event into an assignment (#47)", () => {
    expect(
      classifyEvent({
        uid: "event-calendar-event-55",
        description: `Review for ${assignmentUrl} and /courses/42/assignments/soon`,
      }),
    ).toEqual({ kind: "ordinary", evidence: ["canvas-calendar-event-uid"] });
  });

  it("keeps the UID's identity when the description links another assignment (#47)", () => {
    expect(
      classifyEvent({
        uid: "event-assignment-456",
        description: "See https://canvas.example.edu/courses/999/assignments/100",
      }),
    ).toEqual({
      kind: "assignment",
      evidence: ["canvas-assignment-uid"],
      canvasAssignmentId: "456",
    });
  });

  it("reads course and assignment IDs from a Canvas calendar link", () => {
    expect(
      classifyEvent({
        uid: "event-assignment-456",
        url: "https://canvas.example.edu/calendar?include_contexts=course_123&month=07&year=2026#assignment_456",
      }),
    ).toEqual({
      kind: "assignment",
      evidence: ["canvas-calendar-link", "canvas-assignment-uid"],
      canvasUrl: "https://canvas.example.edu/courses/123/assignments/456",
      canvasCourseId: "123",
      canvasAssignmentId: "456",
    });
  });

  it("names no course when a calendar link has no single course context", () => {
    for (const contexts of ["", "include_contexts=course_1,course_2", "include_contexts=user_7"]) {
      const result = classifyEvent({
        uid: "event-assignment-456",
        url: `https://canvas.example.edu/calendar?${contexts}#assignment_456`,
      });
      expect(result, contexts).toEqual({
        kind: "assignment",
        evidence: ["canvas-calendar-link", "canvas-assignment-uid"],
        canvasAssignmentId: "456",
      });
    }
  });

  it("treats a calendar event whose link agrees with its UID as ordinary", () => {
    expect(
      classifyEvent({
        uid: "event-calendar-event-55",
        url: "https://canvas.example.edu/calendar?include_contexts=course_123#calendar_event_55",
      }),
    ).toEqual({
      kind: "ordinary",
      evidence: ["canvas-calendar-link", "canvas-calendar-event-uid"],
    });
  });

  it.each([
    [
      "another assignment",
      "event-assignment-456",
      "calendar?include_contexts=course_1#assignment_457",
    ],
    [
      "a calendar event",
      "event-assignment-456",
      "calendar?include_contexts=course_1#calendar_event_456",
    ],
    [
      "an assignment",
      "event-calendar-event-55",
      "calendar?include_contexts=course_1#assignment_55",
    ],
    ["another assignment's page", "event-assignment-456", "courses/1/assignments/457"],
  ])("quarantines a UID whose link names %s", (_target, uid, path) => {
    expect(classifyEvent({ uid, url: `https://canvas.example.edu/${path}` })).toMatchObject({
      kind: "mismatch",
      evidence: expect.arrayContaining(["canvas-identity-mismatch"]) as string[],
    });
  });

  it("quarantines a UID whose relative location route names another assignment", () => {
    expect(
      classifyEvent({ uid: "event-assignment-456", location: "/courses/1/assignments/457" }).kind,
    ).toBe("mismatch");
  });

  it("quarantines a calendar assignment link that no UID confirms", () => {
    expect(
      classifyEvent({
        uid: "abc-123@canvas.example.edu",
        url: "https://canvas.example.edu/calendar?include_contexts=course_1#assignment_456",
      }),
    ).toEqual({ kind: "suspicious", evidence: ["canvas-calendar-link"] });
  });

  it("extracts identity but no URL from a relative location route without a verified base", () => {
    expect(classifyEvent({ location: "/courses/42/assignments/99" })).toEqual({
      kind: "assignment",
      evidence: ["canvas-assignment-route"],
      canvasCourseId: "42",
      canvasAssignmentId: "99",
    });
  });

  it.each([
    ["url", assignmentUrl],
    ["location", `Open ${assignmentUrl}`],
  ] as const)("persists an absolute assignment URL found in %s", (field, value) => {
    const result = classifyEvent({ [field]: value });
    expect(result).toMatchObject({
      kind: "assignment",
      canvasUrl: assignmentUrl,
      canvasCourseId: "42",
      canvasAssignmentId: "99",
    });
  });

  it("normalizes HTML-escaped query parameters and trailing punctuation", () => {
    expect(
      classifyEvent({
        location:
          "Submit at https://canvas.example.edu/courses/42/assignments/99?module=1&amp;item=2).",
      }).canvasUrl,
    ).toBe("https://canvas.example.edu/courses/42/assignments/99?module=1&item=2");
  });

  it("resolves a relative route only from a matching Canvas-style course URL", () => {
    expect(
      classifyEvent({
        url: "https://canvas.example.edu/courses/42",
        location: "/courses/42/assignments/99",
      }).canvasUrl,
    ).toBe(assignmentUrl);
  });

  it("never derives a course URL from an unrelated host", () => {
    const classification = classifyEvent({
      url: "https://meet.example.com/rooms/42",
      location: "/courses/42/assignments/99",
    });
    expect(classification.canvasUrl).toBeUndefined();
    const result = matchCourseFromIndex(
      {
        uid: "assignment-99",
        title: "Homework",
        courseName: "EE 42",
        ...(classification.canvasCourseId ? { canvasCourseId: classification.canvasCourseId } : {}),
        ...(classification.canvasAssignmentId
          ? { canvasAssignmentId: classification.canvasAssignmentId }
          : {}),
        inferredType: "Homework",
      },
      buildCourseIndex([{ pageId: "course-page", title: "EE 42", canvasCourseId: "42" }], {}),
      "2026-07-14T00:00:00.000Z",
    );
    expect(result).toMatchObject({ kind: "matched" });
    if (result.kind === "matched") expect(result.update?.canvasUrl).toBeUndefined();
  });

  it("keeps incomplete assignment-like routes suspicious", () => {
    expect(classifyEvent({ description: "See /courses/42/assignments/soon" })).toEqual({
      kind: "suspicious",
      evidence: ["assignment-like-route"],
    });
  });
});
