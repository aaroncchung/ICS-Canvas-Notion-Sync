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

describe("Canvas feed shapes and malformed events", () => {
  const assignmentUrl = "https://canvas.example.edu/courses/123/assignments/456";

  it("reads the real Canvas feed shape: parameterized values and calendar links", async () => {
    const parsed = parseIcs(await fixture("canvas-feed-shape.ics"), assignmentTypeMatcher);
    expect(parsed.assignments).toEqual([
      expect.objectContaining({
        uid: "event-assignment-456",
        title: "Homework 1",
        courseName: "Fa26 EE-0010 Circuits",
        courseCode: "EE-0010",
        canvasCourseId: "123",
        canvasAssignmentId: "456",
        canvasUrl: assignmentUrl,
        descriptionPlainText: "Read chapter 1 and solve problems.",
      }),
    ]);
    expect(parsed.diagnostics.events).toEqual([
      {
        kind: "ignored",
        reason: "ordinary-calendar-event",
        uid: "event-calendar-event-789",
        indicators: ["canvas-calendar-link", "canvas-calendar-event-uid"],
      },
    ]);
    expect(parsed.diagnostics.quarantinedUids).toEqual([]);
  });

  // The three reproductions in #45.
  it("imports a non-Canvas UID whose parameterized URL is an assignment route", () => {
    const parsed = parseIcs(
      calendar(
        event(
          `UID:abc-123@canvas.example.edu\nDTSTART:20260701T120000Z\nSUMMARY:Homework 2 [EE 10]\nURL;VALUE=URI:${assignmentUrl}`,
        ),
      ),
      assignmentTypeMatcher,
    );
    expect(parsed.assignments[0]).toMatchObject({
      uid: "abc-123@canvas.example.edu",
      canvasCourseId: "123",
      canvasAssignmentId: "456",
      canvasUrl: assignmentUrl,
    });
  });

  it("keeps the course and URL of a Canvas UID with a parameterized URL", () => {
    const parsed = parseIcs(
      calendar(
        event(
          `UID:event-assignment-456\nDTSTART:20260701T120000Z\nSUMMARY:Homework 2 [EE 10]\nURL;VALUE=URI:${assignmentUrl}`,
        ),
      ),
      assignmentTypeMatcher,
    );
    expect(parsed.assignments[0]).toMatchObject({
      canvasCourseId: "123",
      canvasUrl: assignmentUrl,
    });
  });

  it("reads parameterized SUMMARY, DESCRIPTION, and LOCATION values", () => {
    const parsed = parseIcs(
      calendar(
        event(
          [
            "UID:event-assignment-456",
            "DTSTART:20260701T120000Z",
            "SUMMARY;LANGUAGE=en-US:Homework 2 [EE 10]",
            "DESCRIPTION;LANGUAGE=en-US:Show your work.",
            `LOCATION;LANGUAGE=en-US:${assignmentUrl}`,
          ].join("\n"),
        ),
      ),
      assignmentTypeMatcher,
    );
    expect(parsed.assignments[0]).toMatchObject({
      title: "Homework 2",
      courseCode: "EE 10",
      descriptionPlainText: "Show your work.",
      canvasUrl: assignmentUrl,
    });
  });

  it("keeps events whose parameterized UIDs node-ical would index together", () => {
    const parsed = parseIcs(
      calendar(
        [
          event("UID;X-A=1:event-assignment-1\nDTSTART:20260701T120000Z\nSUMMARY:One [EE 10]"),
          event("UID;X-A=1:event-assignment-2\nDTSTART:20260701T120000Z\nSUMMARY:Two [EE 10]"),
        ].join("\n"),
      ),
      assignmentTypeMatcher,
    );
    expect(parsed.assignments.map((item) => item.uid)).toEqual([
      "event-assignment-1",
      "event-assignment-2",
    ]);
  });

  it("quarantines a mismatched UID and link with a distinct reason", () => {
    const parsed = parseIcs(
      calendar(
        event(
          "UID:event-assignment-456\nDTSTART:20260701T120000Z\nSUMMARY:Homework [EE 10]\nURL;VALUE=URI:https://canvas.example.edu/calendar?include_contexts=course_1#assignment_457",
        ),
      ),
      assignmentTypeMatcher,
    );
    expect(parsed.assignments).toEqual([]);
    expect(parsed.diagnostics.quarantinedUids).toEqual(["event-assignment-456"]);
    expect(parsed.diagnostics.events[0]).toMatchObject({
      kind: "suspicious",
      reason: "canvas-identity-mismatch",
    });
  });

  it.each([
    ["trailing whitespace", "abc-77@canvas", "abc-77@canvas "],
    ["ICS escaping", "abc,77@canvas", "abc\\,77@canvas"],
    ["a folded line", "abc-77@canvas", "abc-77@\n canvas"],
  ])("quarantines duplicate UIDs that differ only by %s (#56)", (_difference, first, second) => {
    const copy = (uid: string, summary: string) =>
      event(
        `UID:${uid}\nDTSTART:20260701T120000Z\nSUMMARY:${summary} [EE 10]\nURL:https://x.test/courses/1/assignments/77`,
      );
    const parsed = parseIcs(
      calendar(`${copy(first, "Copy A")}\n${copy(second, "Copy B")}`),
      assignmentTypeMatcher,
    );
    expect(parsed.assignments).toEqual([]);
    expect(parsed.diagnostics.sourceUids).toEqual([first]);
    expect(parsed.diagnostics.quarantinedUids).toEqual([first]);
    expect(parsed.diagnostics.events).toEqual([
      expect.objectContaining({ kind: "duplicate", uid: first }),
    ]);
  });

  it.each([
    [
      "a duplicate DTSTART",
      "UID:event-assignment-3\nDTSTART:20260701T120000Z\nDTSTART:20260702T120000Z",
      "event-assignment-3",
    ],
    ["a UID equal to a calendar property name", "UID:prodid\nDTSTART:20260701T120000Z", "prodid"],
  ])("quarantines one event with %s instead of failing the feed (#56)", (_problem, lines, uid) => {
    const parsed = parseIcs(
      calendar(
        [
          event(`${lines}\nSUMMARY:Broken [EE 10]`),
          event(
            "UID:event-assignment-4\nDTSTART:20260701T120000Z\nSUMMARY:Valid [EE 10]\nURL:https://x.test/courses/1/assignments/4",
          ),
        ].join("\n"),
      ),
      assignmentTypeMatcher,
    );
    expect(parsed.assignments.map((item) => item.uid)).toEqual(["event-assignment-4"]);
    expect(parsed.diagnostics.totalEvents).toBe(2);
    expect(parsed.diagnostics.sourceUids).toEqual([uid, "event-assignment-4"]);
    expect(parsed.diagnostics.quarantinedUids).toEqual([uid]);
    expect(parsed.diagnostics.events).toEqual([
      { kind: "malformed", reason: "unparseable-event", uid, indicators: [] },
    ]);
  });

  it.each([
    [
      "URL",
      "URL:https://x.test/courses/1/assignments/5\nURL:https://x.test/courses/1/assignments/6",
    ],
    ["UID", "UID:event-assignment-6"],
  ])("quarantines an event that repeats %s", (_property, extra) => {
    const parsed = parseIcs(
      calendar(
        event(`UID:event-assignment-5\nDTSTART:20260701T120000Z\nSUMMARY:Twice [EE 10]\n${extra}`),
      ),
      assignmentTypeMatcher,
    );
    expect(parsed.assignments).toEqual([]);
    expect(parsed.diagnostics.events).toEqual([
      {
        kind: "malformed",
        reason: "unparseable-event",
        uid: "event-assignment-5",
        indicators: ["repeated-property"],
      },
    ]);
  });

  it("does not take a nested alarm's UID for a repeated event UID", () => {
    const parsed = parseIcs(
      calendar(
        event(
          [
            "UID:event-assignment-5",
            "DTSTART:20260701T120000Z",
            "SUMMARY:Alarmed [EE 10]",
            "BEGIN:VALARM",
            "UID:alarm-1",
            "ACTION:DISPLAY",
            "TRIGGER:-PT15M",
            "END:VALARM",
          ].join("\n"),
        ),
      ),
      assignmentTypeMatcher,
    );
    expect(parsed.assignments.map((item) => item.uid)).toEqual(["event-assignment-5"]);
  });

  it("still fails the feed for calendar-level damage", () => {
    const unterminated = calendar(
      "BEGIN:VEVENT\nUID:event-assignment-1\nDTSTART:20260701T120000Z\nSUMMARY:Open",
    );
    expect(() => parseIcs(unterminated, assignmentTypeMatcher)).toThrow("could not be parsed");
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
