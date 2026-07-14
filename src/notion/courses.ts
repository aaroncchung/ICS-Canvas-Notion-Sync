import type { CourseCreate, CourseRecord, RecoveredCreate } from "../types.js";
import { AmbiguousNotionWriteError, isAmbiguousWriteError, type NotionGateway } from "./client.js";
import { normalizeCourse } from "../sync/course-matcher.js";
import { pollForUniquePage, type VisibilityPollingOptions } from "./recovery.js";
import {
  checkbox,
  pageId,
  pageProperties,
  readRichText,
  readTitle,
  readUrl,
  text,
  title,
  url,
  date,
} from "./property-helpers.js";

export async function readCourses(
  gateway: NotionGateway,
  dataSourceId: string,
): Promise<CourseRecord[]> {
  const pages = await gateway.queryDataSource(dataSourceId);
  return pages.map((page) => {
    const properties = pageProperties(page);
    const courseCode = readRichText(properties, "Course Code");
    const canvasCourseId = readRichText(properties, "Canvas Course ID");
    const courseUrl = readUrl(properties, "Canvas URL");
    return {
      pageId: pageId(page),
      title: readTitle(properties, "Course"),
      ...(courseCode ? { courseCode } : {}),
      ...(canvasCourseId ? { canvasCourseId } : {}),
      ...(courseUrl ? { url: courseUrl } : {}),
    };
  });
}

export async function createCourse(
  gateway: NotionGateway,
  dataSourceId: string,
  course: CourseCreate,
  recoveryOptions: VisibilityPollingOptions = {},
): Promise<RecoveredCreate> {
  const properties: Record<string, unknown> = {
    Course: title(course.title),
    Active: checkbox(true),
    "Sync Updated At": date(new Date().toISOString()),
  };
  if (course.courseCode) properties["Course Code"] = text(course.courseCode);
  if (course.canvasCourseId) properties["Canvas Course ID"] = text(course.canvasCourseId);
  if (course.canvasUrl) properties["Canvas URL"] = url(course.canvasUrl);
  try {
    return { pageId: await gateway.createPage(dataSourceId, properties), recovered: false };
  } catch (error) {
    if (!isAmbiguousWriteError(error)) throw error;
    const match = await pollForUniquePage(
      async () => {
        const pages = course.canvasCourseId
          ? await gateway.queryDataSource(dataSourceId, {
              property: "Canvas Course ID",
              rich_text: { equals: course.canvasCourseId },
            })
          : await gateway.queryDataSource(dataSourceId);
        const expected = [course.title, course.courseCode]
          .filter((value): value is string => Boolean(value))
          .map(normalizeCourse);
        return course.canvasCourseId
          ? pages
          : pages.filter((page) => {
              const record = courseRecord(page);
              return (
                expected.includes(normalizeCourse(record.title)) ||
                Boolean(record.courseCode && expected.includes(normalizeCourse(record.courseCode)))
              );
            });
      },
      (count) => `Course create is ambiguous: ${count} pages match its deterministic key`,
      recoveryOptions,
    );
    if (match) return { pageId: courseRecord(match).pageId, recovered: true };
    throw new AmbiguousNotionWriteError(
      "Course create is ambiguous: no matching page became visible; creation was not retried",
    );
  }
}

function courseRecord(page: Record<string, unknown>): CourseRecord {
  const properties = pageProperties(page);
  const courseCode = readRichText(properties, "Course Code");
  const canvasCourseId = readRichText(properties, "Canvas Course ID");
  return {
    pageId: pageId(page),
    title: readTitle(properties, "Course"),
    ...(courseCode ? { courseCode } : {}),
    ...(canvasCourseId ? { canvasCourseId } : {}),
  };
}
