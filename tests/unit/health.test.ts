import { describe, expect, it } from "vitest";
import { assessScheduledHealth } from "../../scripts/check-health.js";

const now = new Date("2026-07-13T12:00:00Z");
const run = (id: number, conclusion: string, createdAt: string) => ({
  id,
  html_url: `https://github.test/runs/${id}`,
  status: "completed",
  conclusion,
  created_at: createdAt,
});

describe("scheduled health assessment", () => {
  it("25 opens an alert after three consecutive scheduled failures", () => {
    const result = assessScheduledHealth(
      [1, 2, 3].map((id) => run(id, "failure", `2026-07-13T0${9 - id}:00:00Z`)),
      now,
    );
    expect(result.unhealthy).toBe(true);
    expect(result.reasons[0]).toContain("three");
  });

  it("26 alerts after twelve hours without a scheduled success", () => {
    const result = assessScheduledHealth([run(1, "success", "2026-07-12T20:00:00Z")], now);
    expect(result.unhealthy).toBe(true);
    expect(result.reasons.some((reason) => reason.includes("12 hours"))).toBe(true);
  });

  it("27 reports recovery after a recent scheduled success", () => {
    const result = assessScheduledHealth([run(1, "success", "2026-07-13T11:00:00Z")], now);
    expect(result.unhealthy).toBe(false);
  });
});
