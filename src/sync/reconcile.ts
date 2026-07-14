import type { AppConfig } from "../config.js";
import { createAssignment, updateAssignment } from "../notion/assignments.js";
import { isAmbiguousWriteError, errorStatus, type NotionGateway } from "../notion/client.js";
import { createCourse } from "../notion/courses.js";
import { replaceManagedDescription, waitForTemplate } from "../notion/descriptions.js";
import type {
  FailedSyncOperation,
  RunCounts,
  SyncExecutionResult,
  SyncOperation,
  SyncPlan,
} from "../types.js";

function resolveCourseKey(key: string, created: Map<string, string>): string {
  if (key.startsWith("page:")) return key.slice("page:".length);
  const pageId = created.get(key);
  if (!pageId) throw new Error("A planned course could not be resolved during apply");
  return pageId;
}

function operationError(error: unknown): string {
  const status = errorStatus(error);
  if (status) return `Notion request failed with status ${status}`;
  if (error instanceof Error) return error.message.slice(0, 240);
  return "Notion operation failed";
}

function plannedOperations(plan: SyncPlan): SyncOperation[] {
  return [
    ...plan.coursesToCreate.map((course) => ({
      kind: "course-create" as const,
      target: course.key,
    })),
    ...plan.assignmentsToCreate.map((assignment) => ({
      kind: "assignment-create" as const,
      target: assignment.source.uid,
    })),
    ...plan.assignmentsToUpdate.map((assignment) => ({
      kind: "assignment-update" as const,
      target: assignment.pageId,
    })),
    ...plan.assignmentsToRemove.map((assignment) => ({
      kind: "assignment-remove" as const,
      target: assignment.pageId,
    })),
  ];
}

export class ApplyPlanError extends Error {
  public constructor(
    public readonly execution: SyncExecutionResult,
    message: string,
  ) {
    super(message);
    this.name = "ApplyPlanError";
  }
}

export function emptyExecutionResult(): SyncExecutionResult {
  return {
    coursesCreated: [],
    assignmentsCreated: [],
    assignmentsUpdated: [],
    assignmentsRemoved: [],
    notAttempted: [],
    ambiguousOperations: [],
  };
}

export async function applyPlan(
  gateway: NotionGateway,
  config: AppConfig,
  plan: SyncPlan,
  counts: RunCounts,
): Promise<SyncExecutionResult> {
  const execution = emptyExecutionResult();
  const operations = plannedOperations(plan);
  let operationIndex = 0;

  async function apply(operation: SyncOperation, action: () => Promise<void>): Promise<void> {
    try {
      await action();
      operationIndex += 1;
    } catch (error) {
      const failed: FailedSyncOperation = {
        ...operation,
        outcome: isAmbiguousWriteError(error) ? "ambiguous" : "failed",
        message: operationError(error),
      };
      execution.failedOperation = failed;
      if (failed.outcome === "ambiguous") execution.ambiguousOperations.push(failed);
      execution.notAttempted = operations.slice(operationIndex + 1);
      throw new ApplyPlanError(
        execution,
        `${operation.kind} ${operation.target}: ${failed.message}`,
      );
    }
  }

  const createdCourses = new Map<string, string>();
  for (const course of plan.coursesToCreate) {
    const operation = operations[operationIndex]!;
    await apply(operation, async () => {
      const created = await createCourse(gateway, config.NOTION_COURSES_DATA_SOURCE_ID, course);
      createdCourses.set(course.key, created.pageId);
      execution.coursesCreated.push({ ...operation, ...created });
    });
  }

  // Active creates and updates deliberately finish before any removal writes.
  for (const create of plan.assignmentsToCreate) {
    const operation = operations[operationIndex]!;
    await apply(operation, async () => {
      const coursePageId = resolveCourseKey(create.courseKey, createdCourses);
      const created = await createAssignment(
        gateway,
        config.NOTION_ASSIGNMENTS_DATA_SOURCE_ID,
        create,
        coursePageId,
        config.NOTION_TIMEZONE,
      );
      execution.assignmentsCreated.push({ ...operation, ...created });
      counts.created += 1;
      await waitForTemplate(gateway, created.pageId);
      await replaceManagedDescription(gateway, created.pageId, create.source.descriptionMarkdown);
    });
  }

  for (const update of plan.assignmentsToUpdate) {
    const operation = operations[operationIndex]!;
    await apply(operation, async () => {
      const properties = { ...update.properties };
      if (properties.coursePageId) {
        properties.coursePageId = resolveCourseKey(properties.coursePageId, createdCourses);
      }
      await updateAssignment(gateway, update.pageId, properties);
      if (update.updateDescription) {
        await replaceManagedDescription(gateway, update.pageId, update.source.descriptionMarkdown);
      }
      execution.assignmentsUpdated.push(operation);
      counts.updated += 1;
    });
  }

  for (const assignment of plan.assignmentsToRemove) {
    const operation = operations[operationIndex]!;
    await apply(operation, async () => {
      await updateAssignment(gateway, assignment.pageId, {
        removed: true,
        canvasState: "Removed",
      });
      execution.assignmentsRemoved.push(operation);
      counts.removed += 1;
    });
  }
  return execution;
}
