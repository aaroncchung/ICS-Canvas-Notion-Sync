import { canvasAssignmentIdFromUid } from "../../src/canvas/assignment-uid.ts";
import { canvasAssignmentUrlIdentity } from "../../src/canvas/canvas-url.ts";

export interface Config {
  origin: string;
  token: string;
  dataSourceId: string;
  userId: string;
  enabled: boolean;
}
export interface Target {
  pageId: string;
  uid: string;
  title: string;
  assignmentId: string;
  courseId?: string;
  status: string;
  removed: boolean;
  conflict: boolean;
}
export interface Observation {
  courseId: string;
  eligible: boolean;
  evidence: string;
  reason: string;
}
export interface Detail {
  title: string;
  outcome: string;
  reason: string;
}
export interface Report {
  mode: "preview" | "sync";
  startedAt: string;
  finishedAt?: string;
  updated: number;
  eligible: number;
  skipped: number;
  unchecked: number;
  failed: number;
  details: Detail[];
}
/** Scans live only in worker memory; an interrupted scan is simply rerun from the start. */
export interface State {
  config?: Config;
  report?: Report;
  acknowledged: Record<string, string>;
  previewReady: boolean;
  nextScanAt: number;
  error?: string;
}
export const emptyState = (): State => ({
  acknowledged: {},
  previewReady: false,
  nextScanAt: 0,
});
/** An error whose message is safe and useful to show in the popup. */
export class UserError extends Error {}
/** The signed-in Canvas user or the Notion schema no longer matches what was verified. */
export class VerificationError extends UserError {}
export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function scalarText(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
export function id(value: unknown): string | undefined {
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return;
}
function rich(value: unknown, kind: string): string {
  const parts: unknown = object(value)[kind];
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part: unknown) => {
      const p = object(part);
      return typeof p.plain_text === "string" ? p.plain_text : scalarText(object(p.text).content);
    })
    .join("");
}
export function targetFromPage(value: unknown): Target | undefined {
  const page = object(value),
    p = object(page.properties);
  if (
    typeof page.id !== "string" ||
    object(p["Imported From"]).type !== "select" ||
    object(object(p["Imported From"]).select).name !== "Canvas ICS"
  )
    return;
  const uid = rich(p["Canvas UID"], "rich_text");
  const uidId = canvasAssignmentIdFromUid(uid);
  const url = object(p["Canvas URL"]).url;
  const route = typeof url === "string" ? canvasAssignmentUrlIdentity(url) : undefined;
  const courseId = id(rich(p["Canvas Course ID"], "rich_text")) ?? route?.courseId;
  const assignmentId = uidId ?? route?.assignmentId ?? "";
  return {
    pageId: page.id,
    uid,
    title: rich(p.Assignment, "title").slice(0, 200),
    assignmentId: uid ? assignmentId : "",
    ...(courseId ? { courseId } : {}),
    status: scalarText(object(object(p["Personal Status"]).status).name),
    removed:
      page.archived === true ||
      page.in_trash === true ||
      object(p["Removed from Canvas"]).checkbox === true ||
      object(object(p["Canvas State"]).select).name === "Removed",
    conflict:
      Boolean(uidId && route && uidId !== route.assignmentId) ||
      Boolean(courseId && route && courseId !== route.courseId),
  };
}
export function completion(
  value: unknown,
  courseId: string,
  userId: string,
): Observation | undefined {
  const s = object(value);
  if (
    id(s.user_id) !== userId ||
    !["unsubmitted", "submitted", "pending_review", "graded"].includes(String(s.workflow_state))
  )
    return;
  for (const field of ["missing", "excused", "redo_request"]) {
    if (s[field] !== undefined && s[field] !== null && typeof s[field] !== "boolean") return;
  }
  const submittedAt =
    typeof s.submitted_at === "string" && Number.isFinite(Date.parse(s.submitted_at))
      ? s.submitted_at
      : "";
  const submitted = Boolean(submittedAt) || s.workflow_state === "submitted";
  const graded =
    (typeof s.grade === "string" && s.grade.trim() !== "") ||
    (typeof s.score === "number" && Number.isFinite(s.score));
  const missing = s.missing === true || s.late_policy_status === "missing";
  const eligible =
    s.redo_request !== true && (submitted || s.excused === true || (graded && !missing));
  // Grading/excusal changes do not create new evidence for the same attempt.
  const attempt = id(s.attempt);
  const evidence = attempt
    ? `attempt:${attempt}`
    : submittedAt
      ? `submitted:${submittedAt}`
      : "completion";
  return {
    courseId,
    eligible,
    evidence,
    reason:
      s.redo_request === true
        ? "Redo requested"
        : s.excused === true
          ? "Excused"
          : submitted
            ? "Submitted"
            : graded && !missing
              ? "Graded"
              : missing
                ? "Missing work"
                : "No completion evidence",
  };
}
export function targetKey(target: Target): string {
  return `${target.pageId}:${target.assignmentId}`;
}
export function alreadyHandled(previous: string | undefined, evidence: string): boolean {
  if (!previous) return false;
  if (previous === evidence || evidence === "completion") return true;
  if (previous.startsWith("attempt:") && evidence.startsWith("attempt:")) {
    return BigInt(evidence.slice(8)) <= BigInt(previous.slice(8));
  }
  if (previous.startsWith("submitted:") && evidence.startsWith("submitted:")) {
    return Date.parse(evidence.slice(10)) <= Date.parse(previous.slice(10));
  }
  return false;
}
export function newReport(mode: Report["mode"], now: number): Report {
  return {
    mode,
    startedAt: new Date(now).toISOString(),
    updated: 0,
    eligible: 0,
    skipped: 0,
    unchecked: 0,
    failed: 0,
    details: [],
  };
}
type Outcome = keyof Pick<Report, "updated" | "eligible" | "skipped" | "unchecked" | "failed">;
/** A diagnostic row that is not an assignment, so it does not change the totals. */
export function note(report: Report, title: string, outcome: Outcome, reason: string): void {
  if (report.details.length < 100) report.details.push({ title, outcome, reason });
}
export function record(
  report: Report,
  target: Pick<Target, "title">,
  outcome: Outcome,
  reason: string,
): void {
  report[outcome]++;
  note(report, target.title, outcome, reason);
}
