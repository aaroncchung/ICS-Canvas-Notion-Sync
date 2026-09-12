import type {
  CourseCreate,
  CourseRecord,
  CourseUpdate,
  ExternalAssignment,
  PlanningOperationCounters,
} from "../types.js";
import { normalizeCourse } from "./course-normalization.js";

export { normalizeCourse } from "./course-normalization.js";

export type CourseMatch =
  | {
      kind: "matched";
      course: CourseRecord;
      courseKey: string;
      method: string;
      update?: CourseUpdate;
    }
  | { kind: "create"; course: CourseCreate }
  | { kind: "ambiguous"; courses: CourseRecord[]; method: string }
  | {
      kind: "conflict";
      course: CourseRecord;
      courseKey: string;
      method: string;
      fields: Array<"Canvas Course ID" | "Canvas URL">;
    }
  | { kind: "unidentified" };

export interface IndexedCourse {
  readonly course: CourseRecord;
  readonly courseKey: string;
  readonly position: number;
  readonly normalizedTitle: string;
  readonly normalizedCode?: string;
}

interface IndexedAlias {
  readonly position: number;
  readonly target: string;
  readonly enabled: boolean;
}

export interface CourseIndex {
  readonly byCanvasCourseId: ReadonlyMap<string, readonly IndexedCourse[]>;
  readonly byExactTitle: ReadonlyMap<string, readonly IndexedCourse[]>;
  readonly byExactCode: ReadonlyMap<string, readonly IndexedCourse[]>;
  readonly byNormalizedTitle: ReadonlyMap<string, readonly IndexedCourse[]>;
  readonly byNormalizedCode: ReadonlyMap<string, readonly IndexedCourse[]>;
  readonly byPageId: ReadonlyMap<string, readonly IndexedCourse[]>;
  readonly byNormalizedAliasSource: ReadonlyMap<string, readonly IndexedAlias[]>;
  readonly counters?: PlanningOperationCounters;
}

function addToIndex<K>(map: Map<K, IndexedCourse[]>, key: K, value: IndexedCourse): void {
  const matches = map.get(key);
  if (matches) matches.push(value);
  else map.set(key, [value]);
}

function mutableCourseMap(
  map: ReadonlyMap<string, readonly IndexedCourse[]>,
): Map<string, IndexedCourse[]> {
  return map as Map<string, IndexedCourse[]>;
}

function normalizeIndexed(value: string, counters?: PlanningOperationCounters): string {
  if (counters) counters.courseNormalizations += 1;
  return normalizeCourse(value);
}

function courseUrl(assignment: ExternalAssignment): string | undefined {
  if (!assignment.canvasUrl || !assignment.canvasCourseId) return;
  try {
    const value = new URL(assignment.canvasUrl);
    value.pathname = `/courses/${assignment.canvasCourseId}`;
    value.search = "";
    value.hash = "";
    return value.toString();
  } catch {
    return;
  }
}

function comparableUrl(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return value.replace(/\/$/, "");
  }
}

export function buildCourseIndex(
  courses: CourseRecord[],
  aliases: Record<string, string>,
  counters?: PlanningOperationCounters,
  courseKeysByPageId?: ReadonlyMap<string, string>,
): CourseIndex {
  const byNormalizedAliasSource = new Map<string, IndexedAlias[]>();
  const index: CourseIndex = {
    byCanvasCourseId: new Map<string, IndexedCourse[]>(),
    byExactTitle: new Map<string, IndexedCourse[]>(),
    byExactCode: new Map<string, IndexedCourse[]>(),
    byNormalizedTitle: new Map<string, IndexedCourse[]>(),
    byNormalizedCode: new Map<string, IndexedCourse[]>(),
    byPageId: new Map<string, IndexedCourse[]>(),
    byNormalizedAliasSource,
    ...(counters ? { counters } : {}),
  };

  for (const course of courses) {
    addCourseToIndex(
      index,
      course,
      courseKeysByPageId?.get(course.pageId) ?? `page:${course.pageId}`,
    );
  }

  for (const [position, [source, target]] of Object.entries(aliases).entries()) {
    const indexedAlias = Object.freeze({
      position,
      target: normalizeIndexed(target, counters),
      enabled: Boolean(target),
    });
    const normalizedSource = normalizeIndexed(source, counters);
    const matches = byNormalizedAliasSource.get(normalizedSource);
    if (matches) matches.push(indexedAlias);
    else byNormalizedAliasSource.set(normalizedSource, [indexedAlias]);
  }
  return index;
}

export function addCourseToIndex(
  index: CourseIndex,
  course: CourseRecord,
  courseKey = `page:${course.pageId}`,
): void {
  const indexed: IndexedCourse = {
    course,
    courseKey,
    position: index.byPageId.size,
    normalizedTitle: normalizeIndexed(course.title, index.counters),
    ...(course.courseCode
      ? { normalizedCode: normalizeIndexed(course.courseCode, index.counters) }
      : {}),
  };
  if (course.canvasCourseId) {
    addToIndex(mutableCourseMap(index.byCanvasCourseId), course.canvasCourseId, indexed);
  }
  addToIndex(mutableCourseMap(index.byExactTitle), course.title, indexed);
  if (course.courseCode !== undefined) {
    addToIndex(mutableCourseMap(index.byExactCode), course.courseCode, indexed);
  }
  addToIndex(mutableCourseMap(index.byNormalizedTitle), indexed.normalizedTitle, indexed);
  if (indexed.normalizedCode !== undefined) {
    addToIndex(mutableCourseMap(index.byNormalizedCode), indexed.normalizedCode, indexed);
  }
  addToIndex(mutableCourseMap(index.byPageId), course.pageId, indexed);
}

export function addCanvasCourseIdToIndex(
  index: CourseIndex,
  course: CourseRecord,
  canvasCourseId: string,
): void {
  for (const indexed of index.byPageId.get(course.pageId) ?? []) {
    addToIndex(mutableCourseMap(index.byCanvasCourseId), canvasCourseId, indexed);
  }
}

function applicableAliases(index: CourseIndex, keys: readonly string[]): IndexedAlias[] {
  const matches = new Map<number, IndexedAlias>();
  for (const key of keys) {
    for (const alias of index.byNormalizedAliasSource.get(key) ?? []) {
      if (alias.enabled) matches.set(alias.position, alias);
    }
  }
  return [...matches.values()].sort((left, right) => left.position - right.position);
}

function combinedMatches(
  index: CourseIndex,
  keys: readonly string[],
  ...maps: Array<ReadonlyMap<string, readonly IndexedCourse[]>>
): readonly IndexedCourse[] {
  const matches = new Map<number, IndexedCourse>();
  for (const key of keys) {
    for (const map of maps) {
      for (const course of map.get(key) ?? []) matches.set(course.position, course);
    }
  }
  const ordered = [...matches.values()].sort((left, right) => left.position - right.position);
  if (index.counters) index.counters.courseCandidatesExamined += ordered.length;
  return ordered;
}

function indexedMatches(
  index: CourseIndex,
  map: ReadonlyMap<string, readonly IndexedCourse[]>,
  key: string,
): readonly IndexedCourse[] {
  const matches = map.get(key) ?? [];
  if (index.counters) index.counters.courseCandidatesExamined += matches.length;
  return matches;
}

export function matchCourseMetadata(
  assignment: ExternalAssignment,
  course: CourseRecord,
  courseKey: string,
  method: string,
  now: string,
): CourseMatch {
  const sourceUrl = courseUrl(assignment);
  const fields: Array<"Canvas Course ID" | "Canvas URL"> = [];
  if (
    assignment.canvasCourseId &&
    course.canvasCourseId &&
    assignment.canvasCourseId !== course.canvasCourseId
  ) {
    fields.push("Canvas Course ID");
  }
  if (sourceUrl && course.url && comparableUrl(sourceUrl) !== comparableUrl(course.url)) {
    fields.push("Canvas URL");
  }
  if (fields.length) {
    return { kind: "conflict", course, courseKey, method, fields };
  }

  const update: CourseUpdate = { pageId: course.pageId };
  if (assignment.canvasCourseId && !course.canvasCourseId) {
    update.canvasCourseId = assignment.canvasCourseId;
  }
  if (sourceUrl && !course.url) update.canvasUrl = sourceUrl;
  const enrichesCanvasMetadata = Boolean(update.canvasCourseId || update.canvasUrl);
  if (enrichesCanvasMetadata) update.syncUpdatedAt = now;
  return Object.keys(update).length > 1
    ? { kind: "matched", course, courseKey, method, update }
    : { kind: "matched", course, courseKey, method };
}

export function matchCourseFromIndex(
  assignment: ExternalAssignment,
  index: CourseIndex,
  now = new Date().toISOString(),
): CourseMatch {
  if (!assignment.canvasCourseId && !assignment.courseName && !assignment.courseCode) {
    return { kind: "unidentified" };
  }

  const normalizedValues = [assignment.courseName, assignment.courseCode]
    .filter((value): value is string => Boolean(value))
    .map((value) => normalizeIndexed(value, index.counters));
  const aliases = applicableAliases(index, normalizedValues);
  const resolveLevel = (
    method: string,
    matches: readonly IndexedCourse[],
  ): CourseMatch | undefined => {
    if (matches.length === 1) {
      const match = matches[0]!;
      return matchCourseMetadata(assignment, match.course, match.courseKey, method, now);
    }
    if (matches.length > 1) {
      return { kind: "ambiguous", courses: matches.map((match) => match.course), method };
    }
    return;
  };

  if (assignment.canvasCourseId) {
    const match = resolveLevel(
      "canvas-course-id",
      indexedMatches(index, index.byCanvasCourseId, assignment.canvasCourseId),
    );
    if (match) return match;
  }
  if (assignment.courseName) {
    const match = resolveLevel(
      "exact-title",
      indexedMatches(index, index.byExactTitle, assignment.courseName),
    );
    if (match) return match;
  }
  if (assignment.courseCode) {
    const match = resolveLevel(
      "exact-code",
      indexedMatches(index, index.byExactCode, assignment.courseCode),
    );
    if (match) return match;
  }
  if (normalizedValues.length) {
    const match = resolveLevel(
      "normalized-name-or-code",
      combinedMatches(index, normalizedValues, index.byNormalizedTitle, index.byNormalizedCode),
    );
    if (match) return match;
  }
  if (aliases.length) {
    const match = resolveLevel(
      "configured-alias",
      combinedMatches(
        index,
        aliases.map((alias) => alias.target),
        index.byNormalizedTitle,
        index.byNormalizedCode,
      ),
    );
    if (match) return match;
  }

  const title =
    assignment.courseName ??
    assignment.courseCode ??
    `Canvas Course ${assignment.canvasCourseId as string}`;
  const key = assignment.canvasCourseId
    ? `id:${assignment.canvasCourseId}`
    : `name:${normalizeIndexed(title, index.counters)}`;
  const newCourseUrl = courseUrl(assignment);
  return {
    kind: "create",
    course: {
      key,
      title,
      ...(assignment.courseCode ? { courseCode: assignment.courseCode } : {}),
      ...(assignment.canvasCourseId ? { canvasCourseId: assignment.canvasCourseId } : {}),
      ...(newCourseUrl ? { canvasUrl: newCourseUrl } : {}),
    },
  };
}
