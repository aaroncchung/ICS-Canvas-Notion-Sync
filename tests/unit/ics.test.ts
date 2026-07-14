import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { pino } from "pino";
import { parseIcs } from "../../src/canvas/parse-ics.js";
import {
  compileAssignmentTypeMatcher,
  inferAssignmentType,
  sanitizeDescription,
} from "../../src/canvas/normalize-assignment.js";
import { CanvasIcsProvider } from "../../src/canvas/provider.js";
import { config, rules } from "../helpers.js";

const fixture = (name: string) =>
  readFile(new URL(`../../fixtures/synthetic/${name}`, import.meta.url), "utf8");

function calendar(events: string): string {
  return `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Test//EN\n${events}\nEND:VCALENDAR`;
}

function event(values: string): string {
  return `BEGIN:VEVENT\n${values}\nEND:VEVENT`;
}

describe("RFC 5545 Canvas parsing", () => {
  it("preserves assignment-type matching semantics with one compiled matcher", () => {
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
      expect(matcher(title)).toBe(inferAssignmentType(title, configured));
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

  it("19 quarantines every event with a duplicate source UID", () => {
    const one = event(
      "UID:event-assignment-77@canvas\nDTSTART:20260701T120000Z\nSUMMARY:A\nURL:https://x.test/courses/1/assignments/77",
    );
    const parsed = parseIcs(calendar(`${one}\n${one}`), rules);
    expect(parsed.assignments).toHaveLength(0);
    expect(parsed.diagnostics.sourceUids).toEqual(["event-assignment-77@canvas"]);
    expect(parsed.diagnostics.quarantinedUids).toEqual(["event-assignment-77@canvas"]);
    expect(parsed.diagnostics.events.filter((item) => item.kind === "duplicate")).toHaveLength(1);
  });

  it("21 excludes ordinary Canvas calendar events", async () => {
    const parsed = parseIcs(await fixture("calendar-event.ics"), rules);
    expect(parsed.assignments).toEqual([]);
    expect(parsed.diagnostics.events.filter((item) => item.kind === "ignored")).toHaveLength(1);
    expect(parsed.diagnostics.events[0]?.reason).toBe("ordinary-calendar-event");
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
    expect(parsed.diagnostics.events.filter((item) => item.kind === "malformed")).toHaveLength(1);
    expect(parsed.diagnostics.quarantinedUids).toContain("event-assignment-77@canvas");
  });

  it("quarantines suspicious assignment-like events", () => {
    const suspicious = event(
      "UID:changed-format-77@canvas\nDTSTART:20260701T120000Z\nSUMMARY:Quiz 2 [EE 10]\nCATEGORIES:Assignment",
    );
    const parsed = parseIcs(calendar(suspicious), rules);
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
    const parsed = parseIcs(calendar(cancelled), rules);
    expect(parsed.assignments).toHaveLength(0);
    expect(parsed.cancelledAssignments).toHaveLength(1);
    expect(parsed.diagnostics.events[0]).toMatchObject({
      kind: "cancelled",
      uid: "event-assignment-77@canvas",
    });
  });

  it("23 rejects a malformed complete calendar", () => {
    expect(() => parseIcs("BEGIN:VCALENDAR\nVERSION:2.0", rules)).toThrow("complete VCALENDAR");
  });
});
