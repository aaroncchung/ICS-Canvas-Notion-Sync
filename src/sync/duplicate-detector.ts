import type { AssignmentRecord, CourseRecord, ExternalAssignment } from "../types.js";
import { normalizeCourse } from "./course-matcher.js";
import { datesEqual } from "./date-resolution.js";

function normalizeTitle(value: string): string {
  return value
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function normalizedCanvasUrl(value: string): string | undefined {
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

function compatibleCourse(
  source: ExternalAssignment,
  candidate: AssignmentRecord,
  courses: CourseRecord[],
  resolvedCoursePageId?: string,
): boolean {
  const relatedCourses = courses.filter((course) =>
    candidate.coursePageIds.includes(course.pageId),
  );
  const candidateCourseIds = relatedCourses
    .map((course) => course.canvasCourseId)
    .filter((value): value is string => Boolean(value));
  if (source.canvasCourseId && candidateCourseIds.length) {
    return candidateCourseIds.includes(source.canvasCourseId);
  }
  if (resolvedCoursePageId && candidate.coursePageIds.length) {
    return candidate.coursePageIds.includes(resolvedCoursePageId);
  }

  const sourceNames = [source.courseName, source.courseCode]
    .filter((value): value is string => Boolean(value))
    .map(normalizeCourse);
  if (!sourceNames.length) return false;
  const candidateNames = relatedCourses.flatMap((course) =>
    [course.title, course.courseCode]
      .filter((value): value is string => Boolean(value))
      .map(normalizeCourse),
  );
  return sourceNames.some((value) => candidateNames.includes(value));
}

export function possibleDuplicate(
  source: ExternalAssignment,
  existing: AssignmentRecord[],
  courses: CourseRecord[],
  resolvedCoursePageId?: string,
): AssignmentRecord[] {
  return existing.filter((candidate) => {
    if (candidate.uid === source.uid) return false;
    if (
      source.canvasUrl &&
      candidate.canvasUrl &&
      normalizedCanvasUrl(candidate.canvasUrl) === normalizedCanvasUrl(source.canvasUrl)
    ) {
      return true;
    }
    const sourceAssignmentId = source.canvasAssignmentId ?? assignmentId(source.canvasUrl);
    if (sourceAssignmentId && assignmentId(candidate.canvasUrl) === sourceAssignmentId) return true;
    return (
      normalizeTitle(candidate.title) === normalizeTitle(source.title) &&
      datesEqual(candidate.canvasDueDate, source.dueAt) &&
      compatibleCourse(source, candidate, courses, resolvedCoursePageId)
    );
  });
}
