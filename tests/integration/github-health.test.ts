import { describe, expect, it } from "vitest";
import {
  assessScheduledHealth,
  createGitHubRequest,
  GitHubApiError,
  HEALTH_ISSUE_LABEL,
  HEALTH_ISSUE_TITLE,
  main,
  monitorScheduledHealth,
  renderHealthIssue,
  type GitHubRequest,
  type HealthIssue,
  type Workflow,
  type WorkflowRun,
} from "../../scripts/check-health.ts";

const now = new Date("2026-07-13T12:00:00Z");
const activeWorkflow: Workflow = {
  state: "active",
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-12T00:00:00Z",
};

function run(id: number, conclusion: string, updatedAt: string, event = "schedule"): WorkflowRun {
  return {
    id,
    run_attempt: 1,
    event,
    status: "completed",
    conclusion,
    head_sha: `sha-${id}`,
    created_at: updatedAt,
    updated_at: updatedAt,
    html_url: `https://github.test/runs/${id}`,
  };
}

const threeFailures = [
  run(1, "failure", "2026-07-13T11:00:00Z"),
  run(2, "failure", "2026-07-13T10:00:00Z"),
  run(3, "failure", "2026-07-13T09:00:00Z"),
];

interface FakeGitHub {
  runs: WorkflowRun[];
  workflow: Workflow;
  issues: HealthIssue[];
  labelExists: boolean;
  comments: string[];
  calls: string[];
  request: GitHubRequest;
}

function fakeGitHub(overrides: Partial<FakeGitHub> = {}): FakeGitHub {
  const github: FakeGitHub = {
    runs: threeFailures,
    workflow: activeWorkflow,
    issues: [],
    labelExists: true,
    comments: [],
    calls: [],
    request: (method, path, body) => {
      github.calls.push(`${method} ${path.split("?")[0]}`);
      const issueMatch = /^\/issues\/(\d+)(\/comments)?$/.exec(path);
      if (method === "GET" && path.startsWith("/actions/workflows/sync.yml/runs")) {
        return Promise.resolve({ workflow_runs: github.runs });
      }
      if (method === "GET" && path === "/actions/workflows/sync.yml") {
        return Promise.resolve(github.workflow);
      }
      if (method === "GET" && path.startsWith("/issues?")) {
        const page = Number(new URLSearchParams(path.split("?")[1]).get("page") ?? 1);
        return Promise.resolve(github.issues.slice((page - 1) * 100, page * 100));
      }
      if (method === "POST" && path === "/labels") {
        if (github.labelExists) return Promise.reject(new GitHubApiError("exists", 422));
        github.labelExists = true;
        return Promise.resolve({});
      }
      if (method === "POST" && path === "/issues") {
        const issue = { number: github.issues.length + 1, state: "open", ...(body as object) };
        github.issues.push(issue as HealthIssue);
        return Promise.resolve(issue);
      }
      const issue = github.issues.find((item) => item.number === Number(issueMatch?.[1]));
      if (issue && method === "POST" && issueMatch?.[2]) {
        github.comments.push((body as { body: string }).body);
        return Promise.resolve({});
      }
      if (issue && method === "PATCH") return Promise.resolve(Object.assign(issue, body));
      return Promise.reject(new Error(`Unexpected request ${method} ${path}`));
    },
    ...overrides,
  };
  return github;
}

function openIssue(runs = threeFailures, state: "open" | "closed" = "open"): HealthIssue {
  return {
    number: 1,
    title: HEALTH_ISSUE_TITLE,
    body: renderHealthIssue(assessScheduledHealth(runs, activeWorkflow, now)),
    state,
  };
}

describe("GitHub health issue lifecycle", () => {
  it("creates the label and opens one labeled issue on the first unhealthy check", async () => {
    const github = fakeGitHub({ labelExists: false });
    await monitorScheduledHealth(github.request, { now });
    expect(github.calls).toEqual([
      "GET /actions/workflows/sync.yml/runs",
      "GET /actions/workflows/sync.yml",
      "GET /issues",
      "POST /labels",
      "POST /issues",
    ]);
    expect(github.issues[0]).toMatchObject({
      title: HEALTH_ISSUE_TITLE,
      labels: [HEALTH_ISSUE_LABEL],
    });
    expect(github.issues[0]?.body).toContain("three most recent completed scheduled runs failed");
    expect(github.issues[0]?.body).toContain("[1 (attempt 1)](https://github.test/runs/1)");
  });

  it("tolerates a label that already exists", async () => {
    const github = fakeGitHub();
    await monitorScheduledHealth(github.request, { now });
    expect(github.calls).toContain("POST /issues");
  });

  it("updates the open issue only when its body changes", async () => {
    const github = fakeGitHub({ issues: [openIssue()] });
    await monitorScheduledHealth(github.request, { now });
    expect(github.calls).not.toContain("PATCH /issues/1");

    github.runs = [run(4, "failure", "2026-07-13T11:30:00Z"), ...threeFailures];
    await monitorScheduledHealth(github.request, { now });
    expect(github.calls).toContain("PATCH /issues/1");
    expect(github.issues[0]?.body).toContain("runs/4");
    expect(github.issues[0]?.state).toBe("open");
  });

  it("treats a body edited to CRLF line endings as unchanged", async () => {
    const issue = openIssue();
    issue.body = issue.body!.replace(/\n/g, "\r\n");
    const github = fakeGitHub({ issues: [issue] });
    await monitorScheduledHealth(github.request, { now });
    expect(github.calls).not.toContain("PATCH /issues/1");
  });

  it("reopens the same closed issue for a later incident instead of creating another", async () => {
    const github = fakeGitHub({ issues: [openIssue([], "closed")] });
    await monitorScheduledHealth(github.request, { now });
    expect(github.calls).not.toContain("POST /issues");
    expect(github.issues).toHaveLength(1);
    expect(github.issues[0]?.state).toBe("open");
    expect(github.issues[0]?.body).toContain("runs/1");
  });

  it("paginates labeled issues so newer ones cannot hide the durable issue", async () => {
    const filler = Array.from({ length: 100 }, (_, index) => ({
      number: 200 - index,
      title: `Other ${index}`,
      body: null,
      state: "closed" as const,
    }));
    const github = fakeGitHub({ issues: [...filler, openIssue()] });
    github.runs = [run(4, "failure", "2026-07-13T11:30:00Z"), ...threeFailures];
    await monitorScheduledHealth(github.request, { now });
    expect(github.calls.filter((call) => call === "GET /issues")).toHaveLength(2);
    expect(github.calls).toContain("PATCH /issues/1");
    expect(github.calls).not.toContain("POST /issues");
  });

  it("prefers the oldest matching issue and ignores pull requests", async () => {
    const github = fakeGitHub({
      issues: [
        { ...openIssue(), number: 7, pull_request: {} },
        { ...openIssue(), number: 5 },
        { ...openIssue(), number: 3 },
      ],
    });
    github.runs = [run(4, "failure", "2026-07-13T11:30:00Z"), ...threeFailures];
    await monitorScheduledHealth(github.request, { now });
    expect(github.calls).toContain("PATCH /issues/3");
    expect(github.calls).not.toContain("PATCH /issues/5");
  });

  it("closes the issue and leaves one recovery comment once a newer scheduled run succeeds", async () => {
    const github = fakeGitHub({ issues: [openIssue()] });
    github.runs = [run(10, "success", "2026-07-13T11:30:00Z"), ...threeFailures];
    await monitorScheduledHealth(github.request, { now });
    expect(github.calls.slice(3)).toEqual(["PATCH /issues/1", "POST /issues/1/comments"]);
    expect(github.issues[0]).toMatchObject({ state: "closed", state_reason: "completed" });
    expect(github.comments).toEqual([
      "Scheduled run [10](https://github.test/runs/10) succeeded after the last failure, so the health check closed this issue.",
    ]);

    await monitorScheduledHealth(github.request, { now });
    expect(github.calls.slice(5)).toEqual([
      "GET /actions/workflows/sync.yml/runs",
      "GET /actions/workflows/sync.yml",
      "GET /issues",
    ]);
    expect(github.comments).toHaveLength(1);
  });

  it("keeps the issue open when the only success predates the failures", async () => {
    const github = fakeGitHub({ issues: [openIssue()] });
    github.runs = [
      run(4, "neutral", "2026-07-13T11:30:00Z"),
      ...threeFailures,
      run(5, "success", "2026-07-13T08:00:00Z"),
    ];
    await monitorScheduledHealth(github.request, { now });
    expect(github.calls).not.toContain("PATCH /issues/1");
    expect(github.issues[0]?.state).toBe("open");
  });

  it("keeps the issue open on a success with the same timestamp as the latest failure", async () => {
    const github = fakeGitHub({ issues: [openIssue()] });
    github.runs = [run(10, "success", "2026-07-13T11:00:00Z"), ...threeFailures];
    await monitorScheduledHealth(github.request, { now });
    expect(github.issues[0]?.state).toBe("open");
  });

  it("lets a later successful rerun attempt recover the incident", async () => {
    const github = fakeGitHub({ issues: [openIssue()] });
    github.runs = [
      { ...run(1, "success", "2026-07-13T11:30:00Z"), run_attempt: 2 },
      ...threeFailures.slice(1),
    ];
    await monitorScheduledHealth(github.request, { now });
    expect(github.issues[0]?.state).toBe("closed");
  });

  it("never uses a manual success to recover scheduled health", async () => {
    const github = fakeGitHub({ issues: [openIssue()] });
    github.runs = [run(20, "success", "2026-07-13T11:30:00Z", "workflow_dispatch")];
    github.workflow = { ...activeWorkflow, updated_at: "2026-07-13T11:00:00Z" };
    await monitorScheduledHealth(github.request, { now });
    expect(github.calls).not.toContain("PATCH /issues/1");
  });

  it("does not close the issue merely because a new activation grace is in effect", async () => {
    const github = fakeGitHub({ issues: [openIssue()], runs: [] });
    github.workflow = { ...activeWorkflow, updated_at: "2026-07-13T11:00:00Z" };
    await monitorScheduledHealth(github.request, { now });
    expect(github.calls).not.toContain("PATCH /issues/1");
  });

  it("treats a check landing exactly on the watchdog or activation deadline as unhealthy", () => {
    const exactly13HoursAgo = new Date(now.getTime() - 13 * 60 * 60 * 1000).toISOString();
    const success = [run(10, "success", exactly13HoursAgo)];
    expect(assessScheduledHealth(success, activeWorkflow, now).reasons).toEqual([
      "No scheduled run has succeeded in the last 13 hours.",
    ]);
    const justInside = new Date(now.getTime() - 1);
    expect(assessScheduledHealth(success, activeWorkflow, justInside).reasons).toEqual([]);

    const exactly14HoursAgo = new Date(now.getTime() - 14 * 60 * 60 * 1000).toISOString();
    const activated = { ...activeWorkflow, updated_at: exactly14HoursAgo };
    expect(assessScheduledHealth([], activated, now).reasons).toEqual([
      "No scheduled run has succeeded within 14 hours of workflow activation.",
    ]);
    expect(assessScheduledHealth([], activated, justInside).reasons).toEqual([]);
  });

  it("closes a disabled-workflow incident once the workflow is active and healthy again", async () => {
    const github = fakeGitHub({ workflow: { ...activeWorkflow, state: "disabled_manually" } });
    github.runs = [run(10, "success", "2026-07-13T11:30:00Z")];
    await monitorScheduledHealth(github.request, { now });
    expect(github.issues[0]?.body).toContain("not active (GitHub state: disabled_manually)");

    github.workflow = activeWorkflow;
    await monitorScheduledHealth(github.request, { now });
    expect(github.issues[0]?.state).toBe("closed");
  });
});

describe("fetch-backed GitHub request", () => {
  const token = "top-secret-token";
  const noSleep = () => Promise.resolve();

  it("sends authenticated JSON requests to the repository endpoint", async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const request = createGitHubRequest({
      token,
      repository: "o/r",
      fetch: (input, init) => {
        seen.push({ url: input instanceof Request ? input.url : String(input), init });
        return Promise.resolve(Response.json({ ok: true }));
      },
    });
    await expect(request("PATCH", "/issues/1", { state: "closed" })).resolves.toEqual({ ok: true });
    expect(seen[0]?.url).toBe("https://api.github.com/repos/o/r/issues/1");
    expect(seen[0]?.init?.method).toBe("PATCH");
    expect(seen[0]?.init?.body).toBe('{"state":"closed"}');
    expect((seen[0]?.init?.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${token}`,
    );
  });

  it("returns sanitized errors without exposing the token or response body", async () => {
    const request = createGitHubRequest({
      token,
      repository: "o/r",
      fetch: () => Promise.resolve(new Response(`Authorization: Bearer ${token}`, { status: 403 })),
    });
    const error = await request("GET", "/actions/workflows/sync.yml?x=1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect((error as GitHubApiError).status).toBe(403);
    expect((error as Error).message).toBe(
      "GitHub API GET /actions/workflows/sync.yml failed with status 403; check the workflow token permissions",
    );
  });

  it("retries rate limits, server errors, and network failures on reads with a bounded policy", async () => {
    let calls = 0;
    const request = createGitHubRequest({
      token,
      repository: "o/r",
      sleep: noSleep,
      fetch: () => {
        calls += 1;
        if (calls === 1) return Promise.resolve(new Response(null, { status: 429 }));
        if (calls === 2) return Promise.reject(new Error("socket hang up"));
        return Promise.resolve(Response.json({ workflow_runs: [] }));
      },
    });
    await expect(request("GET", "/runs")).resolves.toEqual({ workflow_runs: [] });
    expect(calls).toBe(3);

    calls = 0;
    const exhausted = createGitHubRequest({
      token,
      repository: "o/r",
      sleep: noSleep,
      fetch: () => {
        calls += 1;
        return Promise.resolve(new Response(null, { status: 503 }));
      },
    });
    await expect(exhausted("GET", "/runs")).rejects.toThrow("failed with status 503");
    expect(calls).toBe(3);
  });

  it("does not retry authorization failures or non-idempotent writes", async () => {
    let calls = 0;
    const request = createGitHubRequest({
      token,
      repository: "o/r",
      sleep: noSleep,
      fetch: () => {
        calls += 1;
        return Promise.resolve(new Response(null, { status: calls === 1 ? 401 : 503 }));
      },
    });
    await expect(request("GET", "/runs")).rejects.toThrow("status 401");
    await expect(request("POST", "/issues", {})).rejects.toThrow("status 503");
    expect(calls).toBe(2);
  });

  it("waits the full Retry-After, until x-ratelimit-reset, or GitHub's one-minute minimum", async () => {
    const nowMs = Date.parse("2026-07-13T12:00:00Z");
    const sleeps: number[] = [];
    const responses = [
      new Response(null, { status: 403, headers: { "retry-after": "45" } }),
      new Response(null, {
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(nowMs / 1000 + 90) },
      }),
      new Response(null, { status: 429 }),
      Response.json({ workflow_runs: [] }),
    ];
    const request = createGitHubRequest({
      token,
      repository: "o/r",
      attempts: 4,
      now: () => nowMs,
      sleep: (milliseconds) => {
        sleeps.push(milliseconds);
        return Promise.resolve();
      },
      fetch: () => Promise.resolve(responses.shift()!),
    });
    await expect(request("GET", "/runs")).resolves.toEqual({ workflow_runs: [] });
    expect(sleeps).toEqual([45_000, 90_000, 60_000]);

    const exhausted = createGitHubRequest({
      token,
      repository: "o/r",
      attempts: 1,
      fetch: () => Promise.resolve(new Response(null, { status: 429 })),
    });
    await expect(exhausted("GET", "/runs")).rejects.toThrow("status 429; rate limited");
  });

  it("fails cleanly instead of sleeping when the rate-limit wait exceeds the budget", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const request = createGitHubRequest({
      token,
      repository: "o/r",
      sleep: (milliseconds) => {
        sleeps.push(milliseconds);
        return Promise.resolve();
      },
      fetch: () => {
        calls += 1;
        return Promise.resolve(
          new Response(null, { status: 429, headers: { "retry-after": "600" } }),
        );
      },
    });
    await expect(request("GET", "/runs")).rejects.toThrow(
      "GitHub API GET /runs failed with status 429; rate limited for 600s, longer than the 300s wait budget",
    );
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);

    // The budget is cumulative across retries of one request.
    calls = 0;
    const cumulative = createGitHubRequest({
      token,
      repository: "o/r",
      attempts: 5,
      sleep: () => Promise.resolve(),
      fetch: () => {
        calls += 1;
        return Promise.resolve(
          new Response(null, { status: 429, headers: { "retry-after": "120" } }),
        );
      },
    });
    await expect(cumulative("GET", "/runs")).rejects.toThrow("longer than the 300s wait budget");
    expect(calls).toBe(3);
  });
});

describe("environment validation", () => {
  it.each(["Infinity", "NaN", "abc", "0", "-3"])(
    "rejects HEALTH_ACTIVATION_GRACE_HOURS=%s before contacting GitHub",
    async (value) => {
      await expect(
        main({ GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "o/r", HEALTH_ACTIVATION_GRACE_HOURS: value }),
      ).rejects.toThrow("HEALTH_ACTIVATION_GRACE_HOURS must be a positive finite number");
    },
  );
});
