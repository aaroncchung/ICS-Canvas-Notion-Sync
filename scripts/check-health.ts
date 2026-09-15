import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

export const HEALTH_ISSUE_TITLE = "Canvas–Notion sync is unhealthy";
export const HEALTH_ISSUE_LABEL = "sync-failure";
export const DEFAULT_ACTIVATION_GRACE_HOURS = 14;
/** A 12-hour watchdog plus one hour of scheduler delay. */
export const SUCCESS_WATCHDOG_HOURS = 13;
export const ACTIVE_RUN_GRACE_HOURS = 2;
const WORKFLOW_FILE = "sync.yml";
const RUNS_SHOWN = 5;
const PAGE_SIZE = 100;
const MAX_ISSUE_PAGES = 10;
/** GitHub asks for at least a minute before retrying a rate-limited request that carries no timing headers. */
const MIN_RATE_LIMIT_WAIT_MS = 60_000;
/** Total time one request may spend waiting on rate limits; the health workflow itself times out after ten minutes. */
const MAX_RATE_LIMIT_WAIT_MS = 5 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

export interface WorkflowRun {
  id: number;
  run_attempt: number;
  event: string;
  status: string;
  conclusion: string | null;
  head_sha: string;
  created_at: string;
  updated_at: string;
  html_url: string;
}

export interface Workflow {
  state: string;
  created_at: string;
  updated_at?: string;
}

export interface HealthIssue {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  pull_request?: unknown;
}

export interface HealthAssessment {
  /** Empty when the scheduled sync is healthy. */
  reasons: string[];
  /** Scheduled runs only, newest first. */
  runs: WorkflowRun[];
  workflow: Workflow;
  latestSuccess?: WorkflowRun;
  latestFailure?: WorkflowRun;
}

/** Sends one REST request scoped to the repository; `path` follows `/repos/{owner}/{repo}`. */
export type GitHubRequest = (
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
) => Promise<unknown>;

const FAILURE_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "action_required",
  "startup_failure",
  "cancelled",
]);
const ACTIVE_STATUSES = new Set(["queued", "in_progress", "pending", "requested", "waiting"]);

const isCompleted = (run: WorkflowRun): boolean => run.status === "completed";
const isSuccess = (run: WorkflowRun): boolean => isCompleted(run) && run.conclusion === "success";
const isFailure = (run: WorkflowRun): boolean =>
  isCompleted(run) && run.conclusion !== null && FAILURE_CONCLUSIONS.has(run.conclusion);
const updatedAt = (run: WorkflowRun): number => Date.parse(run.updated_at);
const activatedAt = (workflow: Workflow): string => workflow.updated_at ?? workflow.created_at;

export function assessScheduledHealth(
  allRuns: WorkflowRun[],
  workflow: Workflow,
  now = new Date(),
  activationGraceHours = DEFAULT_ACTIVATION_GRACE_HOURS,
): HealthAssessment {
  const runs = allRuns
    .filter((run) => run.event === "schedule")
    .sort((left, right) => updatedAt(right) - updatedAt(left));
  const completed = runs.filter(isCompleted);
  const latestSuccess = completed.find(isSuccess);
  const latestFailure = completed.find(isFailure);
  const reasons: string[] = [];

  if (workflow.state !== "active") {
    reasons.push(`The scheduled sync workflow is not active (GitHub state: ${workflow.state}).`);
  } else {
    if (completed.length >= 3 && completed.slice(0, 3).every(isFailure)) {
      reasons.push("The three most recent completed scheduled runs failed.");
    }
    const activeRun = runs.some(
      (run) =>
        ACTIVE_STATUSES.has(run.status) &&
        now.getTime() - Date.parse(run.created_at) <= ACTIVE_RUN_GRACE_HOURS * HOUR,
    );
    const deadline = latestSuccess
      ? updatedAt(latestSuccess) + SUCCESS_WATCHDOG_HOURS * HOUR
      : Date.parse(activatedAt(workflow)) + activationGraceHours * HOUR;
    if (now.getTime() >= deadline && !activeRun) {
      reasons.push(
        latestSuccess
          ? `No scheduled run has succeeded in the last ${SUCCESS_WATCHDOG_HOURS} hours.`
          : `No scheduled run has succeeded within ${activationGraceHours} hours of workflow activation.`,
      );
    }
  }

  return {
    reasons,
    runs,
    workflow,
    ...(latestSuccess ? { latestSuccess } : {}),
    ...(latestFailure ? { latestFailure } : {}),
  };
}

/** Healthy, and a scheduled success is strictly newer than every scheduled failure. */
export function recoveredFromIncident(assessment: HealthAssessment): boolean {
  const { reasons, latestSuccess, latestFailure } = assessment;
  return (
    reasons.length === 0 &&
    latestSuccess !== undefined &&
    (latestFailure === undefined || updatedAt(latestSuccess) > updatedAt(latestFailure))
  );
}

export function renderHealthIssue(assessment: HealthAssessment): string {
  const lines = [
    "## Scheduled sync health alert",
    "",
    ...assessment.reasons.map((reason) => `- ${reason}`),
    "",
    "### Recent scheduled `sync.yml` runs",
    "",
  ];
  if (assessment.runs.length === 0) {
    lines.push("No scheduled runs were found.");
  } else {
    lines.push(
      "| Run | Status | Conclusion | Commit | Created | Updated |",
      "| --- | --- | --- | --- | --- | --- |",
      ...assessment.runs
        .slice(0, RUNS_SHOWN)
        .map(
          (run) =>
            `| [${run.id} (attempt ${run.run_attempt})](${run.html_url}) | ${run.status} | ${run.conclusion ?? "n/a"} | \`${run.head_sha.slice(0, 7)}\` | ${run.created_at} | ${run.updated_at} |`,
        ),
    );
  }
  lines.push(
    "",
    `Workflow state: ${assessment.workflow.state}, last activated ${activatedAt(assessment.workflow)}.`,
    "",
    "This report contains only workflow metadata. It excludes feed contents, assignment and Notion data, environment variables, logs, and authentication details.",
  );
  return lines.join("\n");
}

export class GitHubApiError extends Error {
  public readonly status: number | undefined;

  public constructor(message: string, status?: number) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
  }
}

export interface GitHubRequestOptions {
  token: string;
  repository: string;
  apiUrl?: string;
  fetch?: typeof fetch;
  attempts?: number;
  sleep?: (milliseconds: number) => Promise<unknown>;
  /** Current time in milliseconds, used to wait until `x-ratelimit-reset`. */
  now?: () => number;
}

/**
 * How long GitHub asks the client to wait: the full `Retry-After`, otherwise until `x-ratelimit-reset`
 * when the quota is exhausted, otherwise the documented one-minute minimum.
 */
function rateLimitWaitMs(headers: Headers, now: number): number {
  const retryAfterSeconds = Number(headers.get("retry-after"));
  if (retryAfterSeconds > 0) return retryAfterSeconds * 1000;
  const resetSeconds = Number(headers.get("x-ratelimit-reset"));
  if (headers.get("x-ratelimit-remaining") === "0" && resetSeconds > 0) {
    return Math.max(resetSeconds * 1000 - now, 1000);
  }
  return MIN_RATE_LIMIT_WAIT_MS;
}

/**
 * Reads and idempotent updates retry transient failures; errors never echo the token or response body.
 * Rate limits are honored in full, and a wait that would exceed the budget fails the request instead.
 */
export function createGitHubRequest(options: GitHubRequestOptions): GitHubRequest {
  const apiUrl = (options.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
  const fetchImpl = options.fetch ?? fetch;
  const attempts = options.attempts ?? 3;
  const sleep = options.sleep ?? delay;
  const now = options.now ?? Date.now;
  return async (method, path, body) => {
    let waitedMs = 0;
    for (let attempt = 1; ; attempt += 1) {
      let response: Response | undefined;
      try {
        response = await fetchImpl(`${apiUrl}/repos/${options.repository}${path}`, {
          method,
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${options.token}`,
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "canvas-notion-health-check",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch {
        response = undefined;
      }
      if (response?.ok) {
        return response.status === 204 ? undefined : ((await response.json()) as unknown);
      }
      const status = response?.status;
      // GitHub signals secondary rate limits with 403 as well as 429.
      const rateLimited =
        status === 429 ||
        (status === 403 &&
          (Number(response?.headers.get("retry-after")) > 0 ||
            response?.headers.get("x-ratelimit-remaining") === "0"));
      const transient = status === undefined || rateLimited || status >= 500;
      const waitMs =
        rateLimited && response ? rateLimitWaitMs(response.headers, now()) : attempt * 1000;
      const withinBudget = waitedMs + waitMs <= MAX_RATE_LIMIT_WAIT_MS;
      if (method !== "POST" && transient && attempt < attempts && withinBudget) {
        await sleep(waitMs);
        waitedMs += waitMs;
        continue;
      }
      const endpoint = `${method} ${path.split("?")[0]}`;
      const hint = rateLimited
        ? withinBudget
          ? "; rate limited"
          : `; rate limited for ${Math.ceil(waitMs / 1000)}s, longer than the ${MAX_RATE_LIMIT_WAIT_MS / 1000}s wait budget`
        : status === 401 || status === 403
          ? "; check the workflow token permissions"
          : "";
      throw new GitHubApiError(
        status === undefined
          ? `GitHub API ${endpoint} failed before receiving a response`
          : `GitHub API ${endpoint} failed with status ${status}${hint}`,
        status,
      );
    }
  };
}

async function ensureLabel(request: GitHubRequest): Promise<void> {
  try {
    await request("POST", "/labels", {
      name: HEALTH_ISSUE_LABEL,
      color: "B60205",
      description: "Automated scheduled sync health alert",
    });
  } catch (error) {
    if (!(error instanceof GitHubApiError && error.status === 422)) throw error;
  }
}

export interface HealthMonitorOptions {
  now?: Date;
  activationGraceHours?: number;
}

/** Every labeled issue, paginated so an old durable issue is never hidden behind newer ones. */
async function listLabeledIssues(request: GitHubRequest): Promise<HealthIssue[]> {
  const issues: HealthIssue[] = [];
  for (let page = 1; page <= MAX_ISSUE_PAGES; page += 1) {
    const result = (await request(
      "GET",
      `/issues?state=all&labels=${HEALTH_ISSUE_LABEL}&per_page=${PAGE_SIZE}&page=${page}`,
    )) as HealthIssue[];
    issues.push(...result);
    if (result.length < PAGE_SIZE) break;
  }
  return issues;
}

export async function monitorScheduledHealth(
  request: GitHubRequest,
  options: HealthMonitorOptions = {},
): Promise<HealthAssessment> {
  const [runs, workflow, issues] = (await Promise.all([
    request("GET", `/actions/workflows/${WORKFLOW_FILE}/runs?event=schedule&per_page=100`),
    request("GET", `/actions/workflows/${WORKFLOW_FILE}`),
    listLabeledIssues(request),
  ])) as [{ workflow_runs: WorkflowRun[] }, Workflow, HealthIssue[]];
  const assessment = assessScheduledHealth(
    runs.workflow_runs,
    workflow,
    options.now,
    options.activationGraceHours,
  );
  const issue = issues
    .filter((candidate) => !candidate.pull_request && candidate.title === HEALTH_ISSUE_TITLE)
    .sort((left, right) => left.number - right.number)[0];

  if (assessment.reasons.length > 0) {
    const body = renderHealthIssue(assessment);
    if (!issue) {
      await ensureLabel(request);
      await request("POST", "/issues", {
        title: HEALTH_ISSUE_TITLE,
        body,
        labels: [HEALTH_ISSUE_LABEL],
      });
    } else if (issue.state === "closed" || issue.body?.replace(/\r\n/g, "\n") !== body) {
      await request("PATCH", `/issues/${issue.number}`, { state: "open", body });
    }
  } else if (issue?.state === "open" && recoveredFromIncident(assessment)) {
    const success = assessment.latestSuccess!;
    // Close first so a failed comment can never cause a duplicate comment on the next check.
    await request("PATCH", `/issues/${issue.number}`, {
      state: "closed",
      state_reason: "completed",
    });
    await request("POST", `/issues/${issue.number}/comments`, {
      body: `Scheduled run [${success.id}](${success.html_url}) succeeded after the last failure, so the health check closed this issue.`,
    });
  }
  return assessment;
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repository } = env;
  if (!token || !repository) throw new Error("GITHUB_TOKEN and GITHUB_REPOSITORY are required");
  const grace = env.HEALTH_ACTIVATION_GRACE_HOURS?.trim();
  const activationGraceHours = grace ? Number(grace) : DEFAULT_ACTIVATION_GRACE_HOURS;
  if (!Number.isFinite(activationGraceHours) || activationGraceHours <= 0) {
    throw new Error("HEALTH_ACTIVATION_GRACE_HOURS must be a positive finite number");
  }
  const request = createGitHubRequest({
    token,
    repository,
    ...(env.GITHUB_API_URL ? { apiUrl: env.GITHUB_API_URL } : {}),
  });
  const assessment = await monitorScheduledHealth(request, { activationGraceHours });
  console.log(
    assessment.reasons.length === 0
      ? "Scheduled sync is healthy."
      : `Scheduled sync is unhealthy:\n${assessment.reasons.map((reason) => `- ${reason}`).join("\n")}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Health check failed"}\n`);
    process.exitCode = 1;
  }
}
