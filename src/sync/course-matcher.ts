import type { CourseCreate, CourseRecord, CourseUpdate, ExternalAssignment } from "../types.js";

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

function matchedCourse(
  assignment: ExternalAssignment,
  course: CourseRecord,
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

export function matchCourse(
  assignment: ExternalAssignment,
  courses: CourseRecord[],
  aliases: Record<string, string>,
  now = new Date().toISOString(),
): CourseMatch {
  if (!assignment.canvasCourseId && !assignment.courseName && !assignment.courseCode) {
    return { kind: "unidentified" };
  }

  const levels: Array<[string, (course: CourseRecord) => boolean]> = [];
  if (assignment.canvasCourseId) {
    levels.push([
      "canvas-course-id",
      (course) => course.canvasCourseId === assignment.canvasCourseId,
    ]);
  }
  if (assignment.courseName) {
    levels.push(["exact-title", (course) => course.title === assignment.courseName]);
  }
  if (assignment.courseCode) {
    levels.push(["exact-code", (course) => course.courseCode === assignment.courseCode]);
  }
  const normalized = [assignment.courseName, assignment.courseCode]
    .filter((value): value is string => Boolean(value))
    .map(normalizeCourse);
  if (normalized.length) {
    levels.push([
      "normalized-name-or-code",
      (course) =>
        normalized.includes(normalizeCourse(course.title)) ||
        Boolean(course.courseCode && normalized.includes(normalizeCourse(course.courseCode))),
    ]);
  }
  const aliasTarget = Object.entries(aliases).find(([source]) =>
    normalized.includes(normalizeCourse(source)),
  )?.[1];
  if (aliasTarget) {
    const target = normalizeCourse(aliasTarget);
    levels.push([
      "configured-alias",
      (course) =>
        normalizeCourse(course.title) === target ||
        Boolean(course.courseCode && normalizeCourse(course.courseCode) === target),
    ]);
  }
  for (const [method, predicate] of levels) {
    const matches = courses.filter(predicate);
    if (matches.length === 1) return matchedCourse(assignment, matches[0]!, method, now);
    if (matches.length > 1) return { kind: "ambiguous", courses: matches, method };
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
