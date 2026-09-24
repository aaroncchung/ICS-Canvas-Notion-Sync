import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { pino } from "pino";
import { parseIcs } from "../../src/canvas/parse-ics.ts";
import {
  compileAssignmentTypeMatcher,
  extractCourseCode,
  sanitizeDescription,
} from "../../src/canvas/normalize-assignment.ts";
import { CanvasIcsProvider } from "../../src/canvas/provider.ts";
import { assignmentTypeMatcher, config } from "../helpers.ts";

const fixture = (name: string) =>
  readFile(new URL(`../../fixtures/synthetic/${name}`, import.meta.url), "utf8");

function calendar(events: string): string {
  return `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Test//EN\n${events}\nEND:VCALENDAR`;
}

function event(values: string): string {
  return `BEGIN:VEVENT\n${values}\nEND:VEVENT`;
}

describe("RFC 5545 Canvas parsing", () => {
  it("matches assignment types with literal, Unicode-aware, ordered rules", () => {
    const configured = [
      { type: "Quiz" as const, patterns: ["test", "problem   set"] },
      { type: "Exam" as const, patterns: ["test"] },
      { type: "Project" as const, patterns: ["C++", "[draft]"] },
      { type: "Paper" as const, patterns: ["épreuve"] },
    ];
    const matcher = compileAssignmentTypeMatcher(configured);
    const cases = [
      ["Final test", "Quiz"],
      ["Problem      set 2", "Quiz"],
      ["problem\tset 3", "Quiz"],
      ["C++ review", "Project"],
      ["Submit [draft]", "Project"],
      ["ÉPREUVE finale", "Paper"],
      ["préépreuve finale", "Other"],
      ["Contest results", "Other"],
    ] as const;
    for (const [title, expected] of cases) {
      expect(matcher(title)).toBe(expected);
    }
  });

  it("returns an AssignmentFeed directly without mutable provider state", async () => {
    const source = calendar(
      event(
        "UID:event-assignment-77@canvas\nDTSTART:20260701T120000Z\nSUMMARY:Quiz 2 [EE 10]\nURL:https://x.test/courses/1/assignments/77",
      ),
    );
    const provider = new CanvasIcsProvider(config(), pino({ level: "silent" }), () =>
      Promise.resolve(new Response(source, { status: 200 })),
    );
    const feed = await provider.fetchAssignments();
    expect(feed.assignments).toHaveLength(1);
    expect(feed.cancelledAssignments).toEqual([]);
    expect(feed.diagnostics.totalEvents).toBe(1);
    expect("lastFeed" in provider).toBe(false);
  });

  it("parses an empty feed safely", async () => {
    expect(parseIcs(await fixture("empty.ics"), assignmentTypeMatcher).assignments).toEqual([]);
  });

  it("imports a standard assignment with a timed UTC date", async () => {
    const parsed = parseIcs(await fixture("standard-assignment.ics"), assignmentTypeMatcher);
    expect(parsed.assignments[0]).toMatchObject({
      uid: "event-assignment-456@canvas.example.edu",
      title: "Homework 1",
      canvasCourseId: "123",
      canvasAssignmentId: "456",
      dueAt: "2026-07-15T23:59:00.000Z",
      inferredType: "Homework",
    });
  });

  it("recognizes quiz, lab, and exam types", async () => {
    const assignments = parseIcs(await fixture("complex.ics"), assignmentTypeMatcher).assignments;
    expect(assignments.map((item) => item.inferredType)).toEqual(["Quiz", "Lab", "Exam"]);
  });

  it("preserves all-day dates", async () => {
    expect(
      parseIcs(await fixture("complex.ics"), assignmentTypeMatcher).assignments[0]?.dueAt,
    ).toBe("2026-07-20");
  });

  it("parses timed, UTC, TZID, and daylight-transition dates", async () => {
    const assignments = parseIcs(await fixture("complex.ics"), assignmentTypeMatcher).assignments;
    expect(assignments[1]?.dueAt).toMatch(/^2026-11-01T0[89]:30:00\.000Z$/);
    expect(assignments[2]?.dueAt).toBe("2026-07-22T18:00:00.000Z");
  });

  it("unfolds lines and unescapes RFC text", async () => {
    const lab = parseIcs(await fixture("complex.ics"), assignmentTypeMatcher).assignments[1];
    expect(lab?.descriptionPlainText).toContain("escaped comma, semicolon; backslash");
    expect(lab?.descriptionPlainText).toContain("newline next");
  });

  it("sanitizes HTML descriptions", () => {
    const value = sanitizeDescription(
      '<p>Hello <strong>world</strong></p><script>alert("x")</script>',
    );
    expect(value.markdown).toContain("**world**");
    expect(value.markdown).not.toContain("script");
    expect(value.markdown).not.toContain("alert");
  });

  it("allows a missing description", async () => {
    expect(
      parseIcs(await fixture("complex.ics"), assignmentTypeMatcher).assignments[2]
        ?.descriptionPlainText,
    ).toBeUndefined();
  });

  it("accepts a missing URL only with assignment UID evidence", () => {
    const source = calendar(
      event("UID:event-assignment-77@canvas\nDTSTART:20260701T120000Z\nSUMMARY:Quiz 2 [EE 10]"),
    );
    expect(parseIcs(source, assignmentTypeMatcher).assignments).toHaveLength(1);
  });

  it("quarantines every event with a duplicate source UID", () => {
    const one = event(
      "UID:event-assignment-77@canvas\nDTSTART:20260701T120000Z\nSUMMARY:A\nURL:https://x.test/courses/1/assignments/77",
    );
    const parsed = parseIcs(calendar(`${one}\n${one}`), assignmentTypeMatcher);
    expect(parsed.assignments).toHaveLength(0);
    expect(parsed.diagnostics.sourceUids).toEqual(["event-assignment-77@canvas"]);
    expect(parsed.diagnostics.quarantinedUids).toEqual(["event-assignment-77@canvas"]);
    expect(parsed.diagnostics.events.filter((item) => item.kind === "duplicate")).toHaveLength(1);
  });

  it("excludes ordinary Canvas calendar events", async () => {
    const parsed = parseIcs(await fixture("calendar-event.ics"), assignmentTypeMatcher);
    expect(parsed.assignments).toEqual([]);
    expect(parsed.diagnostics.events.filter((item) => item.kind === "ignored")).toHaveLength(1);
    expect(parsed.diagnostics.events[0]?.reason).toBe("ordinary-calendar-event");
  });

  it("skips a malformed individual assignment", () => {
    const malformed = event(
      "UID:event-assignment-77@canvas\nDTSTART:20260701T120000Z\nURL:https://x.test/courses/1/assignments/77",
    );
    const valid = event(
      "UID:event-assignment-78@canvas\nDTSTART:20260701T120000Z\nSUMMARY:Valid\nURL:https://x.test/courses/1/assignments/78",
    );
    const parsed = parseIcs(calendar(`${malformed}\n${valid}`), assignmentTypeMatcher);
    expect(parsed.assignments).toHaveLength(1);
    expect(parsed.diagnostics.events.filter((item) => item.kind === "malformed")).toHaveLength(1);
    expect(parsed.diagnostics.quarantinedUids).toContain("event-assignment-77@canvas");
  });

  it("quarantines suspicious assignment-like events", () => {
    const suspicious = event(
      "UID:changed-format-77@canvas\nDTSTART:20260701T120000Z\nSUMMARY:Quiz 2 [EE 10]\nCATEGORIES:Assignment",
    );
    const parsed = parseIcs(calendar(suspicious), assignmentTypeMatcher);
    expect(parsed.assignments).toHaveLength(0);
    expect(parsed.diagnostics.events[0]).toMatchObject({
      kind: "suspicious",
      reason: "assignment-like-event",
      uid: "changed-format-77@canvas",
    });
  });

  it("normalizes cancelled assignments separately from active assignments", () => {
    const cancelled = event(
      "UID:event-assignment-77@canvas\nDTSTART:20260701T120000Z\nSUMMARY:Quiz 2 [EE 10]\nURL:https://x.test/courses/1/assignments/77\nSTATUS:CANCELLED",
    );
    const parsed = parseIcs(calendar(cancelled), assignmentTypeMatcher);
    expect(parsed.assignments).toHaveLength(0);
    expect(parsed.cancelledAssignments).toHaveLength(1);
    expect(parsed.diagnostics.events[0]).toMatchObject({
      kind: "cancelled",
      uid: "event-assignment-77@canvas",
    });
  });

  it("rejects a malformed complete calendar", () => {
    expect(() => parseIcs("BEGIN:VCALENDAR\nVERSION:2.0", assignmentTypeMatcher)).toThrow(
      "complete VCALENDAR",
    );
  });

  it("keeps an all-day due date on its calendar day in every process timezone", () => {
    const original = process.env.TZ;
    const allDay = calendar(
      event(
        [
          "UID:event-assignment-771@canvas.example.edu",
          "DTSTART;VALUE=DATE:20260310",
          "SUMMARY:All-day reading [EE 10]",
          "URL:https://canvas.example.edu/courses/123/assignments/771",
        ].join("\n"),
      ),
    );
    try {
      // node-ical builds VALUE=DATE starts at local midnight, so a process east of UTC used to
      // report the previous calendar day.
      for (const timeZone of ["UTC", "America/Los_Angeles", "Europe/Berlin", "Asia/Tokyo"]) {
        process.env.TZ = timeZone;
        const parsed = parseIcs(allDay, assignmentTypeMatcher);
        expect(parsed.assignments[0]?.dueAt, `timezone ${timeZone}`).toBe("2026-03-10");
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});

describe("course-code extraction", () => {
  it("extracts uppercase department codes in their common spellings", () => {
    const cases: Array<[string, string]> = [
      ["EE 10", "EE 10"],
      ["CS-61A", "CS-61A"],
      ["BIO101", "BIO101"],
      ["MATH 2B", "MATH 2B"],
      ["COMPSCI 161", "COMPSCI 161"],
      ["Intro to Circuits (EE 10)", "EE 10"],
      ["CS 101 (37000)", "CS 101"],
      ["Fall 2026 - ICS 31 Lecture A", "ICS 31"],
      // The real feed prefixes every label with a mixed-case term tag, which the legacy
      // case-insensitive pattern returned as the code for every course.
      ["Fa26 PHY-0013 Physics", "PHY-0013"],
      ["Fa26 EN-0001 English", "EN-0001"],
    ];
    for (const [label, expected] of cases) {
      expect(extractCourseCode(label), label).toBe(expected);
    }
  });

  it("never treats ordinary words followed by a number as a course code", () => {
    const labels = [
      "Fall 2026 Biology",
      "Biology 101",
      "English 101",
      "Section 3 Chemistry",
      "Chapter 12 review",
      "Room 101",
      "FALL 2026",
      "WEEK 2",
      "HW 3",
      "FA26",
      "ID 12345",
      "Intro to EE",
      "ICS31LECA",
    ];
    for (const label of labels) {
      expect(extractCourseCode(label), label).toBeUndefined();
    }
  });

  it("skips term and structural words to reach the real code", () => {
    expect(extractCourseCode("FA26 CS 101")).toBe("CS 101");
    expect(extractCourseCode("FA26-CS-101")).toBe("CS-101");
    expect(extractCourseCode("WEEK 2 PHYS 7C")).toBe("PHYS 7C");
    expect(extractCourseCode("CS 101 SECTION 3")).toBe("CS 101");
  });

  it("skips SIS term tags to reach the real code", () => {
    const cases: Array<[string, string]> = [
      ["SPR26 CS 101", "CS 101"],
      ["SUM2026 BIO 1", "BIO 1"],
      ["WIN26 MATH 2B", "MATH 2B"],
      ["AUT26 CS 106A", "CS 106A"],
      ["FAL 2026 CS 101", "CS 101"],
      ["SEM 1 CHEM 3", "CHEM 3"],
      ["QTR2 CS 101", "CS 101"],
      ["AY26 PHYS 7C", "PHYS 7C"],
      ["SY 2026 EE 10", "EE 10"],
      // Tags not in the list are recognized by shape when a code follows them.
      ["FS26 CS 101", "CS 101"],
      ["SPRG2026-CS-61A", "CS-61A"],
    ];
    for (const [label, expected] of cases) {
      expect(extractCourseCode(label), label).toBe(expected);
    }
  });

  it("keeps a code shaped like a term tag when no other code follows it", () => {
    expect(extractCourseCode("ENGL1010")).toBe("ENGL1010");
    expect(extractCourseCode("ENGL1010 Composition")).toBe("ENGL1010");
    expect(extractCourseCode("EE10 SECTION 2")).toBe("EE10");
    expect(extractCourseCode("SPR26 Biology")).toBeUndefined();
  });

  it("keeps the course label as the name whether or not it contains a code", () => {
    const parsed = parseIcs(
      calendar(
        [
          event(
            "UID:event-assignment-1@canvas\nDTSTART:20260701T120000Z\nSUMMARY:Essay 1 [Fall 2026 Biology]\nURL:https://x.test/courses/1/assignments/1",
          ),
          event(
            "UID:event-assignment-2@canvas\nDTSTART:20260701T120000Z\nSUMMARY:Lab 1 [FA26 CS 101]\nURL:https://x.test/courses/2/assignments/2",
          ),
        ].join("\n"),
      ),
      assignmentTypeMatcher,
    );
    expect(
      parsed.assignments.map((item) => [item.title, item.courseName, item.courseCode]),
    ).toEqual([
      ["Essay 1", "Fall 2026 Biology", undefined],
      ["Lab 1", "FA26 CS 101", "CS 101"],
    ]);
    expect("courseCode" in parsed.assignments[0]!).toBe(false);
  });
});
