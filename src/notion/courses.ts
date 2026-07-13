import type { CourseCreate, CourseRecord } from "../types.js";
import type { NotionGateway } from "./client.js";
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
): Promise<string> {
  const properties: Record<string, unknown> = {
    Course: title(course.title),
    Active: checkbox(true),
    "Sync Updated At": date(new Date().toISOString()),
  };
  if (course.courseCode) properties["Course Code"] = text(course.courseCode);
  if (course.canvasCourseId) properties["Canvas Course ID"] = text(course.canvasCourseId);
  if (course.canvasUrl) properties["Canvas URL"] = url(course.canvasUrl);
  return gateway.createPage(dataSourceId, properties);
}
