import { describe, expect, it } from "vitest";
import { classifyEvent } from "../../src/canvas/classify-event.js";
import { buildCourseIndex, matchCourseFromIndex } from "../../src/sync/course-matcher.js";

const assignmentUrl = "https://canvas.example.edu/courses/42/assignments/99";

describe("Canvas event classification", () => {
  it("does not let a relative description route inherit an unrelated URL field", () => {
    expect(
      classifyEvent({
        url: "https://zoom.example.com/meeting/123",
        description: "Submit at /courses/42/assignments/99",
      }),
    ).toMatchObject({
      kind: "assignment",
      canvasCourseId: "42",
      canvasAssignmentId: "99",
    });
    expect(
      classifyEvent({
        url: "https://zoom.example.com/meeting/123",
        description: "Submit at /courses/42/assignments/99",
      }).canvasUrl,
    ).toBeUndefined();
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
    ["description", `Submit at ${assignmentUrl}`],
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
        description:
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
