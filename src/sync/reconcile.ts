import type { AppConfig } from "../config.js";
import { createAssignment, updateAssignment } from "../notion/assignments.js";
import { createCourse } from "../notion/courses.js";
import { replaceManagedDescription, waitForTemplate } from "../notion/descriptions.js";
import type { NotionGateway } from "../notion/client.js";
import type { RunCounts, SyncPlan } from "../types.js";

function resolveCourseKey(key: string, created: Map<string, string>): string {
  if (key.startsWith("page:")) return key.slice("page:".length);
  const pageId = created.get(key);
  if (!pageId) throw new Error("A planned course could not be resolved during apply");
  return pageId;
}

export async function applyPlan(
  gateway: NotionGateway,
  config: AppConfig,
  plan: SyncPlan,
  counts: RunCounts,
): Promise<void> {
  const createdCourses = new Map<string, string>();
  for (const course of plan.coursesToCreate) {
    const pageId = await createCourse(gateway, config.NOTION_COURSES_DATA_SOURCE_ID, course);
    createdCourses.set(course.key, pageId);
  }

  // Active creates and updates deliberately finish before any removal writes.
  for (const create of plan.assignmentsToCreate) {
    const coursePageId = resolveCourseKey(create.courseKey, createdCourses);
    const pageId = await createAssignment(
      gateway,
      config.NOTION_ASSIGNMENTS_DATA_SOURCE_ID,
      create,
      coursePageId,
      config.NOTION_TIMEZONE,
    );
    await waitForTemplate(gateway, pageId);
    await replaceManagedDescription(gateway, pageId, create.source.descriptionMarkdown);
    counts.created += 1;
  }

  for (const update of plan.assignmentsToUpdate) {
    const properties = { ...update.properties };
    if (properties.coursePageId) {
      properties.coursePageId = resolveCourseKey(properties.coursePageId, createdCourses);
    }
    await updateAssignment(gateway, update.pageId, properties);
    if (update.updateDescription) {
      await replaceManagedDescription(gateway, update.pageId, update.source.descriptionMarkdown);
    }
    counts.updated += 1;
  }

  for (const assignment of plan.assignmentsToRemove) {
    await updateAssignment(gateway, assignment.pageId, {
      removed: true,
      canvasState: "Removed",
    });
    counts.removed += 1;
  }
}
