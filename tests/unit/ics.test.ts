import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseIcs } from "../../src/canvas/parse-ics.js";
import { sanitizeDescription } from "../../src/canvas/normalize-assignment.js";
import { rules } from "../helpers.js";

const fixture = (name: string) =>
  readFile(new URL(`../../fixtures/synthetic/${name}`, import.meta.url), "utf8");

function calendar(events: string): string {
  return `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Test//EN\n${events}\nEND:VCALENDAR`;
}

function event(values: string): string {
  return `BEGIN:VEVENT\n${values}\nEND:VEVENT`;
}

describe("RFC 5545 Canvas parsing", () => {
  it("1 parses an empty feed safely", async () => {
    expect(parseIcs(await fixture("empty.ics"), rules).assignments).toEqual([]);
  });

  it("2 imports a standard assignment and timed UTC date", async () => {
    const parsed = parseIcs(await fixture("standard-assignment.ics"), rules);
    expect(parsed.assignments[0]).toMatchObject({
      uid: "event-assignment-456@canvas.example.edu",
      title: "Homework 1",
      canvasCourseId: "123",
      canvasAssignmentId: "456",
      dueAt: "2026-07-15T23:59:00.000Z",
      inferredType: "Homework",
    });
  });

  it("3-5 recognizes quiz, lab, and exam types", async () => {
    const assignments = parseIcs(await fixture("complex.ics"), rules).assignments;
    expect(assignments.map((item) => item.inferredType)).toEqual(["Quiz", "Lab", "Exam"]);
  });

  it("6 preserves all-day dates", async () => {
    expect(parseIcs(await fixture("complex.ics"), rules).assignments[0]?.dueAt).toBe("2026-07-20");
  });

  it("7-10 parses timed, UTC, TZID, and daylight-transition dates", async () => {
    const assignments = parseIcs(await fixture("complex.ics"), rules).assignments;
    expect(assignments[1]?.dueAt).toMatch(/^2026-11-01T0[89]:30:00\.000Z$/);
    expect(assignments[2]?.dueAt).toBe("2026-07-22T18:00:00.000Z");
  });

  it("11-12 unfolds lines and unescapes RFC text", async () => {
    const lab = parseIcs(await fixture("complex.ics"), rules).assignments[1];
    expect(lab?.descriptionPlainText).toContain("escaped comma, semicolon; backslash");
    expect(lab?.descriptionPlainText).toContain("newline next");
  });

  it("13 sanitizes HTML descriptions", () => {
    const value = sanitizeDescription(
      '<p>Hello <strong>world</strong></p><script>alert("x")</script>',
    );
    expect(value.markdown).toContain("**world**");
    expect(value.markdown).not.toContain("script");
    expect(value.markdown).not.toContain("alert");
  });

  it("14 allows a missing description", async () => {
    expect(
      parseIcs(await fixture("complex.ics"), rules).assignments[2]?.descriptionPlainText,
    ).toBeUndefined();
  });

  it("15 accepts a missing URL only with assignment UID evidence", () => {
    const source = calendar(
      event("UID:event-assignment-77@canvas\nDTSTART:20260701T120000Z\nSUMMARY:Quiz 2 [EE 10]"),
    );
    expect(parseIcs(source, rules).assignments).toHaveLength(1);
  });

  it("19 reports duplicate UIDs without importing twice", () => {
    const one = event(
      "UID:event-assignment-77@canvas\nDTSTART:20260701T120000Z\nSUMMARY:A\nURL:https://x.test/courses/1/assignments/77",
    );
    const parsed = parseIcs(calendar(`${one}\n${one}`), rules);
    expect(parsed.assignments).toHaveLength(1);
    expect(parsed.diagnostics.duplicateUids).toHaveLength(1);
  });

  it("21 excludes ordinary Canvas calendar events", async () => {
    const parsed = parseIcs(await fixture("calendar-event.ics"), rules);
    expect(parsed.assignments).toEqual([]);
    expect(parsed.diagnostics.skippedEvents[0]?.reason).toBe("insufficient-assignment-evidence");
  });

  it("22 skips a malformed individual assignment", () => {
    const malformed = event(
      "UID:event-assignment-77@canvas\nDTSTART:20260701T120000Z\nURL:https://x.test/courses/1/assignments/77",
    );
    const valid = event(
      "UID:event-assignment-78@canvas\nDTSTART:20260701T120000Z\nSUMMARY:Valid\nURL:https://x.test/courses/1/assignments/78",
    );
    const parsed = parseIcs(calendar(`${malformed}\n${valid}`), rules);
    expect(parsed.assignments).toHaveLength(1);
    expect(parsed.diagnostics.malformedEvents).toBe(1);
  });

  it("23 rejects a malformed complete calendar", () => {
    expect(() => parseIcs("BEGIN:VCALENDAR\nVERSION:2.0", rules)).toThrow("complete VCALENDAR");
  });
});
