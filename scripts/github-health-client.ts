export interface WorkflowRun {
  id: number;
  run_attempt: number;
  name: string;
  path?: string;
  event: string;
  status: string;
  conclusion: string | null;
  head_branch: string | null;
  head_sha: string;
  created_at: string;
  run_started_at?: string;
  updated_at: string;
  completed_at?: string;
  html_url: string;
}

export interface HealthIssue {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  labels: Array<string | { name?: string }>;
  pull_request?: { url?: string };
  created_at?: string;
  updated_at?: string;
}

export interface IssueComment {
  id: number;
  body: string | null;
}

export interface WorkflowActivationMetadata {
  activatedAt: string;
  state: string;
  source: "workflow-updated-at" | "workflow-created-at";
}

export interface GitHubHealthClient {
  listWorkflowRuns(workflowFile: string): Promise<WorkflowRun[]>;
  listMatchingIssues(label: string): Promise<HealthIssue[]>;
  listIssueComments(issueNumber: number): Promise<IssueComment[]>;
  getLabel(name: string): Promise<{ name: string } | undefined>;
  createLabel(label: { name: string; color: string; description: string }): Promise<void>;
  createIssue(issue: { title: string; body: string; labels: string[] }): Promise<HealthIssue>;
  updateIssue(
    issueNumber: number,
    update: { body?: string; state?: "open" | "closed" },
  ): Promise<void>;
  addRecoveryComment(issueNumber: number, body: string): Promise<void>;
  closeIssue(issueNumber: number): Promise<void>;
  getWorkflowActivationMetadata(workflowFile: string): Promise<WorkflowActivationMetadata>;
}

export class GitHubApiError extends Error {
  public constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface ClientOptions {
  token: string;
  repository: string;
  fetch?: FetchLike;
  apiUrl?: string;
  attempts?: number;
  baseDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);

function errorDescription(status: number): string {
  if (status === 401 || status === 403) {
    return "authorization or permission denied; verify the workflow token permissions";
  }
  if (status === 404) return "resource not found; verify the repository and workflow path";
  if (status === 429) return "rate limited after bounded retries";
  if (status >= 500) return "GitHub service remained unavailable after bounded retries";
  return "request was rejected";
}

export class FetchGitHubHealthClient implements GitHubHealthClient {
  private readonly fetchImplementation: FetchLike;
  private readonly apiUrl: string;
  private readonly attempts: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  public constructor(private readonly options: ClientOptions) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(options.repository)) {
      throw new Error("GITHUB_REPOSITORY must use the owner/repository format");
    }
    this.fetchImplementation = options.fetch ?? fetch;
    this.apiUrl = (options.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.attempts = options.attempts ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 250;
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  private async request<T>(
    path: string,
    options: { method?: "GET" | "POST" | "PATCH"; body?: unknown } = {},
  ): Promise<T> {
    const method = options.method ?? "GET";
    const retryableMethod = method === "GET" || method === "PATCH";
    for (let attempt = 0; attempt < this.attempts; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImplementation(
          `${this.apiUrl}/repos/${this.options.repository}${path}`,
          {
            method,
            headers: {
              Accept: "application/vnd.github+json",
              Authorization: `Bearer ${this.options.token}`,
              "Content-Type": "application/json",
              "X-GitHub-Api-Version": "2022-11-28",
              "User-Agent": "canvas-notion-health-check",
            },
            ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
          },
        );
      } catch {
        if (retryableMethod && attempt < this.attempts - 1) {
          await this.sleep(this.baseDelayMs * 2 ** attempt);
          continue;
        }
        throw new GitHubApiError(
          `GitHub API ${method} ${path.split("?")[0]} failed before receiving a response`,
        );
      }

      if (response.ok) {
        if (response.status === 204) return undefined as T;
        return (await response.json()) as T;
      }

      if (
        retryableMethod &&
        TRANSIENT_STATUSES.has(response.status) &&
        attempt < this.attempts - 1
      ) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const boundedRetryAfter = Number.isFinite(retryAfter)
          ? Math.min(Math.max(retryAfter * 1000, 0), 10_000)
          : this.baseDelayMs * 2 ** attempt;
        await this.sleep(boundedRetryAfter);
        continue;
      }

      throw new GitHubApiError(
        `GitHub API ${method} ${path.split("?")[0]} failed with status ${response.status}: ${errorDescription(response.status)}`,
        response.status,
      );
    }
    throw new GitHubApiError(`GitHub API ${method} ${path.split("?")[0]} exhausted retries`);
  }

  public async listWorkflowRuns(workflowFile: string): Promise<WorkflowRun[]> {
    const response = await this.request<{ workflow_runs: WorkflowRun[] }>(
      `/actions/workflows/${encodeURIComponent(workflowFile)}/runs?event=schedule&per_page=100`,
    );
    return response.workflow_runs;
  }

  public async listMatchingIssues(label: string): Promise<HealthIssue[]> {
    const issues: HealthIssue[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const result = await this.request<HealthIssue[]>(
        `/issues?state=all&labels=${encodeURIComponent(label)}&per_page=100&page=${page}`,
      );
      issues.push(...result.filter((issue) => !issue.pull_request));
      if (result.length < 100) return issues;
    }
    return issues;
  }

  public async listIssueComments(issueNumber: number): Promise<IssueComment[]> {
    const comments: IssueComment[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const result = await this.request<IssueComment[]>(
        `/issues/${issueNumber}/comments?per_page=100&page=${page}`,
      );
      comments.push(...result);
      if (result.length < 100) return comments;
    }
    return comments;
  }

  public async getLabel(name: string): Promise<{ name: string } | undefined> {
    try {
      return await this.request(`/labels/${encodeURIComponent(name)}`);
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return;
      throw error;
    }
  }

  public async createLabel(label: {
    name: string;
    color: string;
    description: string;
  }): Promise<void> {
    await this.request("/labels", { method: "POST", body: label });
  }

  public createIssue(issue: {
    title: string;
    body: string;
    labels: string[];
  }): Promise<HealthIssue> {
    return this.request("/issues", { method: "POST", body: issue });
  }

  public async updateIssue(
    issueNumber: number,
    update: { body?: string; state?: "open" | "closed" },
  ): Promise<void> {
    await this.request(`/issues/${issueNumber}`, { method: "PATCH", body: update });
  }

  public async addRecoveryComment(issueNumber: number, body: string): Promise<void> {
    await this.request(`/issues/${issueNumber}/comments`, { method: "POST", body: { body } });
  }

  public async closeIssue(issueNumber: number): Promise<void> {
    await this.updateIssue(issueNumber, { state: "closed" });
  }

  public async getWorkflowActivationMetadata(
    workflowFile: string,
  ): Promise<WorkflowActivationMetadata> {
    const workflow = await this.request<{
      state: string;
      created_at: string;
      updated_at?: string;
    }>(`/actions/workflows/${encodeURIComponent(workflowFile)}`);
    return workflow.updated_at
      ? {
          activatedAt: workflow.updated_at,
          state: workflow.state,
          source: "workflow-updated-at",
        }
      : {
          activatedAt: workflow.created_at,
          state: workflow.state,
          source: "workflow-created-at",
        };
  }
}
