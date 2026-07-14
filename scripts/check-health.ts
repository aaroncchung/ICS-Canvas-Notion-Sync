import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  FetchGitHubHealthClient,
  type GitHubHealthClient,
  type HealthIssue,
  type WorkflowActivationMetadata,
  type WorkflowRun,
} from "./github-health-client.js";

export const HEALTH_ISSUE_TITLE = "Canvas–Notion sync is unhealthy";
export const HEALTH_ISSUE_LABEL = "sync-failure";
export const HEALTH_MARKER = "<!-- canvas-notion-health:v1 -->";
export const DEFAULT_ACTIVATION_GRACE_HOURS = 14;
export const SUCCESS_WATCHDOG_HOURS = 12;
export const SCHEDULE_DELAY_GRACE_MINUTES = 60;
export const ACTIVE_RUN_GRACE_HOURS = 2;
const WORKFLOW_FILE = "sync.yml";
const RECOVERY_MARKER_PREFIX = "<!-- canvas-notion-health-recovery:v1:";
const EPISODE_MARKER_PATTERN = /<!-- canvas-notion-health-episode:v1:([a-f0-9]{16}) -->/;
const INCIDENT_START_MARKER_PATTERN = /<!-- canvas-notion-health-incident-start:v1:(.+?) -->/;
const LATEST_FAILURE_MARKER_PATTERN = /<!-- canvas-notion-health-latest-failure:v1:(\d+):(.+?) -->/;

export type HealthReasonCode =
  | "three_consecutive_unhealthy"
  | "no_success_12h"
  | "no_success_after_activation_grace"
  | "workflow_disabled";

export type ConclusionClass =
  | "success"
  | "unhealthy-completion"
  | "non-success-neutral"
  | "not-completed";

export interface HealthAssessment {
  unhealthy: boolean;
  reasonCodes: HealthReasonCode[];
  reasons: string[];
  relevantRuns: WorkflowRun[];
  scheduledRuns: WorkflowRun[];
  activation: WorkflowActivationMetadata;
  withinActivationGrace: boolean;
  deferredForActiveRun: boolean;
  latestScheduledSuccess?: WorkflowRun;
  latestQualifyingFailure?: WorkflowRun;
}

export interface HealthIncidentBoundary {
  startedAt: string;
  latestFailureRunId?: number;
  latestFailureCompletedAt?: string;
}

export interface HealthMonitorOptions {
  now?: Date;
  activationGraceHours?: number;
}

const UNHEALTHY_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "action_required",
  "startup_failure",
  "cancelled",
]);
const NEUTRAL_CONCLUSIONS = new Set(["neutral", "skipped", "stale"]);
const ACTIVE_STATUSES = new Set(["queued", "in_progress", "pending", "requested", "waiting"]);

export function classifyConclusion(run: WorkflowRun): ConclusionClass {
  if (run.status !== "completed") return "not-completed";
  if (run.conclusion === "success") return "success";
  if (run.conclusion && UNHEALTHY_CONCLUSIONS.has(run.conclusion)) {
    return "unhealthy-completion";
  }
  if (run.conclusion && NEUTRAL_CONCLUSIONS.has(run.conclusion)) {
    return "non-success-neutral";
  }
  return "non-success-neutral";
}

function timestamp(run: WorkflowRun): number {
  return Date.parse(run.completed_at ?? run.updated_at ?? run.run_started_at ?? run.created_at);
}

function completedAt(run: WorkflowRun): string {
  return run.completed_at ?? run.updated_at;
}

function sortedScheduledRuns(runs: WorkflowRun[]): WorkflowRun[] {
  return runs
    .filter((run) => run.event === "schedule")
    .sort((left, right) => timestamp(right) - timestamp(left));
}

function hasThreeConsecutiveFailures(runs: WorkflowRun[]): boolean {
  const completed = runs.filter((run) => run.status === "completed");
  if (completed.length < 3) return false;
  return completed.slice(0, 3).every((run) => classifyConclusion(run) === "unhealthy-completion");
}

function recentActiveRun(runs: WorkflowRun[], now: Date): boolean {
  return runs.some(
    (run) =>
      ACTIVE_STATUSES.has(run.status) &&
      now.getTime() - Date.parse(run.created_at) <= ACTIVE_RUN_GRACE_HOURS * 60 * 60 * 1000,
  );
}

export function assessScheduledHealth(
  runs: WorkflowRun[],
  activation: WorkflowActivationMetadata,
  now = new Date(),
  activationGraceHours = DEFAULT_ACTIVATION_GRACE_HOURS,
): HealthAssessment {
  const scheduledRuns = sortedScheduledRuns(runs);
  const completed = scheduledRuns.filter((run) => run.status === "completed");
  const latestSuccess = completed.find((run) => classifyConclusion(run) === "success");
  const latestQualifyingFailure = completed.find(
    (run) => classifyConclusion(run) === "unhealthy-completion",
  );
  const latestSuccessAge = latestSuccess ? now.getTime() - timestamp(latestSuccess) : undefined;
  const withinActivationGrace =
    now.getTime() - Date.parse(activation.activatedAt) < activationGraceHours * 60 * 60 * 1000;
  const activeRun = recentActiveRun(scheduledRuns, now);
  const reasonCodes: HealthReasonCode[] = [];
  const reasons: string[] = [];

  if (activation.state !== "active") {
    reasonCodes.push("workflow_disabled");
    reasons.push(
      `The scheduled sync workflow is not active (GitHub workflow state: ${activation.state}).`,
    );
  }

  if (activation.state === "active" && hasThreeConsecutiveFailures(scheduledRuns)) {
    reasonCodes.push("three_consecutive_unhealthy");
    reasons.push("The three most recent completed scheduled runs were qualifying failures.");
  }

  let deferredForActiveRun = false;
  if (activation.state === "active") {
    if (latestSuccess) {
      const age = latestSuccessAge ?? Number.POSITIVE_INFINITY;
      const watchdog = SUCCESS_WATCHDOG_HOURS * 60 * 60 * 1000;
      const scheduleGrace = SCHEDULE_DELAY_GRACE_MINUTES * 60 * 1000;
      if (age > watchdog) {
        if (activeRun || age <= watchdog + scheduleGrace) {
          deferredForActiveRun = true;
        } else {
          reasonCodes.push("no_success_12h");
          reasons.push(
            "No scheduled run has succeeded within the 12-hour watchdog and scheduler grace window.",
          );
        }
      }
    } else if (!withinActivationGrace) {
      if (activeRun) {
        deferredForActiveRun = true;
      } else {
        reasonCodes.push("no_success_after_activation_grace");
        reasons.push(
          "No scheduled run succeeded before the initial activation grace period ended.",
        );
      }
    }
  }

  return {
    unhealthy: reasonCodes.length > 0,
    reasonCodes,
    reasons,
    relevantRuns: scheduledRuns.slice(0, 5),
    scheduledRuns,
    activation,
    withinActivationGrace,
    deferredForActiveRun,
    ...(latestSuccess ? { latestScheduledSuccess: latestSuccess } : {}),
    ...(latestQualifyingFailure ? { latestQualifyingFailure } : {}),
  };
}

function incidentFromAssessment(assessment: HealthAssessment): HealthIncidentBoundary {
  const failures = assessment.scheduledRuns.filter(
    (run) => classifyConclusion(run) === "unhealthy-completion",
  );
  const latestFailure = failures[0];
  const triggeringFailures = assessment.reasonCodes.includes("three_consecutive_unhealthy")
    ? failures.slice(0, 3)
    : latestFailure
      ? [latestFailure]
      : [];
  const startedAt = triggeringFailures.length
    ? completedAt(triggeringFailures[triggeringFailures.length - 1]!)
    : assessment.activation.activatedAt;
  return {
    startedAt,
    ...(latestFailure
      ? {
          latestFailureRunId: latestFailure.id,
          latestFailureCompletedAt: completedAt(latestFailure),
        }
      : {}),
  };
}

export function parseHealthIncident(body: string | null): HealthIncidentBoundary | undefined {
  if (!body) return;
  const start = body.match(INCIDENT_START_MARKER_PATTERN)?.[1];
  if (!start || !Number.isFinite(Date.parse(start))) return;
  const failure = body.match(LATEST_FAILURE_MARKER_PATTERN);
  return {
    startedAt: start,
    ...(failure && Number.isFinite(Date.parse(failure[2]!))
      ? {
          latestFailureRunId: Number(failure[1]),
          latestFailureCompletedAt: failure[2],
        }
      : {}),
  };
}

function legacyIncident(issue: HealthIssue): HealthIncidentBoundary | undefined {
  if (!issue.body) return;
  const pattern =
    /Status \/ conclusion: completed \/ (failure|timed_out|action_required|startup_failure|cancelled)[\s\S]*?- Completed: ([^\r\n]+)/g;
  const failures = [...issue.body.matchAll(pattern)]
    .map((match) => match[2]!.trim())
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(right) - Date.parse(left));
  const boundary = failures[0] ?? issue.updated_at ?? issue.created_at;
  return boundary
    ? { startedAt: boundary, ...(failures[0] ? { latestFailureCompletedAt: failures[0] } : {}) }
    : undefined;
}

function advanceIncident(
  incident: HealthIncidentBoundary,
  assessment: HealthAssessment,
): HealthIncidentBoundary {
  const failure = assessment.latestQualifyingFailure;
  if (
    !failure ||
    (incident.latestFailureCompletedAt &&
      timestamp(failure) <= Date.parse(incident.latestFailureCompletedAt))
  ) {
    return incident;
  }
  return {
    ...incident,
    latestFailureRunId: failure.id,
    latestFailureCompletedAt: completedAt(failure),
  };
}

function episodeId(incident: HealthIncidentBoundary): string {
  const source = [
    incident.startedAt,
    incident.latestFailureRunId ?? "none",
    incident.latestFailureCompletedAt ?? "none",
  ].join("|");
  return createHash("sha256").update(source).digest("hex").slice(0, 16);
}

function value(value: string | number | null | undefined): string {
  return value === null || value === undefined || value === "" ? "n/a" : String(value);
}

export function renderHealthIssue(
  assessment: HealthAssessment,
  incident: HealthIncidentBoundary = incidentFromAssessment(assessment),
): string {
  const episode = episodeId(incident);
  const cause =
    assessment.reasonCodes.length > 1
      ? `Multiple conditions (${assessment.reasonCodes.join(", ")})`
      : assessment.reasonCodes[0];
  const lines = [
    HEALTH_MARKER,
    `<!-- canvas-notion-health-episode:v1:${episode} -->`,
    `<!-- canvas-notion-health-incident-start:v1:${incident.startedAt} -->`,
    ...(incident.latestFailureRunId !== undefined && incident.latestFailureCompletedAt
      ? [
          `<!-- canvas-notion-health-latest-failure:v1:${incident.latestFailureRunId}:${incident.latestFailureCompletedAt} -->`,
        ]
      : []),
    "## Scheduled sync health alert",
    "",
    `**Alert cause:** ${value(cause)}`,
    "",
    ...assessment.reasons.map((reason) => `- ${reason}`),
    "",
    "### Recent scheduled `sync.yml` runs",
    "",
  ];
  if (assessment.relevantRuns.length === 0) lines.push("No scheduled runs were found.");
  for (const run of assessment.relevantRuns) {
    lines.push(
      `#### [Run ${run.id}, attempt ${run.run_attempt}](${run.html_url})`,
      "",
      `- Workflow: ${value(run.name)}`,
      `- Event: ${value(run.event)}`,
      `- Status / conclusion: ${value(run.status)} / ${value(run.conclusion)}`,
      `- Branch: ${value(run.head_branch)}`,
      `- Commit: \`${value(run.head_sha)}\``,
      `- Created: ${value(run.created_at)}`,
      `- Started: ${value(run.run_started_at)}`,
      `- Completed: ${value(run.completed_at ?? (run.status === "completed" ? run.updated_at : undefined))}`,
      "",
    );
  }
  lines.push(
    `Activation reference: ${assessment.activation.activatedAt} (${assessment.activation.source}).`,
    "",
    "This report contains only workflow metadata. It excludes feed contents, assignment and Notion data, environment variables, logs, and authentication details.",
  );
  return lines.join("\n");
}

function matchingIssue(issues: HealthIssue[]): HealthIssue | undefined {
  return issues
    .filter((issue) => !issue.pull_request && issue.title === HEALTH_ISSUE_TITLE)
    .sort((left, right) => {
      const markerDifference =
        Number(Boolean(right.body?.includes(HEALTH_MARKER))) -
        Number(Boolean(left.body?.includes(HEALTH_MARKER)));
      return markerDifference || left.number - right.number;
    })[0];
}

async function ensureLabel(client: GitHubHealthClient): Promise<void> {
  if (await client.getLabel(HEALTH_ISSUE_LABEL)) return;
  await client.createLabel({
    name: HEALTH_ISSUE_LABEL,
    color: "B60205",
    description: "Automated scheduled sync health alert",
  });
}

function recoveryMarker(issue: HealthIssue): string {
  const episode = issue.body?.match(EPISODE_MARKER_PATTERN)?.[1] ?? "legacy";
  return `${RECOVERY_MARKER_PREFIX}${episode} -->`;
}

function successRecoversIncident(
  assessment: HealthAssessment,
  incident: HealthIncidentBoundary | undefined,
): boolean {
  const success = assessment.latestScheduledSuccess;
  if (!success || !incident) return false;
  const successAt = timestamp(success);
  const observedLatestFailureAt = assessment.latestQualifyingFailure
    ? timestamp(assessment.latestQualifyingFailure)
    : Number.NEGATIVE_INFINITY;
  const recordedLatestFailureAt = incident.latestFailureCompletedAt
    ? Date.parse(incident.latestFailureCompletedAt)
    : Number.NEGATIVE_INFINITY;
  return (
    success.status === "completed" &&
    success.event === "schedule" &&
    classifyConclusion(success) === "success" &&
    successAt > Date.parse(incident.startedAt) &&
    successAt > Math.max(observedLatestFailureAt, recordedLatestFailureAt)
  );
}

export async function monitorScheduledHealth(
  client: GitHubHealthClient,
  options: HealthMonitorOptions = {},
): Promise<HealthAssessment> {
  const now = options.now ?? new Date();
  const [runs, activation, issues] = await Promise.all([
    client.listWorkflowRuns(WORKFLOW_FILE),
    client.getWorkflowActivationMetadata(WORKFLOW_FILE),
    client.listMatchingIssues(HEALTH_ISSUE_LABEL),
  ]);
  const assessment = assessScheduledHealth(
    runs,
    activation,
    now,
    options.activationGraceHours ?? DEFAULT_ACTIVATION_GRACE_HOURS,
  );
  const issue = matchingIssue(issues);

  if (assessment.unhealthy) {
    await ensureLabel(client);
    const priorIncident = issue?.state === "open" ? parseHealthIncident(issue.body) : undefined;
    const incident = priorIncident
      ? advanceIncident(priorIncident, assessment)
      : incidentFromAssessment(assessment);
    const body = renderHealthIssue(assessment, incident);
    if (!issue) {
      await client.createIssue({
        title: HEALTH_ISSUE_TITLE,
        body,
        labels: [HEALTH_ISSUE_LABEL],
      });
    } else if (issue.state === "closed" || issue.body !== body) {
      await client.updateIssue(issue.number, {
        ...(issue.body === body ? {} : { body }),
        ...(issue.state === "closed" ? { state: "open" as const } : {}),
      });
    }
  } else if (issue?.state === "open") {
    const incident = parseHealthIncident(issue.body) ?? legacyIncident(issue);
    if (!successRecoversIncident(assessment, incident)) return assessment;
    const marker = recoveryMarker(issue);
    const comments = await client.listIssueComments(issue.number);
    if (!comments.some((comment) => comment.body?.includes(marker))) {
      await client.addRecoveryComment(
        issue.number,
        [
          marker,
          "A scheduled sync succeeded and the health check recovered. This issue is being closed.",
        ].join("\n"),
      );
    }
    await client.closeIssue(issue.number);
  }
  return assessment;
}

function positiveNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("HEALTH_ACTIVATION_GRACE_HOURS must be a positive number");
  }
  return parsed;
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const token = env.GITHUB_TOKEN;
  const repository = env.GITHUB_REPOSITORY;
  if (!token || !repository) {
    throw new Error("GITHUB_TOKEN and GITHUB_REPOSITORY are required");
  }
  const client = new FetchGitHubHealthClient({
    token,
    repository,
    ...(env.GITHUB_API_URL ? { apiUrl: env.GITHUB_API_URL } : {}),
  });
  await monitorScheduledHealth(client, {
    activationGraceHours: positiveNumber(
      env.HEALTH_ACTIVATION_GRACE_HOURS,
      DEFAULT_ACTIVATION_GRACE_HOURS,
    ),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Health check failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
