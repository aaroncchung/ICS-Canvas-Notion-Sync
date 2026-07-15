import type { AssignmentRecord, ExternalAssignment, PlanningOperationCounters } from "../types.js";
import { canvasAssignmentUrlIdentity } from "../canvas/canvas-url.js";
import { normalizeCourse, type CourseIndex } from "./course-matcher.js";
import { datesEqual, timestampCalendarDate } from "./date-resolution.js";

function normalizeTitle(value: string, counters?: PlanningOperationCounters): string {
  if (counters) counters.assignmentNormalizations += 1;
  return value
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function normalizedCanvasUrl(
  value: string,
  counters?: PlanningOperationCounters,
): string | undefined {
  if (counters) counters.assignmentNormalizations += 1;
  return canvasAssignmentUrlIdentity(value)?.normalizedUrl;
}

function assignmentId(value: string | undefined): string | undefined {
  return value ? canvasAssignmentUrlIdentity(value)?.assignmentId : undefined;
}

interface IndexedAssignment {
  readonly assignment: AssignmentRecord;
  readonly position: number;
  readonly normalizedTitle: string;
  readonly normalizedUrl: string | undefined;
  readonly canvasAssignmentId?: string;
  readonly courseIds: ReadonlySet<string>;
  readonly courseNames: ReadonlySet<string>;
}

export interface AssignmentIndex {
  readonly byUid: ReadonlyMap<string, readonly AssignmentRecord[]>;
  readonly byNormalizedCanvasUrl: ReadonlyMap<string, readonly IndexedAssignment[]>;
  readonly byCanvasAssignmentId: ReadonlyMap<string, readonly IndexedAssignment[]>;
  readonly byTitleAndDueDate: ReadonlyMap<string, readonly IndexedAssignment[]>;
  readonly timeZone: string;
  readonly counters?: PlanningOperationCounters;
}

function addToIndex<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const matches = map.get(key);
  if (matches) matches.push(value);
  else map.set(key, [value]);
}

function freezeIndex<K, V>(map: Map<K, V[]>): ReadonlyMap<K, readonly V[]> {
  for (const matches of map.values()) Object.freeze(matches);
  return map;
}

function dueDateKeys(value: string | undefined, timeZone: string): string[] {
  if (value === undefined) return ["undefined"];
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return [`date:${value}`];
  const keys: string[] = [];
  const calendarDate =
    timestampCalendarDate(value, timeZone) ?? value.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (calendarDate) keys.push(`date:${calendarDate}`);
  const milliseconds = Date.parse(value);
  keys.push(Number.isNaN(milliseconds) ? `raw:${value}` : `time:${milliseconds}`);
  return keys;
}

function titleAndDateKey(title: string, date: string): string {
  return `${title}\u0000${date}`;
}

export function buildAssignmentIndex(
  assignments: AssignmentRecord[],
  courses: CourseIndex,
  timeZone: string,
  counters?: PlanningOperationCounters,
): AssignmentIndex {
  const byUid = new Map<string, AssignmentRecord[]>();
  const byNormalizedCanvasUrl = new Map<string, IndexedAssignment[]>();
  const byCanvasAssignmentId = new Map<string, IndexedAssignment[]>();
  const byTitleAndDueDate = new Map<string, IndexedAssignment[]>();

  for (const [position, assignment] of assignments.entries()) {
    addToIndex(byUid, assignment.uid, assignment);
    const courseIds = new Set<string>();
    const courseNames = new Set<string>();
    for (const pageId of assignment.coursePageIds) {
      for (const indexedCourse of courses.byPageId.get(pageId) ?? []) {
        if (indexedCourse.course.canvasCourseId) {
          courseIds.add(indexedCourse.course.canvasCourseId);
        }
        courseNames.add(indexedCourse.normalizedTitle);
        if (indexedCourse.normalizedCode !== undefined) {
          courseNames.add(indexedCourse.normalizedCode);
        }
      }
    }
    const candidateAssignmentId = assignmentId(assignment.canvasUrl);
    const indexed: IndexedAssignment = Object.freeze({
      assignment,
      position,
      normalizedTitle: normalizeTitle(assignment.title, counters),
      normalizedUrl: assignment.canvasUrl
        ? normalizedCanvasUrl(assignment.canvasUrl, counters)
        : undefined,
      ...(candidateAssignmentId ? { canvasAssignmentId: candidateAssignmentId } : {}),
      courseIds,
      courseNames,
    });
    if (indexed.normalizedUrl) {
      addToIndex(byNormalizedCanvasUrl, indexed.normalizedUrl, indexed);
    }
    if (indexed.canvasAssignmentId) {
      addToIndex(byCanvasAssignmentId, indexed.canvasAssignmentId, indexed);
    }
    for (const dateKey of dueDateKeys(assignment.canvasDueDate, timeZone)) {
      addToIndex(byTitleAndDueDate, titleAndDateKey(indexed.normalizedTitle, dateKey), indexed);
    }
  }
  return Object.freeze({
    byUid: freezeIndex(byUid),
    byNormalizedCanvasUrl: freezeIndex(byNormalizedCanvasUrl),
    byCanvasAssignmentId: freezeIndex(byCanvasAssignmentId),
    byTitleAndDueDate: freezeIndex(byTitleAndDueDate),
    timeZone,
    ...(counters ? { counters } : {}),
  });
}

function compatibleCourse(
  source: ExternalAssignment,
  candidate: IndexedAssignment,
  sourceNames: readonly string[],
  resolvedCoursePageId?: string,
): boolean {
  if (source.canvasCourseId && candidate.courseIds.size) {
    return candidate.courseIds.has(source.canvasCourseId);
  }
  if (resolvedCoursePageId && candidate.assignment.coursePageIds.length) {
    return candidate.assignment.coursePageIds.includes(resolvedCoursePageId);
  }
  if (!sourceNames.length) return false;
  return sourceNames.some((value) => candidate.courseNames.has(value));
}

export function possibleDuplicateFromIndex(
  source: ExternalAssignment,
  index: AssignmentIndex,
  resolvedCoursePageId?: string,
): AssignmentRecord[] {
  const candidates = new Map<number, IndexedAssignment>();
  const sourceNormalizedUrl = source.canvasUrl
    ? normalizedCanvasUrl(source.canvasUrl, index.counters)
    : undefined;
  if (sourceNormalizedUrl) {
    for (const candidate of index.byNormalizedCanvasUrl.get(sourceNormalizedUrl) ?? []) {
      candidates.set(candidate.position, candidate);
    }
  }
  const sourceAssignmentId = source.canvasAssignmentId ?? assignmentId(source.canvasUrl);
  if (sourceAssignmentId) {
    for (const candidate of index.byCanvasAssignmentId.get(sourceAssignmentId) ?? []) {
      candidates.set(candidate.position, candidate);
    }
  }
  const sourceTitle = normalizeTitle(source.title, index.counters);
  for (const dateKey of dueDateKeys(source.dueAt, index.timeZone)) {
    for (const candidate of index.byTitleAndDueDate.get(titleAndDateKey(sourceTitle, dateKey)) ??
      []) {
      candidates.set(candidate.position, candidate);
    }
  }
  const sourceNames = [source.courseName, source.courseCode]
    .filter((value): value is string => Boolean(value))
    .map((value) => {
      if (index.counters) index.counters.courseNormalizations += 1;
      return normalizeCourse(value);
    });
  const ordered = [...candidates.values()].sort((left, right) => left.position - right.position);
  if (index.counters) index.counters.assignmentCandidatesExamined += ordered.length;
  return ordered.flatMap((candidate) => {
    const assignment = candidate.assignment;
    if (assignment.uid === source.uid) return [];
    if (
      sourceNormalizedUrl &&
      candidate.normalizedUrl &&
      candidate.normalizedUrl === sourceNormalizedUrl
    ) {
      return [assignment];
    }
    if (sourceAssignmentId && candidate.canvasAssignmentId === sourceAssignmentId) {
      return [assignment];
    }
    return candidate.normalizedTitle === sourceTitle &&
      datesEqual(assignment.canvasDueDate, source.dueAt, index.timeZone) &&
      compatibleCourse(source, candidate, sourceNames, resolvedCoursePageId)
      ? [assignment]
      : [];
  });
}
