import { describe, expect, it } from "vitest";
import {
  DESCRIPTION_INTEGRITY_MAXIMUM_AGE_DAYS,
  DESCRIPTION_INTEGRITY_MINIMUM_AGE_DAYS,
  descriptionIntegrityAuditDecision,
  descriptionIntegrityAuditSlot,
} from "../../src/notion/descriptions.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function addUtcDays(value: string, days: number): Date {
  return new Date(Date.parse(value) + days * DAY_MS);
}

function scheduledDate(stableIdentifier: string, verifiedAt: string): { date: Date; age: number } {
  for (
    let age = DESCRIPTION_INTEGRITY_MINIMUM_AGE_DAYS;
    age < DESCRIPTION_INTEGRITY_MAXIMUM_AGE_DAYS;
    age += 1
  ) {
    const date = addUtcDays(verifiedAt, age);
    if (
      descriptionIntegrityAuditDecision(stableIdentifier, verifiedAt, "UTC", date).reason ===
      "scheduled-slot"
    ) {
      return { date, age };
    }
  }
  throw new Error(`No scheduled audit date found for ${stableIdentifier}`);
}

describe("description integrity audit scheduling", () => {
  it("distributes different stable identifiers across different slots", () => {
    const slots = new Set(
      Array.from({ length: 60 }, (_, index) => descriptionIntegrityAuditSlot(`uid-${index}`)),
    );
    expect(slots.size).toBeGreaterThan(20);
  });

  it("returns a stable slot and decision for repeated inputs", () => {
    const first = descriptionIntegrityAuditDecision(
      "uid-repeatable",
      "2028-01-01T12:00:00.000Z",
      "UTC",
      new Date("2028-02-10T12:00:00.000Z"),
    );
    const second = descriptionIntegrityAuditDecision(
      "uid-repeatable",
      "2028-01-01T12:00:00.000Z",
      "UTC",
      new Date("2028-02-10T12:00:00.000Z"),
    );
    expect(second).toEqual(first);
  });

  it.each([
    [undefined, "missing-verification"],
    ["not-a-timestamp", "invalid-verification"],
  ] as const)("audits %s verification timestamps immediately", (verifiedAt, reason) => {
    expect(
      descriptionIntegrityAuditDecision(
        "uid-immediate",
        verifiedAt,
        "America/Los_Angeles",
        new Date("2028-02-01T12:00:00.000Z"),
      ),
    ).toMatchObject({ due: true, reason });
  });

  it("rejects a future timestamp later on the same local calendar date", () => {
    expect(
      descriptionIntegrityAuditDecision(
        "uid-same-day-future",
        "2028-02-01T18:00:00.000Z",
        "America/Los_Angeles",
        new Date("2028-02-01T12:00:00.000Z"),
      ),
    ).toMatchObject({ due: true, reason: "invalid-verification" });
  });

  it("rejects a future timestamp across a local calendar boundary", () => {
    expect(
      descriptionIntegrityAuditDecision(
        "uid-boundary-future",
        "2028-02-01T08:30:00.000Z",
        "America/Los_Angeles",
        new Date("2028-02-01T07:30:00.000Z"),
      ),
    ).toMatchObject({ due: true, reason: "invalid-verification" });
  });

  it("does not treat a timestamp exactly equal to now as future", () => {
    const now = new Date("2028-02-01T12:00:00.000Z");
    expect(
      descriptionIntegrityAuditDecision("uid-equal", now.toISOString(), "America/Los_Angeles", now),
    ).toMatchObject({ due: false, reason: "not-eligible", ageDays: 0 });
  });

  it("rejects a clearly future timestamp", () => {
    expect(
      descriptionIntegrityAuditDecision(
        "uid-future",
        "2029-01-01T00:00:00.000Z",
        "America/Los_Angeles",
        new Date("2028-02-01T12:00:00.000Z"),
      ),
    ).toMatchObject({ due: true, reason: "invalid-verification" });
  });

  it("marks a fresh timestamp as not yet eligible", () => {
    expect(
      descriptionIntegrityAuditDecision(
        "uid-fresh",
        "2028-01-20T12:00:00.000Z",
        "UTC",
        new Date("2028-02-01T12:00:00.000Z"),
      ),
    ).toMatchObject({ due: false, reason: "not-eligible", ageDays: 12 });
  });

  it("defers an unchanged description outside its stable slot", () => {
    const verifiedAt = "2028-01-01T12:00:00.000Z";
    const scheduled = scheduledDate("uid-deferred", verifiedAt);
    const outsideAge =
      scheduled.age === DESCRIPTION_INTEGRITY_MINIMUM_AGE_DAYS ? 31 : scheduled.age - 1;
    expect(
      descriptionIntegrityAuditDecision(
        "uid-deferred",
        verifiedAt,
        "UTC",
        addUtcDays(verifiedAt, outsideAge),
      ),
    ).toMatchObject({ due: false, reason: "deferred" });
  });

  it("audits an unchanged description when its stable slot is reached", () => {
    const verifiedAt = "2028-01-01T12:00:00.000Z";
    const scheduled = scheduledDate("uid-scheduled", verifiedAt);
    expect(
      descriptionIntegrityAuditDecision("uid-scheduled", verifiedAt, "UTC", scheduled.date),
    ).toMatchObject({ due: true, reason: "scheduled-slot", ageDays: scheduled.age });
  });

  it("enforces the maximum age even outside the stable slot", () => {
    const verifiedAt = "2028-01-01T12:00:00.000Z";
    expect(
      descriptionIntegrityAuditDecision(
        "uid-maximum",
        verifiedAt,
        "UTC",
        addUtcDays(verifiedAt, DESCRIPTION_INTEGRITY_MAXIMUM_AGE_DAYS),
      ),
    ).toMatchObject({
      due: true,
      reason: "maximum-age",
      ageDays: DESCRIPTION_INTEGRITY_MAXIMUM_AGE_DAYS,
    });
  });

  it("handles month boundaries and leap years using calendar days", () => {
    const verifiedAt = "2028-01-31";
    const scheduled = scheduledDate("uid-leap-year", verifiedAt);
    expect(scheduled.date.toISOString().slice(0, 10)).toMatch(/^2028-03-(0[1-9]|[12]\d|30)$/);
    expect(
      descriptionIntegrityAuditDecision(
        "uid-leap-year",
        verifiedAt,
        "UTC",
        new Date("2028-03-31T12:00:00.000Z"),
      ),
    ).toMatchObject({ due: true, reason: "maximum-age", ageDays: 60 });
  });

  it("uses the configured timezone to select the calendar slot", () => {
    const verifiedAt = "2028-01-15T12:00:00.000Z";
    const now = new Date("2028-03-01T07:30:00.000Z");
    const stableIdentifier = Array.from(
      { length: 100 },
      (_, index) => `uid-timezone-${index}`,
    ).find(
      (identifier) =>
        descriptionIntegrityAuditDecision(identifier, verifiedAt, "America/Los_Angeles", now)
          .reason === "scheduled-slot",
    );
    expect(stableIdentifier).toBeDefined();
    expect(
      descriptionIntegrityAuditDecision(stableIdentifier!, verifiedAt, "America/Los_Angeles", now)
        .reason,
    ).toBe("scheduled-slot");
    expect(
      descriptionIntegrityAuditDecision(stableIdentifier!, verifiedAt, "Asia/Tokyo", now).reason,
    ).toBe("deferred");
  });

  it("materially distributes a large cohort across the scheduling window", () => {
    const verifiedAt = "2028-01-01T12:00:00.000Z";
    const identifiers = Array.from({ length: 600 }, (_, index) => `cohort-uid-${index}`);
    const dailyCounts = Array.from({ length: 30 }, (_, index) => {
      const now = addUtcDays(verifiedAt, DESCRIPTION_INTEGRITY_MINIMUM_AGE_DAYS + index);
      return identifiers.filter(
        (identifier) =>
          descriptionIntegrityAuditDecision(identifier, verifiedAt, "UTC", now).reason ===
          "scheduled-slot",
      ).length;
    });
    expect(dailyCounts.reduce((total, count) => total + count, 0)).toBe(identifiers.length);
    expect(dailyCounts.every((count) => count > 0)).toBe(true);
    expect(Math.max(...dailyCounts)).toBeLessThan(60);
  });
});
