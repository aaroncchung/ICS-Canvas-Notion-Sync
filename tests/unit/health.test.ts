import { describe, expect, it } from "vitest";
import {
  assessScheduledHealth,
  classifyConclusion,
  SCHEDULE_DELAY_GRACE_MINUTES,
} from "../../scripts/check-health.js";
import type {
  WorkflowActivationMetadata,
  WorkflowRun,
} from "../../scripts/github-health-client.js";

const now = new Date("2026-07-13T12:00:00Z");
const activation = (activatedAt: string): WorkflowActivationMetadata => ({
  activatedAt,
  state: "active",
  source: "workflow-updated-at",
});
const run = (overrides: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: 1,
  run_attempt: 1,
  name: "Canvas–Notion sync",
  path: ".github/workflows/sync.yml",
  event: "schedule",
  status: "completed",
  conclusion: "success",
  head_branch: "main",
  head_sha: "0123456789abcdef",
  created_at: "2026-07-13T11:00:00Z",
  run_started_at: "2026-07-13T11:01:00Z",
  updated_at: "2026-07-13T11:02:00Z",
  completed_at: "2026-07-13T11:02:00Z",
  html_url: "https://github.test/runs/1",
  ...overrides,
});

describe("scheduled health assessment", () => {
  it.each([
    ["success", "success"],
    ["failure", "unhealthy-completion"],
    ["timed_out", "unhealthy-completion"],
    ["action_required", "unhealthy-completion"],
    ["startup_failure", "unhealthy-completion"],
    ["cancelled", "unhealthy-completion"],
    ["neutral", "non-success-neutral"],
    ["skipped", "non-success-neutral"],
    ["stale", "non-success-neutral"],
  ])("classifies %s as %s", (conclusion, expected) => {
    expect(classifyConclusion(run({ conclusion }))).toBe(expected);
  });

  it("does not classify queued or in-progress runs as completed failures", () => {
    expect(classifyConclusion(run({ status: "queued", conclusion: null }))).toBe("not-completed");
    expect(classifyConclusion(run({ status: "in_progress", conclusion: null }))).toBe(
      "not-completed",
    );
  });

  it("sorts scheduled runs newest first using timestamps", () => {
    const result = assessScheduledHealth(
      [
        run({
          id: 1,
          updated_at: "2026-07-13T08:00:00Z",
          completed_at: "2026-07-13T08:00:00Z",
        }),
        run({
          id: 3,
          updated_at: "2026-07-13T10:00:00Z",
          completed_at: "2026-07-13T10:00:00Z",
        }),
        run({
          id: 2,
          updated_at: "2026-07-13T09:00:00Z",
          completed_at: "2026-07-13T09:00:00Z",
        }),
      ],
      activation("2026-07-12T00:00:00Z"),
      now,
    );
    expect(result.scheduledRuns.map((item) => item.id)).toEqual([3, 2, 1]);
  });

  it("ignores manual workflow runs completely", () => {
    const result = assessScheduledHealth(
      [
        run({ id: 1, event: "workflow_dispatch", conclusion: "success" }),
        run({ id: 2, event: "workflow_dispatch", conclusion: "failure" }),
        run({ id: 3, event: "workflow_dispatch", conclusion: "failure" }),
        run({ id: 4, event: "workflow_dispatch", conclusion: "failure" }),
      ],
      activation("2026-07-13T01:00:00Z"),
      now,
    );
    expect(result.scheduledRuns).toEqual([]);
    expect(result.unhealthy).toBe(false);
  });

  it("alerts after three consecutive qualifying failures", () => {
    const result = assessScheduledHealth(
      [
        run({ id: 1, conclusion: "failure", updated_at: "2026-07-13T11:00:00Z" }),
        run({ id: 2, conclusion: "cancelled", updated_at: "2026-07-13T10:00:00Z" }),
        run({ id: 3, conclusion: "timed_out", updated_at: "2026-07-13T09:00:00Z" }),
      ],
      activation("2026-07-13T01:00:00Z"),
      now,
    );
    expect(result.reasonCodes).toContain("three_consecutive_unhealthy");
  });

  it("does not count neutral, skipped, or stale toward or through the three-run threshold", () => {
    const result = assessScheduledHealth(
      [
        run({ id: 1, conclusion: "failure", updated_at: "2026-07-13T11:00:00Z" }),
        run({ id: 2, conclusion: "neutral", updated_at: "2026-07-13T10:00:00Z" }),
        run({ id: 3, conclusion: "failure", updated_at: "2026-07-13T09:00:00Z" }),
      ],
      activation("2026-07-13T01:00:00Z"),
      now,
    );
    expect(result.reasonCodes).not.toContain("three_consecutive_unhealthy");
  });

  it("does not alert with no runs inside activation grace", () => {
    expect(assessScheduledHealth([], activation("2026-07-13T01:00:00Z"), now).unhealthy).toBe(
      false,
    );
  });

  it("alerts with no runs after activation grace", () => {
    const result = assessScheduledHealth([], activation("2026-07-12T12:00:00Z"), now);
    expect(result.reasonCodes).toContain("no_success_after_activation_grace");
  });

  it("reports a disabled workflow immediately with its own reason", () => {
    const result = assessScheduledHealth(
      [],
      { ...activation("2026-07-13T11:59:00Z"), state: "disabled_manually" },
      now,
    );
    expect(result.reasonCodes).toEqual(["workflow_disabled"]);
  });

  it("allows a recent queued or in-progress scheduled run to defer an absence alert", () => {
    for (const status of ["queued", "in_progress"]) {
      const result = assessScheduledHealth(
        [run({ status, conclusion: null, created_at: "2026-07-13T11:30:00Z" })],
        activation("2026-07-12T12:00:00Z"),
        now,
      );
      expect(result.unhealthy).toBe(false);
      expect(result.deferredForActiveRun).toBe(true);
    }
  });

  it("accepts the first recent scheduled success", () => {
    expect(assessScheduledHealth([run()], activation("2026-07-12T12:00:00Z"), now).unhealthy).toBe(
      false,
    );
  });

  it("does not alert on the first failed run while activation grace remains", () => {
    expect(
      assessScheduledHealth(
        [run({ conclusion: "failure" })],
        activation("2026-07-13T01:00:00Z"),
        now,
      ).unhealthy,
    ).toBe(false);
  });

  it("alerts on the first failed run after activation grace because no success exists", () => {
    const result = assessScheduledHealth(
      [run({ conclusion: "failure" })],
      activation("2026-07-12T00:00:00Z"),
      now,
    );
    expect(result.reasonCodes).toContain("no_success_after_activation_grace");
  });

  it("a recent scheduled success suppresses the stale-success alert", () => {
    const result = assessScheduledHealth(
      [run({ completed_at: "2026-07-13T11:00:00Z" })],
      activation("2026-07-12T12:00:00Z"),
      now,
    );
    expect(result.reasonCodes).not.toContain("no_success_12h");
  });

  it("allows bounded scheduler delay, then alerts after twelve hours without success", () => {
    const withinTolerance = new Date(
      now.getTime() - (12 * 60 + SCHEDULE_DELAY_GRACE_MINUTES - 1) * 60 * 1000,
    ).toISOString();
    const beyondTolerance = new Date(
      now.getTime() - (12 * 60 + SCHEDULE_DELAY_GRACE_MINUTES + 1) * 60 * 1000,
    ).toISOString();
    expect(
      assessScheduledHealth(
        [run({ completed_at: withinTolerance, updated_at: withinTolerance })],
        activation("2026-07-12T00:00:00Z"),
        now,
      ).unhealthy,
    ).toBe(false);
    expect(
      assessScheduledHealth(
        [run({ completed_at: beyondTolerance, updated_at: beyondTolerance })],
        activation("2026-07-12T00:00:00Z"),
        now,
      ).reasonCodes,
    ).toContain("no_success_12h");
  });
});
