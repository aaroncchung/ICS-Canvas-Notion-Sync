import type {
  CourseCreate,
  CourseRecord,
  CourseUpdate,
  ExternalAssignment,
  PlanningOperationCounters,
} from "../types.js";

export type CourseMatch =
  | { kind: "matched"; course: CourseRecord; method: string; update?: CourseUpdate }
  | { kind: "create"; course: CourseCreate }
  | { kind: "ambiguous"; courses: CourseRecord[]; method: string }
  | {
      kind: "conflict";
      course: CourseRecord;
      method: string;
      fields: Array<"Canvas Course ID" | "Canvas URL">;
    }
  | { kind: "unidentified" };

export function normalizeCourse(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

export interface IndexedCourse {
  readonly course: CourseRecord;
  readonly position: number;
  readonly normalizedTitle: string;
  readonly normalizedCode?: string;
  readonly comparableUrl?: string;
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

function freezeIndex<K>(map: Map<K, IndexedCourse[]>): ReadonlyMap<K, readonly IndexedCourse[]> {
  for (const matches of map.values()) Object.freeze(matches);
  return map;
}

function freezeAliasIndex(
  map: Map<string, IndexedAlias[]>,
): ReadonlyMap<string, readonly IndexedAlias[]> {
  for (const aliases of map.values()) Object.freeze(aliases);
  return map;
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
): CourseIndex {
  const byCanvasCourseId = new Map<string, IndexedCourse[]>();
  const byExactTitle = new Map<string, IndexedCourse[]>();
  const byExactCode = new Map<string, IndexedCourse[]>();
  const byNormalizedTitle = new Map<string, IndexedCourse[]>();
  const byNormalizedCode = new Map<string, IndexedCourse[]>();
  const byPageId = new Map<string, IndexedCourse[]>();
  const byNormalizedAliasSource = new Map<string, IndexedAlias[]>();

  for (const [position, course] of courses.entries()) {
    const indexed: IndexedCourse = Object.freeze({
      course,
      position,
      normalizedTitle: normalizeIndexed(course.title, counters),
      ...(course.courseCode
        ? { normalizedCode: normalizeIndexed(course.courseCode, counters) }
        : {}),
      ...(course.url ? { comparableUrl: comparableUrl(course.url) } : {}),
    });
    if (course.canvasCourseId) addToIndex(byCanvasCourseId, course.canvasCourseId, indexed);
    addToIndex(byExactTitle, course.title, indexed);
    if (course.courseCode !== undefined) addToIndex(byExactCode, course.courseCode, indexed);
    addToIndex(byNormalizedTitle, indexed.normalizedTitle, indexed);
    if (indexed.normalizedCode !== undefined) {
      addToIndex(byNormalizedCode, indexed.normalizedCode, indexed);
    }
    addToIndex(byPageId, course.pageId, indexed);
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
  return Object.freeze({
    byCanvasCourseId: freezeIndex(byCanvasCourseId),
    byExactTitle: freezeIndex(byExactTitle),
    byExactCode: freezeIndex(byExactCode),
    byNormalizedTitle: freezeIndex(byNormalizedTitle),
    byNormalizedCode: freezeIndex(byNormalizedCode),
    byPageId: freezeIndex(byPageId),
    byNormalizedAliasSource: freezeAliasIndex(byNormalizedAliasSource),
    ...(counters ? { counters } : {}),
  });
}

function firstAlias(index: CourseIndex, keys: readonly string[]): IndexedAlias | undefined {
  let first: IndexedAlias | undefined;
  for (const key of keys) {
    for (const alias of index.byNormalizedAliasSource.get(key) ?? []) {
      if (!first || alias.position < first.position) first = alias;
    }
  }
  return first;
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

function matchedCourse(
  assignment: ExternalAssignment,
  indexed: IndexedCourse,
  method: string,
  now: string,
): CourseMatch {
  const course = indexed.course;
  const sourceUrl = courseUrl(assignment);
  const fields: Array<"Canvas Course ID" | "Canvas URL"> = [];
  if (
    assignment.canvasCourseId &&
    course.canvasCourseId &&
    assignment.canvasCourseId !== course.canvasCourseId
  ) {
    fields.push("Canvas Course ID");
  }
  if (sourceUrl && indexed.comparableUrl && comparableUrl(sourceUrl) !== indexed.comparableUrl) {
    fields.push("Canvas URL");
  }
  if (fields.length) return { kind: "conflict", course, method, fields };

  const update: CourseUpdate = { pageId: course.pageId };
  if (assignment.canvasCourseId && !course.canvasCourseId) {
    update.canvasCourseId = assignment.canvasCourseId;
  }
  if (sourceUrl && !course.url) update.canvasUrl = sourceUrl;
  const enrichesCanvasMetadata = Boolean(update.canvasCourseId || update.canvasUrl);
  if (enrichesCanvasMetadata) update.syncUpdatedAt = now;
  return Object.keys(update).length > 1
    ? { kind: "matched", course, method, update }
    : { kind: "matched", course, method };
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
  const alias = firstAlias(index, normalizedValues);
  const resolveLevel = (
    method: string,
    matches: readonly IndexedCourse[],
  ): CourseMatch | undefined => {
    if (matches.length === 1) return matchedCourse(assignment, matches[0]!, method, now);
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
  if (alias?.enabled) {
    const match = resolveLevel(
      "configured-alias",
      combinedMatches(index, [alias.target], index.byNormalizedTitle, index.byNormalizedCode),
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

export function matchCourse(
  assignment: ExternalAssignment,
  courses: CourseRecord[],
  aliases: Record<string, string>,
  now = new Date().toISOString(),
): CourseMatch {
  return matchCourseFromIndex(assignment, buildCourseIndex(courses, aliases), now);
}
