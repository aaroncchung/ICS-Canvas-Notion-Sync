import { ApiError, ASSIGNMENTS_PER_REQUEST, type Page, type SyncApi } from "./api.ts";
import {
  completion,
  alreadyHandled,
  id,
  note,
  object,
  record,
  sameTitle,
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
/** Notion let the page be read but not updated, which no later scan can fix by itself. */
export class WriteAccessDenied extends VerificationError {
  constructor() {
    super(
      "Notion refused the update. Give the integration Update content access, then verify your settings again.",
    );
  }
}
export async function verifyAccount(config: Pick<Config, "userId">, api: SyncApi): Promise<void> {
  if ((await api.user()) !== config.userId) throw new AccountMismatch();
}
/** A failure that says something about one course only, so the other courses are still read. */
function confinedToCourse(error: unknown): error is UserError {
  if (!(error instanceof UserError) || error instanceof VerificationError) return false;
  // Pagination faults are plain UserErrors. An outage or throttling is not about this course.
  return !(error instanceof ApiError) || (error.status !== 0 && !error.throttled);
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
  // A page with an assignment URL names its course, so only that course is asked, and only for
  // those assignments. The rest are looked for in every course's full listing.
  const named = new Map<string, string[]>();
  const unplaced = new Set<string>();
  for (const { assignmentId, courseId } of targets) {
    if (courseId) named.set(courseId, [...(named.get(courseId) ?? []), assignmentId]);
    else unplaced.add(assignmentId);
  }
  const found = new Set<string>();
  const missing = () => [...unplaced].some((assignmentId) => !found.has(assignmentId));
  const observations = new Map<string, Observation>();
  /** Courses whose full listing was tried, so the walk does not read them again. */
  const listed = new Set<string>();
  let readAny = false;
  /** Whether some course listing or course was tried and could not be read, for any reason. */
  let failedAny = false;
  let fault: UserError | undefined;
  /** Reads one course's assignments, or with `ids` only those, keeping what is said of `wanted`. */
  const read = (
    courseId: string,
    wanted: ReadonlySet<string>,
    seen: Map<string, Observation | undefined>,
    ids?: string[],
  ) =>
    pages(
      (cursor) => api.assignments(courseId, cursor, ids),
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
            seen.set(
              assignmentId,
              completion(
                assignment.submission,
                courseId,
                config.userId,
                typeof assignment.name === "string" ? assignment.name : "",
              ),
            );
        }
      },
    );
  /** Keeps what one course showed, or notes why it could not be read and keeps none of it. */
  const check = async (
    courseId: string,
    reading: (seen: Map<string, Observation | undefined>) => Promise<void>,
  ): Promise<void> => {
    const seen = new Map<string, Observation | undefined>();
    try {
      await reading(seen);
    } catch (error) {
      if (!confinedToCourse(error)) throw error;
      const status = error instanceof ApiError ? error.status : 0;
      // Canvas answers 401 as well as 403 for a course this user may not read, but 401 is also
      // what an expired session looks like. Asking who is signed in tells them apart: it throws,
      // ending the scan, unless the session is still good.
      if (status === 401) await verifyAccount(config, api);
      const refused = [401, 403, 404].includes(status);
      failedAny = true;
      if (!refused) fault = error;
      // A partly read course cannot prove coverage, so none of it is kept.
      note(
        report,
        `Course ${courseId}`,
        "unchecked",
        `${refused ? "Not accessible" : "Could not be read"} (${error.message})`,
      );
      return;
    }
    readAny = true;
    for (const [assignmentId, observation] of seen) {
      found.add(assignmentId);
      if (observation) observations.set(assignmentId, observation);
    }
  };
  for (const [index, [courseId, ids]] of [...named].entries()) {
    progress(`Checking course ${index + 1} of ${named.size}`);
    const wanted = new Set(ids);
    await check(courseId, async (seen) => {
      try {
        for (let start = 0; start < ids.length; start += ASSIGNMENTS_PER_REQUEST)
          await read(courseId, wanted, seen, ids.slice(start, start + ASSIGNMENTS_PER_REQUEST));
      } catch (error) {
        // Canvas refuses the whole request when one ID is not in this course, as when an
        // assignment has moved. The full listing still holds the others, and any unplaced ones.
        if (!(error instanceof ApiError) || error.status !== 400) throw error;
        seen.clear();
        listed.add(courseId);
        await read(courseId, new Set([...ids, ...unplaced]), seen);
      }
    });
  }
  for (const enrollment of ["active", "completed"] as const) {
    // Courses are listed only for pages that name none, and past courses only while one of those
    // is still unaccounted for.
    if (!missing()) break;
    progress(`Finding ${enrollment} courses`);
    const courses: string[] = [];
    try {
      await pages(
        (cursor) => api.courses(enrollment, cursor),
        (items) => courses.push(...items),
      );
    } catch (error) {
      // Without the active courses there is nothing to go on. Past courses are an extra, so a
      // listing that keeps failing costs only them, not what the active courses already showed.
      if (enrollment === "active" || !confinedToCourse(error)) throw error;
      const status = error instanceof ApiError ? error.status : 0;
      if (status === 401) await verifyAccount(config, api);
      // Still a fault if it turns out that no course was read at all.
      failedAny = true;
      if (![401, 403, 404].includes(status)) fault = error;
      note(report, "Completed courses", "unchecked", `Could not be listed (${error.message})`);
      break;
    }
    for (const [index, courseId] of courses.entries()) {
      if (!missing()) break;
      if (listed.has(courseId)) continue;
      listed.add(courseId);
      progress(`Checking ${enrollment} course ${index + 1} of ${courses.length}`);
      await check(courseId, (seen) => read(courseId, unplaced, seen));
    }
  }
  // One broken course does not hold back the rest. When none could be read, the fault is wider:
  // an outage is reported as such, and a Canvas that refused every course is not a Canvas this
  // extension can check, so Preview must not pass on it either.
  if (failedAny && !readAny) {
    throw (
      fault ??
      new UserError(
        "Canvas did not let any course be read, so nothing could be checked. Confirm you are signed in to the right Canvas account.",
      )
    );
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
    } else if (!sameTitle(target.title, observation.name)) {
      // Assignment IDs are only unique within one Canvas. The importer keeps the title equal to
      // the Canvas name, so a differing title means this page came from some other assignment:
      // a database imported from another Canvas, or a title the importer has yet to refresh.
      record(report, target, "skipped", "Title differs from Canvas; not confirmed as this work");
    } else if (!observation.eligible) {
      record(report, target, "skipped", observation.reason);
    } else if (alreadyHandled(acknowledged[key], observation.evidence)) {
      record(report, target, "skipped", "Already handled; preserving your status");
    } else if (target.status === "Done") {
      // Nothing would be written, so the status from the query is enough without a reread.
      if (report.mode === "sync") {
        acknowledged[key] = observation.evidence;
        await saveAcknowledged();
      }
      record(report, target, "skipped", "Already Done");
    } else {
      const current = await api.target(target.pageId);
      if (
        !current ||
        current.removed ||
        current.conflict ||
        current.uid !== target.uid ||
        current.assignmentId !== target.assignmentId ||
        !sameTitle(current.title, observation.name) ||
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
          // This page was just read, so a 403 on the write means the integration may not update
          // content at all. Every later write would fail the same way until that is changed.
          if (error instanceof ApiError && error.status === 403) throw new WriteAccessDenied();
          // Notion refusing this page is reported. Anything transient ends the scan instead; the
          // page is not acknowledged, so the next scan rereads it and writes again. A revoked
          // token is not an ApiError by the time it gets here (see NotionAccessLost).
          if (!(error instanceof ApiError) || error.retryable || error.status < 400) throw error;
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
