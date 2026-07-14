import { describe, expect, it } from "vitest";
import {
  HEALTH_ISSUE_LABEL,
  HEALTH_ISSUE_TITLE,
  HEALTH_MARKER,
  monitorScheduledHealth,
  renderHealthIssue,
  assessScheduledHealth,
} from "../../scripts/check-health.js";
import {
  FetchGitHubHealthClient,
  type GitHubHealthClient,
  type HealthIssue,
  type IssueComment,
  type WorkflowActivationMetadata,
  type WorkflowRun,
} from "../../scripts/github-health-client.js";

const now = new Date("2026-07-13T12:00:00Z");
const activated: WorkflowActivationMetadata = {
  activatedAt: "2026-07-12T00:00:00Z",
  state: "active",
  source: "workflow-updated-at",
};

function run(id: number, conclusion = "failure", event = "schedule"): WorkflowRun {
  const hour = 12 - id;
  const timestamp = `2026-07-13T${String(hour).padStart(2, "0")}:00:00Z`;
  return {
    id,
    run_attempt: 1,
    name: "Canvas–Notion sync",
    path: ".github/workflows/sync.yml",
    event,
    status: "completed",
    conclusion,
    head_branch: "main",
    head_sha: `sha-${id}`,
    created_at: timestamp,
    run_started_at: timestamp,
    updated_at: timestamp,
    completed_at: timestamp,
    html_url: `https://github.test/runs/${id}`,
  };
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

class FakeClient implements GitHubHealthClient {
  public runs: WorkflowRun[] = [run(1), run(2), run(3)];
  public activation = activated;
  public issues: HealthIssue[] = [];
  public comments = new Map<number, IssueComment[]>();
  public labelExists = false;
  public calls: string[] = [];

  public async listWorkflowRuns(): Promise<WorkflowRun[]> {
    return Promise.resolve(this.runs);
  }
  public async getWorkflowRun(runId: number): Promise<WorkflowRun> {
    const found = this.runs.find((item) => item.id === runId);
    if (!found) throw new Error("run not found");
    return Promise.resolve(found);
  }
  public async listMatchingIssues(): Promise<HealthIssue[]> {
    return Promise.resolve(this.issues);
  }
  public async listIssueComments(issueNumber: number): Promise<IssueComment[]> {
    this.calls.push(`list-comments:${issueNumber}`);
    return Promise.resolve(this.comments.get(issueNumber) ?? []);
  }
  public async getLabel(): Promise<{ name: string } | undefined> {
    this.calls.push("get-label");
    return Promise.resolve(this.labelExists ? { name: HEALTH_ISSUE_LABEL } : undefined);
  }
  public createLabel(): Promise<void> {
    this.calls.push("create-label");
    this.labelExists = true;
    return Promise.resolve();
  }
  public async createIssue(issue: {
    title: string;
    body: string;
    labels: string[];
  }): Promise<HealthIssue> {
    this.calls.push("create-issue");
    const created: HealthIssue = {
      number: 1,
      title: issue.title,
      body: issue.body,
      state: "open",
      labels: issue.labels,
    };
    this.issues.push(created);
    return Promise.resolve(created);
  }
  public updateIssue(
    issueNumber: number,
    update: { body?: string; state?: "open" | "closed" },
  ): Promise<void> {
    this.calls.push(`update-issue:${issueNumber}`);
    const issue = this.issues.find((item) => item.number === issueNumber);
    if (issue) Object.assign(issue, update);
    return Promise.resolve();
  }
  public addRecoveryComment(issueNumber: number, body: string): Promise<void> {
    this.calls.push(`comment:${issueNumber}`);
    const comments = this.comments.get(issueNumber) ?? [];
    comments.push({ id: comments.length + 1, body });
    this.comments.set(issueNumber, comments);
    return Promise.resolve();
  }
  public closeIssue(issueNumber: number): Promise<void> {
    this.calls.push(`close:${issueNumber}`);
    const issue = this.issues.find((item) => item.number === issueNumber);
    if (issue) issue.state = "closed";
    return Promise.resolve();
  }
  public async getWorkflowActivationMetadata(): Promise<WorkflowActivationMetadata> {
    return Promise.resolve(this.activation);
  }
}

function unhealthyIssue(number = 1): HealthIssue {
  const assessment = assessScheduledHealth([run(1), run(2), run(3)], activated, now);
  return {
    number,
    title: HEALTH_ISSUE_TITLE,
    body: renderHealthIssue(assessment),
    state: "open",
    labels: [HEALTH_ISSUE_LABEL],
  };
}

describe("GitHub health issue integration", () => {
  it("creates a missing label before opening the first unhealthy issue", async () => {
    const client = new FakeClient();
    await monitorScheduledHealth(client, { now });
    expect(client.calls).toContain("create-label");
    expect(client.calls).toContain("create-issue");
    expect(client.issues[0]?.body).toContain(HEALTH_MARKER);
    expect(client.issues[0]?.body).toContain("Multiple conditions");
  });

  it("reuses an existing label", async () => {
    const client = new FakeClient();
    client.labelExists = true;
    await monitorScheduledHealth(client, { now });
    expect(client.calls).not.toContain("create-label");
  });

  it("updates an existing open issue when health metadata changes", async () => {
    const client = new FakeClient();
    client.labelExists = true;
    client.issues = [{ ...unhealthyIssue(), body: `${HEALTH_MARKER}\noutdated` }];
    await monitorScheduledHealth(client, { now });
    expect(client.calls).toContain("update-issue:1");
    expect(client.issues[0]?.body).toContain("Run 1");
  });

  it("does not patch an identical unhealthy issue", async () => {
    const client = new FakeClient();
    client.labelExists = true;
    client.issues = [unhealthyIssue()];
    await monitorScheduledHealth(client, { now });
    expect(client.calls).not.toContain("update-issue:1");
  });

  it("reopens the same durable issue for a later unhealthy episode", async () => {
    const client = new FakeClient();
    client.labelExists = true;
    client.issues = [{ ...unhealthyIssue(), state: "closed" }];
    await monitorScheduledHealth(client, { now });
    expect(client.issues).toHaveLength(1);
    expect(client.issues[0]?.state).toBe("open");
  });

  it("adds one recovery comment and closes the issue", async () => {
    const client = new FakeClient();
    client.issues = [unhealthyIssue()];
    client.runs = [run(10, "success")];
    client.runs[0]!.completed_at = "2026-07-13T11:30:00Z";
    client.runs[0]!.updated_at = "2026-07-13T11:30:00Z";
    await monitorScheduledHealth(client, { now });
    expect(client.calls).toContain("comment:1");
    expect(client.calls).toContain("close:1");
    expect(client.issues[0]?.state).toBe("closed");
  });

  it("does not repeat an identical recovery comment if closing is retried", async () => {
    const client = new FakeClient();
    const issue = unhealthyIssue();
    client.issues = [issue];
    client.runs = [run(10, "success")];
    client.runs[0]!.completed_at = "2026-07-13T11:30:00Z";
    client.runs[0]!.updated_at = "2026-07-13T11:30:00Z";
    const episode = issue.body?.match(/episode:v1:([a-f0-9]{16})/)?.[1];
    client.comments.set(1, [
      { id: 1, body: `<!-- canvas-notion-health-recovery:v1:${episode} -->\nRecovered` },
    ]);
    await monitorScheduledHealth(client, { now });
    expect(client.calls).not.toContain("comment:1");
    expect(client.calls).toContain("close:1");
  });

  it("repeated healthy checks do not comment or close again", async () => {
    const client = new FakeClient();
    client.issues = [{ ...unhealthyIssue(), state: "closed" }];
    client.runs = [run(10, "success")];
    client.runs[0]!.completed_at = "2026-07-13T11:30:00Z";
    client.runs[0]!.updated_at = "2026-07-13T11:30:00Z";
    await monitorScheduledHealth(client, { now });
    expect(client.calls.some((call) => call.startsWith("comment:"))).toBe(false);
    expect(client.calls.some((call) => call.startsWith("close:"))).toBe(false);
  });

  it("does not report recovery merely because a new activation grace is in effect", async () => {
    const client = new FakeClient();
    client.issues = [unhealthyIssue()];
    client.runs = [];
    client.activation = {
      ...activated,
      activatedAt: "2026-07-13T11:00:00Z",
    };
    await monitorScheduledHealth(client, { now });
    expect(client.calls.some((call) => call.startsWith("comment:"))).toBe(false);
    expect(client.calls.some((call) => call.startsWith("close:"))).toBe(false);
  });
});

describe("fetch-backed GitHub client", () => {
  it("paginates issues so result limits do not hide the durable issue", async () => {
    const requests: string[] = [];
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      number: index + 1,
      title: `Other ${index}`,
      body: null,
      state: "closed",
      labels: [],
    }));
    const fetch = (input: string | URL | Request): Promise<Response> => {
      const url = requestUrl(input);
      requests.push(url);
      return Promise.resolve(
        Response.json(url.includes("page=2") ? [unhealthyIssue(101)] : firstPage),
      );
    };
    const client = new FetchGitHubHealthClient({ token: "secret-token", repository: "o/r", fetch });
    const issues = await client.listMatchingIssues(HEALTH_ISSUE_LABEL);
    expect(issues).toHaveLength(101);
    expect(requests.some((request) => request.includes("page=2"))).toBe(true);
  });

  it("returns sanitized actionable errors without exposing the token or response body", async () => {
    const token = "top-secret-token";
    const client = new FetchGitHubHealthClient({
      token,
      repository: "o/r",
      fetch: () => Promise.resolve(new Response(`Authorization: Bearer ${token}`, { status: 403 })),
    });
    let message = "";
    try {
      await client.listWorkflowRuns("sync.yml");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("authorization or permission denied");
    expect(message).not.toContain(token);
  });

  it("retries rate limits and transient read failures with a bounded policy", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const client = new FetchGitHubHealthClient({
      token: "secret-token",
      repository: "o/r",
      attempts: 3,
      baseDelayMs: 1,
      sleep: (milliseconds) => {
        sleeps.push(milliseconds);
        return Promise.resolve();
      },
      fetch: () => {
        calls += 1;
        if (calls === 1) return Promise.resolve(new Response(null, { status: 429 }));
        if (calls === 2) return Promise.resolve(new Response(null, { status: 503 }));
        return Promise.resolve(Response.json({ workflow_runs: [] }));
      },
    });
    await expect(client.listWorkflowRuns("sync.yml")).resolves.toEqual([]);
    expect(calls).toBe(3);
    expect(sleeps).toHaveLength(2);
  });

  it("does not retry permanent authorization failures", async () => {
    let calls = 0;
    const client = new FetchGitHubHealthClient({
      token: "secret-token",
      repository: "o/r",
      attempts: 5,
      fetch: () => {
        calls += 1;
        return Promise.resolve(new Response(null, { status: 401 }));
      },
    });
    await expect(client.listWorkflowRuns("sync.yml")).rejects.toThrow("status 401");
    expect(calls).toBe(1);
  });

  it("supports workflow activation and individual run metadata reads", async () => {
    const fetch = (input: string | URL | Request): Promise<Response> => {
      const url = requestUrl(input);
      if (url.endsWith("/actions/workflows/sync.yml")) {
        return Promise.resolve(
          Response.json({
            state: "active",
            created_at: "2026-07-01T00:00:00Z",
            updated_at: "2026-07-02T00:00:00Z",
          }),
        );
      }
      return Promise.resolve(Response.json(run(42)));
    };
    const client = new FetchGitHubHealthClient({ token: "secret-token", repository: "o/r", fetch });
    await expect(client.getWorkflowActivationMetadata("sync.yml")).resolves.toMatchObject({
      activatedAt: "2026-07-02T00:00:00Z",
    });
    await expect(client.getWorkflowRun(42)).resolves.toMatchObject({ id: 42 });
  });
});
