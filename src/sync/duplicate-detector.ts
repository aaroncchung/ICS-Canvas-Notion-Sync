import type {
  AssignmentRecord,
  CourseRecord,
  ExternalAssignment,
  PlanningOperationCounters,
} from "../types.js";
import { buildCourseIndex, normalizeCourse, type CourseIndex } from "./course-matcher.js";
import { datesEqual } from "./date-resolution.js";

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
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return;
  }
}

function assignmentId(value: string | undefined): string | undefined {
  return value?.match(/\/assignments\/(\d+)(?:\/|\?|#|$)/i)?.[1];
}

interface IndexedAssignment {
  readonly assignment: AssignmentRecord;
  readonly position: number;
  readonly normalizedTitle: string;
  readonly normalizedUrl: string | undefined;
  readonly hasCanvasUrl: boolean;
  readonly canvasAssignmentId?: string;
  readonly courseIds: ReadonlySet<string>;
  readonly courseNames: ReadonlySet<string>;
}

export interface AssignmentIndex {
  readonly byUid: ReadonlyMap<string, readonly AssignmentRecord[]>;
  readonly byNormalizedCanvasUrl: ReadonlyMap<string | undefined, readonly IndexedAssignment[]>;
  readonly byCanvasAssignmentId: ReadonlyMap<string, readonly IndexedAssignment[]>;
  readonly byTitleAndDueDate: ReadonlyMap<string, readonly IndexedAssignment[]>;
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

function dueDateKeys(value: string | undefined): string[] {
  if (value === undefined) return ["undefined"];
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return [`date:${value}`];
  const keys: string[] = [];
  const datePrefix = value.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (datePrefix) keys.push(`date:${datePrefix}`);
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
  counters?: PlanningOperationCounters,
): AssignmentIndex {
  const byUid = new Map<string, AssignmentRecord[]>();
  const byNormalizedCanvasUrl = new Map<string | undefined, IndexedAssignment[]>();
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
      hasCanvasUrl: Boolean(assignment.canvasUrl),
      ...(candidateAssignmentId ? { canvasAssignmentId: candidateAssignmentId } : {}),
      courseIds,
      courseNames,
    });
    if (indexed.hasCanvasUrl) {
      addToIndex(byNormalizedCanvasUrl, indexed.normalizedUrl, indexed);
    }
    if (indexed.canvasAssignmentId) {
      addToIndex(byCanvasAssignmentId, indexed.canvasAssignmentId, indexed);
    }
    for (const dateKey of dueDateKeys(assignment.canvasDueDate)) {
      addToIndex(byTitleAndDueDate, titleAndDateKey(indexed.normalizedTitle, dateKey), indexed);
    }
  }
  return Object.freeze({
    byUid: freezeIndex(byUid),
    byNormalizedCanvasUrl: freezeIndex(byNormalizedCanvasUrl),
    byCanvasAssignmentId: freezeIndex(byCanvasAssignmentId),
    byTitleAndDueDate: freezeIndex(byTitleAndDueDate),
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
  if (source.canvasUrl) {
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
  for (const dateKey of dueDateKeys(source.dueAt)) {
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
      source.canvasUrl &&
      candidate.hasCanvasUrl &&
      candidate.normalizedUrl === sourceNormalizedUrl
    ) {
      return [assignment];
    }
    if (sourceAssignmentId && candidate.canvasAssignmentId === sourceAssignmentId) {
      return [assignment];
    }
    return candidate.normalizedTitle === sourceTitle &&
      datesEqual(assignment.canvasDueDate, source.dueAt) &&
      compatibleCourse(source, candidate, sourceNames, resolvedCoursePageId)
      ? [assignment]
      : [];
  });
}

export function possibleDuplicate(
  source: ExternalAssignment,
  existing: AssignmentRecord[],
  courses: CourseRecord[],
  resolvedCoursePageId?: string,
): AssignmentRecord[] {
  const courseIndex = buildCourseIndex(courses, {});
  return possibleDuplicateFromIndex(
    source,
    buildAssignmentIndex(existing, courseIndex),
    resolvedCoursePageId,
  );
}
