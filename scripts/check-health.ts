import { pathToFileURL } from "node:url";

interface WorkflowRun {
  id: number;
  html_url: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  updated_at?: string;
}

export interface HealthAssessment {
  unhealthy: boolean;
  reasons: string[];
  relevantRuns: WorkflowRun[];
}

export function assessScheduledHealth(runs: WorkflowRun[], now = new Date()): HealthAssessment {
  const completed = runs.filter((run) => run.status === "completed");
  const consecutiveFailures = completed.slice(0, 3);
  const threeFailed =
    consecutiveFailures.length === 3 &&
    consecutiveFailures.every((run) => run.conclusion !== "success");
  const latestSuccess = completed.find((run) => run.conclusion === "success");
  const staleSuccess =
    !latestSuccess ||
    now.getTime() - Date.parse(latestSuccess.updated_at ?? latestSuccess.created_at) >
      12 * 60 * 60 * 1000;
  const reasons: string[] = [];
  if (threeFailed) reasons.push("The three most recent completed scheduled runs did not succeed.");
  if (staleSuccess) reasons.push("No scheduled run has succeeded within the previous 12 hours.");
  return { unhealthy: reasons.length > 0, reasons, relevantRuns: completed.slice(0, 5) };
}

async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!token || !repository) throw new Error("GITHUB_TOKEN and GITHUB_REPOSITORY are required");
  const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "canvas-notion-health-check",
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  if (!response.ok) throw new Error(`GitHub API request failed with status ${response.status}`);
  return (await response.json()) as T;
}

async function ensureLabel(): Promise<void> {
  try {
    await api("/labels/sync-failure");
  } catch {
    await api("/labels", {
      method: "POST",
      body: { name: "sync-failure", color: "B60205", description: "Automated sync health alert" },
    });
  }
}

async function main(): Promise<void> {
  const response = await api<{ workflow_runs: WorkflowRun[] }>(
    "/actions/workflows/sync.yml/runs?event=schedule&per_page=20",
  );
  const assessment = assessScheduledHealth(response.workflow_runs);
  const issues = await api<Array<{ number: number; title: string }>>(
    "/issues?state=open&labels=sync-failure&per_page=100",
  );
  const issue = issues.find((candidate) => candidate.title === "Canvas–Notion sync is unhealthy");
  if (assessment.unhealthy) {
    await ensureLabel();
    const body = [
      "The scheduled Canvas–Notion sync is unhealthy.",
      "",
      ...assessment.reasons.map((reason) => `- ${reason}`),
      "",
      "Recent scheduled runs:",
      ...assessment.relevantRuns.map(
        (run) => `- [Run ${run.id}](${run.html_url}): ${run.conclusion ?? run.status}`,
      ),
      "",
      "This report contains only workflow metadata; feed contents and secrets are never included.",
    ].join("\n");
    if (issue) {
      await api(`/issues/${issue.number}`, { method: "PATCH", body: { body } });
    } else {
      await api("/issues", {
        method: "POST",
        body: { title: "Canvas–Notion sync is unhealthy", body, labels: ["sync-failure"] },
      });
    }
  } else if (issue) {
    await api(`/issues/${issue.number}/comments`, {
      method: "POST",
      body: { body: "A scheduled sync succeeded and the health check has recovered." },
    });
    await api(`/issues/${issue.number}`, { method: "PATCH", body: { state: "closed" } });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
