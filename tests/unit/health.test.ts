import { describe, expect, it } from "vitest";
import {
  assessScheduledHealth,
  mergeRuns,
  recoveredFromIncident,
  SUCCESS_WATCHDOG_HOURS,
  type Workflow,
  type WorkflowRun,
} from "../../scripts/check-health.ts";

const now = new Date("2026-07-13T12:00:00Z");
const workflow = (updated_at: string, state = "active"): Workflow => ({
  state,
  created_at: "2026-07-01T00:00:00Z",
  updated_at,
});
const run = (overrides: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: 1,
  run_attempt: 1,
  event: "schedule",
  status: "completed",
  conclusion: "success",
  head_sha: "0123456789abcdef",
  created_at: "2026-07-13T11:00:00Z",
  updated_at: "2026-07-13T11:02:00Z",
  html_url: "https://github.test/runs/1",
  ...overrides,
});
const hoursAgo = (hours: number): string =>
  new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();

describe("scheduled health assessment", () => {
  it("sorts scheduled runs newest first and ignores manual runs", () => {
    const result = assessScheduledHealth(
      [
        run({ id: 1, updated_at: "2026-07-13T08:00:00Z" }),
        run({ id: 4, event: "workflow_dispatch", updated_at: "2026-07-13T11:00:00Z" }),
        run({ id: 3, updated_at: "2026-07-13T10:00:00Z" }),
        run({ id: 2, updated_at: "2026-07-13T09:00:00Z" }),
      ],
      workflow("2026-07-12T00:00:00Z"),
      now,
    );
    expect(result.runs.map((item) => item.id)).toEqual([3, 2, 1]);
    expect(result.reasons).toEqual([]);
  });

  it("does not let manual failures or successes affect scheduled health", () => {
    const manual = ["success", "failure", "failure", "failure"].map((conclusion, index) =>
      run({ id: index, event: "workflow_dispatch", conclusion }),
    );
    expect(assessScheduledHealth(manual, workflow(hoursAgo(1)), now).reasons).toEqual([]);
  });

  it.each(["failure", "timed_out", "action_required", "startup_failure", "cancelled"])(
    "counts %s completions toward three consecutive failures",
    (conclusion) => {
      const result = assessScheduledHealth(
        [
          run({ id: 1, conclusion, updated_at: "2026-07-13T11:00:00Z" }),
          run({ id: 2, conclusion: "failure", updated_at: "2026-07-13T10:00:00Z" }),
          run({ id: 3, conclusion: "failure", updated_at: "2026-07-13T09:00:00Z" }),
          run({ id: 4, updated_at: "2026-07-13T08:00:00Z" }),
        ],
        workflow("2026-07-12T00:00:00Z"),
        now,
      );
      expect(result.reasons).toEqual(["The three most recent completed scheduled runs failed."]);
    },
  );

  it.each(["neutral", "skipped", "stale"])(
    "treats a %s completion as neither a failure nor a success",
    (conclusion) => {
      const result = assessScheduledHealth(
        [
          run({ id: 1, conclusion: "failure", updated_at: "2026-07-13T11:00:00Z" }),
          run({ id: 2, conclusion, updated_at: "2026-07-13T10:00:00Z" }),
          run({ id: 3, conclusion: "failure", updated_at: "2026-07-13T09:00:00Z" }),
          run({ id: 4, conclusion: "failure", updated_at: "2026-07-13T08:00:00Z" }),
          run({ id: 5, updated_at: "2026-07-13T07:00:00Z" }),
        ],
        workflow("2026-07-12T00:00:00Z"),
        now,
      );
      expect(result.reasons).toEqual([]);
      expect(result.latestSuccess?.id).toBe(5);
    },
  );

  it("does not count queued or in-progress runs as completed failures", () => {
    const result = assessScheduledHealth(
      [
        run({ id: 1, status: "in_progress", conclusion: null, updated_at: hoursAgo(0.1) }),
        run({ id: 2, conclusion: "failure", updated_at: hoursAgo(1) }),
        run({ id: 3, conclusion: "failure", updated_at: hoursAgo(2) }),
        run({ id: 4, updated_at: hoursAgo(3) }),
      ],
      workflow("2026-07-12T00:00:00Z"),
      now,
    );
    expect(result.reasons).toEqual([]);
  });

  it("stays quiet with no runs inside activation grace, then alerts", () => {
    expect(assessScheduledHealth([], workflow(hoursAgo(13)), now).reasons).toEqual([]);
    expect(assessScheduledHealth([], workflow(hoursAgo(15)), now).reasons).toEqual([
      "No scheduled run has succeeded within 14 hours of workflow activation.",
    ]);
    expect(assessScheduledHealth([], workflow(hoursAgo(15)), now, 16).reasons).toEqual([]);
  });

  it("falls back to the workflow creation time when it was never updated", () => {
    const created = { state: "active", created_at: hoursAgo(15) };
    expect(assessScheduledHealth([], created, now).reasons).toHaveLength(1);
  });

  it("does not alert on early failures while activation grace remains", () => {
    const failures = [run({ conclusion: "failure", updated_at: hoursAgo(1) })];
    expect(assessScheduledHealth(failures, workflow(hoursAgo(2)), now).reasons).toEqual([]);
    expect(assessScheduledHealth(failures, workflow(hoursAgo(20)), now).reasons).toHaveLength(1);
  });

  it("reports a disabled workflow immediately and reports nothing else", () => {
    const result = assessScheduledHealth(
      [
        run({ conclusion: "failure" }),
        run({ conclusion: "failure" }),
        run({ conclusion: "failure" }),
      ],
      workflow(hoursAgo(0.1), "disabled_manually"),
      now,
    );
    expect(result.reasons).toEqual([
      "The scheduled sync workflow is not active (GitHub state: disabled_manually).",
    ]);
  });

  it("allows bounded scheduler delay, then alerts when the last success is stale", () => {
    const fresh = [run({ updated_at: hoursAgo(SUCCESS_WATCHDOG_HOURS - 1 / 60) })];
    const stale = [run({ updated_at: hoursAgo(SUCCESS_WATCHDOG_HOURS + 1 / 60) })];
    expect(assessScheduledHealth(fresh, workflow(hoursAgo(48)), now).reasons).toEqual([]);
    expect(assessScheduledHealth(stale, workflow(hoursAgo(48)), now).reasons).toEqual([
      "No scheduled run has succeeded in the last 24 hours.",
    ]);
  });

  it("lets a recently created queued or in-progress run defer a stale-success alert", () => {
    for (const status of ["queued", "in_progress"]) {
      const runs = [
        run({ id: 2, status, conclusion: null, created_at: hoursAgo(1), updated_at: hoursAgo(1) }),
        run({ id: 1, updated_at: hoursAgo(30) }),
      ];
      expect(assessScheduledHealth(runs, workflow(hoursAgo(48)), now).reasons).toEqual([]);
    }
  });

  it("does not let a run stuck in the queue for hours defer the alert forever", () => {
    const runs = [
      run({
        id: 2,
        status: "queued",
        conclusion: null,
        created_at: hoursAgo(3),
        updated_at: hoursAgo(3),
      }),
      run({ id: 1, updated_at: hoursAgo(30) }),
    ];
    expect(assessScheduledHealth(runs, workflow(hoursAgo(48)), now).reasons).toHaveLength(1);
  });
});

describe("observed schedule cadence (#53)", () => {
  // Real scheduled sync timestamps (UTC); runs marked failed stand in for a failure at that slot.
  const active = workflow("2026-08-01T00:00:00Z");
  const lastEvening = run({
    id: 1,
    created_at: "2026-09-13T21:34:47Z",
    updated_at: "2026-09-13T21:35:17Z",
  });
  const failedMorning = run({
    id: 2,
    conclusion: "failure",
    created_at: "2026-09-14T10:54:37Z",
    updated_at: "2026-09-14T10:55:04Z",
  });

  it("does not alert on one failed morning run before the afternoon run completes", () => {
    // 15:14:38 is when the health check really ran that day; the afternoon run completed at 18:08:57.
    for (const at of ["2026-09-14T15:14:38Z", "2026-09-14T18:08:56Z"]) {
      const assessment = assessScheduledHealth([failedMorning, lastEvening], active, new Date(at));
      expect(assessment.reasons).toEqual([]);
    }
  });

  it("does not alert across the longest observed gap between two scheduled runs", () => {
    // 2026-08-26 22:24 to 2026-08-27 16:39 UTC: GitHub dropped four slots in a row.
    const success = run({ created_at: "2026-08-26T22:24:13Z", updated_at: "2026-08-26T22:24:42Z" });
    const beforeNextRun = new Date("2026-08-27T16:39:13Z");
    expect(assessScheduledHealth([success], active, beforeNextRun).reasons).toEqual([]);
  });

  it("alerts once a whole day passes without a scheduled success", () => {
    const failedAfternoon = run({
      id: 3,
      conclusion: "failure",
      created_at: "2026-09-14T18:08:11Z",
      updated_at: "2026-09-14T18:08:57Z",
    });
    const runs = [failedAfternoon, failedMorning, lastEvening];
    const at = (iso: string) => assessScheduledHealth(runs, active, new Date(iso)).reasons;
    expect(at("2026-09-14T21:35:16Z")).toEqual([]);
    expect(at("2026-09-14T21:35:17Z")).toEqual([
      "No scheduled run has succeeded in the last 24 hours.",
    ]);
  });
});

describe("run listing merge", () => {
  it("unions listings by run id and keeps the newest attempt of a duplicated run", () => {
    const merged = mergeRuns(
      [run({ id: 1, conclusion: "failure", updated_at: hoursAgo(3) }), run({ id: 2 })],
      [
        run({ id: 1, run_attempt: 2, updated_at: hoursAgo(1) }),
        run({ id: 2, updated_at: hoursAgo(30) }),
        run({ id: 3 }),
      ],
    );
    expect(merged.map((item) => [item.id, item.run_attempt, item.conclusion])).toEqual([
      [1, 2, "success"],
      [2, 1, "success"],
      [3, 1, "success"],
    ]);
    expect(merged[1]?.updated_at).toBe("2026-07-13T11:02:00Z");
  });
});

describe("incident recovery", () => {
  const assess = (runs: WorkflowRun[]) => assessScheduledHealth(runs, workflow(hoursAgo(48)), now);

  it("recovers only when a scheduled success is strictly newer than every failure", () => {
    expect(
      recoveredFromIncident(
        assess([
          run({ updated_at: hoursAgo(1) }),
          run({ conclusion: "failure", updated_at: hoursAgo(2) }),
        ]),
      ),
    ).toBe(true);
    expect(
      recoveredFromIncident(
        assess([
          run({ updated_at: hoursAgo(2) }),
          run({ conclusion: "failure", updated_at: hoursAgo(2) }),
        ]),
      ),
    ).toBe(false);
    expect(
      recoveredFromIncident(
        assess([
          run({ conclusion: "neutral", updated_at: hoursAgo(1) }),
          run({ updated_at: hoursAgo(2) }),
        ]),
      ),
    ).toBe(true);
  });

  it("does not recover while unhealthy, without any success, or on a manual success", () => {
    expect(recoveredFromIncident(assess([run({ updated_at: hoursAgo(30) })]))).toBe(false);
    expect(recoveredFromIncident(assessScheduledHealth([], workflow(hoursAgo(1)), now))).toBe(
      false,
    );
    expect(
      recoveredFromIncident(
        assessScheduledHealth([run({ event: "workflow_dispatch" })], workflow(hoursAgo(1)), now),
      ),
    ).toBe(false);
  });
});
