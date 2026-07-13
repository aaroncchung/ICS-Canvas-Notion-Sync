import type { CourseCreate, CourseRecord, ExternalAssignment } from "../types.js";

export type CourseMatch =
  | { kind: "matched"; course: CourseRecord; method: string }
  | { kind: "create"; course: CourseCreate }
  | { kind: "ambiguous"; courses: CourseRecord[]; method: string };

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
    const url = new URL(assignment.canvasUrl);
    url.pathname = `/courses/${assignment.canvasCourseId}`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return;
  }
}

function decide(matches: CourseRecord[], method: string): CourseMatch | undefined {
  if (matches.length === 1) return { kind: "matched", course: matches[0]!, method };
  if (matches.length > 1) return { kind: "ambiguous", courses: matches, method };
  return;
}

export function matchCourse(
  assignment: ExternalAssignment,
  courses: CourseRecord[],
  aliases: Record<string, string>,
): CourseMatch {
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
    const result = decide(courses.filter(predicate), method);
    if (result) return result;
  }

  const title =
    assignment.courseName ??
    assignment.courseCode ??
    (assignment.canvasCourseId
      ? `Canvas Course ${assignment.canvasCourseId}`
      : "Canvas Course Unknown");
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
