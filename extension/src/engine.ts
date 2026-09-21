import { ApiError, type Page, type SyncApi } from "./api.ts";
import {
  completion,
  alreadyHandled,
  id,
  note,
  object,
  record,
  targetKey,
  UserError,
  VerificationError,
  type Config,
  type Observation,
  type Report,
  type Target,
} from "./model.ts";

export class AccountMismatch extends VerificationError {
  constructor() {
    super("Canvas account changed. Verify your settings again before syncing.");
  }
}
export async function verifyAccount(config: Pick<Config, "userId">, api: SyncApi): Promise<void> {
  if ((await api.user()) !== config.userId) throw new AccountMismatch();
}
export interface ScanContext {
  api: SyncApi;
  /** Completion evidence already handled, by targetKey. Mutated here; saveAcknowledged persists it. */
  acknowledged: Record<string, string>;
  saveAcknowledged: () => Promise<void>;
  progress: (text: string) => void;
}
async function pages<T>(
  read: (cursor?: string) => Promise<Page<T>>,
  each: (items: T[]) => void,
): Promise<void> {
  let cursor: string | undefined;
  for (let count = 0; count < 100; count++) {
    const page = await read(cursor);
    each(page.items);
    if (!page.next) return;
    cursor = page.next;
  }
  throw new UserError("Canvas or Notion returned an implausible number of pages");
}
function trackable(all: Target[], report: Report): Target[] {
  const counts = new Map<string, number>();
  for (const target of all)
    if (target.assignmentId)
      counts.set(target.assignmentId, (counts.get(target.assignmentId) ?? 0) + 1);
  return all.filter((target) => {
    const reason = !target.assignmentId
      ? "No assignment identity"
      : target.conflict
        ? "Conflicting identity"
        : (counts.get(target.assignmentId) ?? 0) > 1
          ? "Duplicate assignment identity"
          : target.removed
            ? "Removed assignment"
            : undefined;
    if (reason) record(report, target, "skipped", reason);
    return !reason;
  });
}
async function observe(
  config: Config,
  targets: Target[],
  report: Report,
  { api, progress }: ScanContext,
): Promise<Map<string, Observation>> {
  const wanted = new Set(targets.map((target) => target.assignmentId));
  const found = new Set<string>();
  const observations = new Map<string, Observation>();
  const visited = new Set<string>();
  for (const enrollment of ["active", "completed"] as const) {
    // Past courses are read only while a tracked assignment is still unaccounted for.
    if (found.size === wanted.size) break;
    progress(`Finding ${enrollment} courses`);
    const courses: string[] = [];
    await pages(
      (cursor) => api.courses(enrollment, cursor),
      (items) => courses.push(...items),
    );
    for (const [index, courseId] of courses.entries()) {
      if (found.size === wanted.size) break;
      if (visited.has(courseId)) continue;
      visited.add(courseId);
      progress(`Checking ${enrollment} course ${index + 1} of ${courses.length}`);
      const seen = new Map<string, Observation | undefined>();
      try {
        await pages(
          (cursor) => api.assignments(courseId, cursor),
          (items) => {
            for (const raw of items) {
              const assignment = object(raw),
                assignmentId = id(assignment.id);
              if (
                assignmentId &&
                wanted.has(assignmentId) &&
                id(assignment.course_id) === courseId &&
                id(object(assignment.submission).assignment_id) === assignmentId
              )
                seen.set(assignmentId, completion(assignment.submission, courseId, config.userId));
            }
          },
        );
      } catch (error) {
        // Canvas answers 401 as well as 403 for a course this user may not read. If the session
        // itself has expired, nothing is observed and the next scan reports it.
        if (!(error instanceof ApiError) || ![401, 403, 404].includes(error.status)) throw error;
        // A partly read course cannot prove coverage, so none of it is kept.
        note(report, `Course ${courseId}`, "unchecked", `Not accessible (${error.message})`);
        continue;
      }
      for (const [assignmentId, observation] of seen) {
        found.add(assignmentId);
        if (observation) observations.set(assignmentId, observation);
      }
    }
  }
  return observations;
}
/**
 * One complete pass, held only in memory. It is safe to abandon at any point and run again:
 * handled evidence is saved after each page, and every page is reread before it is written.
 */
export async function scan(config: Config, report: Report, context: ScanContext): Promise<void> {
  const { api, acknowledged, saveAcknowledged, progress } = context;
  progress("Checking your Canvas account");
  await verifyAccount(config, api);
  await api.validateSchema();
  progress("Reading Notion assignments");
  const all: Target[] = [];
  await pages(
    (cursor) => api.targets(cursor),
    (items) => all.push(...items),
  );
  const targets = trackable(all, report);
  const observations = targets.length
    ? await observe(config, targets, report, context)
    : new Map<string, Observation>();
  progress("Comparing with Notion");
  let verifiedForWriting = false;
  for (const target of targets) {
    const observation = observations.get(target.assignmentId);
    const key = targetKey(target);
    if (!observation) {
      record(report, target, "unchecked", "No accessible submission record");
    } else if (target.courseId && observation.courseId !== target.courseId) {
      record(report, target, "skipped", "Conflicting course identity");
    } else if (!observation.eligible) {
      record(report, target, "skipped", observation.reason);
    } else if (alreadyHandled(acknowledged[key], observation.evidence)) {
      record(report, target, "skipped", "Already handled; preserving your status");
    } else {
      const current = await api.target(target.pageId);
      if (
        !current ||
        current.removed ||
        current.conflict ||
        current.uid !== target.uid ||
        current.assignmentId !== target.assignmentId ||
        (current.courseId && current.courseId !== observation.courseId)
      ) {
        record(report, target, "skipped", "Destination changed or is no longer eligible");
      } else if (report.mode === "preview") {
        const done = current.status === "Done";
        record(
          report,
          target,
          done ? "skipped" : "eligible",
          done ? "Already Done" : observation.reason,
        );
      } else if (current.status === "Done") {
        acknowledged[key] = observation.evidence;
        await saveAcknowledged();
        record(report, target, "skipped", "Already Done");
      } else {
        if (!verifiedForWriting) await verifyAccount(config, api);
        verifiedForWriting = true;
        try {
          await api.markDone(target.pageId);
        } catch (error) {
          // Notion refusing this page is reported. Anything transient ends the scan instead; the
          // page is not acknowledged, so the next scan rereads it and writes again.
          if (
            !(error instanceof ApiError) ||
            error.retryable ||
            error.status === 401 ||
            error.status < 400
          )
            throw error;
          record(report, target, "failed", error.message);
          continue;
        }
        acknowledged[key] = observation.evidence;
        await saveAcknowledged();
        record(report, target, "updated", observation.reason);
      }
    }
  }
}

/** Serializes scans and every storage write; no locks survive a terminated worker. */
export function serialExecutor(): <T>(action: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (action) => {
    const next = tail.then(action);
    tail = next.catch(() => undefined);
    return next;
  };
}
