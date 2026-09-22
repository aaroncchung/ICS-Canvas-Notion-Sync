import { canvasAssignmentIdFromUid } from "../../src/canvas/assignment-uid.ts";
import { canvasAssignmentUrlIdentity } from "../../src/canvas/canvas-url.ts";
import { titleWithoutCourseLabel } from "../../src/canvas/summary-title.ts";
import {
  pageProperties,
  readCheckbox,
  readRichText,
  readSelect,
  readTitle,
  readUrl,
} from "../../src/notion/property-helpers.ts";

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
  /** The assignment's name in Canvas. It must match the Notion title before anything is written. */
  name: string;
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
  /** Rows left out of `details` once it was full. */
  omitted?: number;
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
/**
 * Something only the user can put right: the signed-in Canvas user or the Notion schema no longer
 * matches what was verified, or the integration may not write. It turns automatic sync off.
 */
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
/** The origin of a bare HTTPS origin such as https://canvas.school.edu, or nothing. */
export function canvasOrigin(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    const bare =
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash;
    return bare ? url.origin : undefined;
  } catch {
    return;
  }
}
/** Notion IDs are accepted with or without dashes and in either case; Notion answers in lowercase. */
export function notionId(value: string): string {
  return value.replaceAll("-", "").toLowerCase();
}
/**
 * Whether a Notion title is what the importer would have written for a Canvas assignment name.
 * The feed gives the name followed by a " [Course]" label, which the importer strips. Where a feed
 * omits the label, a name that itself ends in brackets loses them instead, so that form of the
 * name counts as well. A page whose title is neither was not imported from that assignment.
 */
export function sameTitle(title: string, name: string): boolean {
  const key = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
  return (
    key(title) !== "" &&
    (key(title) === key(name) || key(title) === key(titleWithoutCourseLabel(name)))
  );
}
export function targetFromPage(value: unknown): Target | undefined {
  const page = object(value),
    p = pageProperties(page);
  if (typeof page.id !== "string" || readSelect(p, "Imported From") !== "Canvas ICS") return;
  const uid = readRichText(p, "Canvas UID") ?? "";
  const uidId = canvasAssignmentIdFromUid(uid);
  // Assignment pages hold no course ID of their own, so an assignment URL is its only source.
  const route = canvasAssignmentUrlIdentity(readUrl(p, "Canvas URL") ?? "");
  const assignmentId = uidId ?? route?.assignmentId ?? "";
  return {
    pageId: page.id,
    uid,
    title: readTitle(p, "Assignment"),
    assignmentId: uid ? assignmentId : "",
    ...(route ? { courseId: route.courseId } : {}),
    status: scalarText(object(object(p["Personal Status"]).status).name),
    removed:
      page.archived === true ||
      page.in_trash === true ||
      readCheckbox(p, "Removed from Canvas") ||
      readSelect(p, "Canvas State") === "Removed",
    conflict: Boolean(uidId && route && uidId !== route.assignmentId),
  };
}
export function completion(
  value: unknown,
  courseId: string,
  userId: string,
  name = "",
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
  // Complete/incomplete and pass/fail work is graded "complete" or "incomplete". An incomplete
  // arrives with a score of 0 but says the work is still owed, so it does not count as a grade.
  const grade = typeof s.grade === "string" ? s.grade.trim().toLowerCase() : "";
  const incomplete = grade === "incomplete";
  const graded =
    !incomplete && (grade !== "" || (typeof s.score === "number" && Number.isFinite(s.score)));
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
    name,
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
                : incomplete
                  ? "Marked incomplete"
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
const MAX_DETAILS = 100;
/** Lower is kept longer: rows that need reading outrank the routine skips that fill most scans. */
const RANK: Record<string, number> = { failed: 0, updated: 1, eligible: 1, unchecked: 2 };
const ROUTINE = 3;
/**
 * A diagnostic row that is not an assignment, so it does not change the totals. Once the list is
 * full, a row is kept only by dropping the newest row that matters less than it does.
 */
export function note(
  report: Report,
  title: string,
  outcome: Outcome,
  reason: string,
  rank = RANK[outcome] ?? ROUTINE,
): void {
  const row = { title: title.slice(0, 200), outcome, reason };
  if (report.details.length < MAX_DETAILS) {
    report.details.push(row);
    return;
  }
  report.omitted = (report.omitted ?? 0) + 1;
  let evict = -1,
    worst = rank;
  for (const [index, detail] of report.details.entries()) {
    const other = RANK[detail.outcome] ?? ROUTINE;
    if (other > rank && other >= worst) [evict, worst] = [index, other];
  }
  if (evict < 0) return;
  report.details.splice(evict, 1);
  report.details.push(row);
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
