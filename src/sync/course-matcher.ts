import type { CourseCreate, CourseRecord, CourseUpdate, ExternalAssignment } from "../types.js";
import { normalizeCourse } from "../course-normalization.js";

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

type CourseMap = Map<string, IndexedCourse[]>;

/** Lookup tables over course records. Courses may be added after construction; aliases are fixed. */
export interface CourseIndex {
  readonly byCanvasCourseId: CourseMap;
  readonly byExactTitle: CourseMap;
  readonly byExactCode: CourseMap;
  readonly byNormalizedTitle: CourseMap;
  readonly byNormalizedCode: CourseMap;
  readonly byPageId: CourseMap;
  readonly byNormalizedAliasSource: ReadonlyMap<string, readonly IndexedAlias[]>;
}

export function addToIndex<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const matches = map.get(key);
  if (matches) matches.push(value);
  else map.set(key, [value]);
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
  courses: readonly CourseRecord[],
  aliases: Record<string, string>,
): CourseIndex {
  const byNormalizedAliasSource = new Map<string, IndexedAlias[]>();
  for (const [position, [source, target]] of Object.entries(aliases).entries()) {
    addToIndex(byNormalizedAliasSource, normalizeCourse(source), {
      position,
      target: normalizeCourse(target),
      enabled: Boolean(target),
    });
  }
  const index: CourseIndex = {
    byCanvasCourseId: new Map(),
    byExactTitle: new Map(),
    byExactCode: new Map(),
    byNormalizedTitle: new Map(),
    byNormalizedCode: new Map(),
    byPageId: new Map(),
    byNormalizedAliasSource,
  };
  for (const course of courses) addCourseToIndex(index, course);
  return index;
}

/**
 * A copy that accepts additions without touching the original. Every course is rebound to the
 * record `liveRecord` returns for its page; normalized labels are reused, never recomputed.
 */
export function forkCourseIndex(
  index: CourseIndex,
  liveRecord: (pageId: string) => CourseRecord,
): CourseIndex {
  const rebound = new Map<IndexedCourse, IndexedCourse>();
  for (const [pageId, matches] of index.byPageId) {
    const course = liveRecord(pageId);
    for (const indexed of matches) rebound.set(indexed, { ...indexed, course });
  }
  const fork = (map: CourseMap): CourseMap =>
    new Map([...map].map(([key, matches]) => [key, matches.map((value) => rebound.get(value)!)]));
  return {
    byCanvasCourseId: fork(index.byCanvasCourseId),
    byExactTitle: fork(index.byExactTitle),
    byExactCode: fork(index.byExactCode),
    byNormalizedTitle: fork(index.byNormalizedTitle),
    byNormalizedCode: fork(index.byNormalizedCode),
    byPageId: fork(index.byPageId),
    byNormalizedAliasSource: index.byNormalizedAliasSource,
  };
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
    normalizedTitle: normalizeCourse(course.title),
    ...(course.courseCode ? { normalizedCode: normalizeCourse(course.courseCode) } : {}),
  };
  if (course.canvasCourseId) addToIndex(index.byCanvasCourseId, course.canvasCourseId, indexed);
  addToIndex(index.byExactTitle, course.title, indexed);
  if (course.courseCode !== undefined) addToIndex(index.byExactCode, course.courseCode, indexed);
  addToIndex(index.byNormalizedTitle, indexed.normalizedTitle, indexed);
  if (indexed.normalizedCode !== undefined) {
    addToIndex(index.byNormalizedCode, indexed.normalizedCode, indexed);
  }
  addToIndex(index.byPageId, course.pageId, indexed);
}

export function addCanvasCourseIdToIndex(
  index: CourseIndex,
  course: CourseRecord,
  canvasCourseId: string,
): void {
  for (const indexed of index.byPageId.get(course.pageId) ?? []) {
    addToIndex(index.byCanvasCourseId, canvasCourseId, indexed);
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
  keys: readonly string[],
  ...maps: Array<ReadonlyMap<string, readonly IndexedCourse[]>>
): readonly IndexedCourse[] {
  const matches = new Map<number, IndexedCourse>();
  for (const key of keys) {
    for (const map of maps) {
      for (const course of map.get(key) ?? []) matches.set(course.position, course);
    }
  }
  return [...matches.values()].sort((left, right) => left.position - right.position);
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
    .map(normalizeCourse);
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
      index.byCanvasCourseId.get(assignment.canvasCourseId) ?? [],
    );
    if (match) return match;
  }
  if (assignment.courseName) {
    const match = resolveLevel("exact-title", index.byExactTitle.get(assignment.courseName) ?? []);
    if (match) return match;
  }
  if (assignment.courseCode) {
    const match = resolveLevel("exact-code", index.byExactCode.get(assignment.courseCode) ?? []);
    if (match) return match;
  }
  if (normalizedValues.length) {
    const match = resolveLevel(
      "normalized-name-or-code",
      combinedMatches(normalizedValues, index.byNormalizedTitle, index.byNormalizedCode),
    );
    if (match) return match;
  }
  if (aliases.length) {
    const match = resolveLevel(
      "configured-alias",
      combinedMatches(
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
    : `name:${normalizeCourse(title)}`;
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
