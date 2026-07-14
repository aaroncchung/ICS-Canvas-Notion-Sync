import type { AppConfig } from "../config.js";
import { createAssignment, updateAssignment } from "../notion/assignments.js";
import { errorStatus, isAmbiguousWriteError, type NotionGateway } from "../notion/client.js";
import { createCourse } from "../notion/courses.js";
import {
  replaceManagedDescription,
  waitForTemplate,
  type TemplateWaitOptions,
} from "../notion/descriptions.js";
import type {
  AppliedSyncOperation,
  AssignmentExecutionState,
  FailedSyncOperation,
  RunCounts,
  SyncExecutionResult,
  SyncOperation,
  SyncOperationKind,
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

export function plannedOperations(plan: SyncPlan): SyncOperation[] {
  return [
    ...plan.coursesToCreate.map((course) => ({
      kind: "course-create" as const,
      target: course.key,
    })),
    ...plan.assignmentsToCreate.flatMap((assignment) => [
      { kind: "assignment-page-create" as const, target: assignment.source.uid },
      { kind: "assignment-template-wait" as const, target: assignment.source.uid },
      { kind: "assignment-description-update" as const, target: assignment.source.uid },
    ]),
    ...plan.assignmentsToUpdate.flatMap((assignment) => [
      ...(Object.keys(assignment.properties).length
        ? [{ kind: "assignment-property-update" as const, target: assignment.pageId }]
        : []),
      ...(assignment.updateDescription
        ? [{ kind: "assignment-description-update" as const, target: assignment.pageId }]
        : []),
    ]),
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
    appliedOperations: [],
    assignmentsSynchronized: [],
    partialAssignments: [],
    notAttempted: [],
    ambiguousOperations: [],
  };
}

export interface ApplyPlanOptions {
  templateWait?: TemplateWaitOptions;
}

export async function applyPlan(
  gateway: NotionGateway,
  config: AppConfig,
  plan: SyncPlan,
  counts: RunCounts,
  options: ApplyPlanOptions = {},
): Promise<SyncExecutionResult> {
  const execution = emptyExecutionResult();
  const operations = plannedOperations(plan);
  let operationIndex = 0;

  async function applyStep<T>(
    operation: SyncOperation,
    action: () => Promise<T>,
    applied: (value: T) => Partial<AppliedSyncOperation> = () => ({}),
    onFailure?: (failure: FailedSyncOperation) => void,
  ): Promise<T> {
    try {
      const value = await action();
      execution.appliedOperations.push({ ...operation, ...applied(value) });
      operationIndex += 1;
      return value;
    } catch (error) {
      const failed: FailedSyncOperation = {
        ...operation,
        outcome: isAmbiguousWriteError(error) ? "ambiguous" : "failed",
        message: operationError(error),
      };
      execution.failedOperation = failed;
      if (failed.outcome === "ambiguous") execution.ambiguousOperations.push(failed);
      onFailure?.(failed);
      execution.notAttempted = operations.slice(operationIndex + 1);
      throw new ApplyPlanError(
        execution,
        `${operation.kind} ${operation.target}: ${failed.message}`,
      );
    }
  }

  function assignmentState(
    target: string,
    pageId: string,
    intent: "create" | "update",
    completedSubsteps: SyncOperationKind[],
    failedSubstep?: FailedSyncOperation,
  ): AssignmentExecutionState {
    return {
      target,
      pageId,
      intent,
      state: failedSubstep ? "requires-repair" : "synchronized",
      completedSubsteps: [...completedSubsteps],
      ...(failedSubstep ? { failedSubstep } : {}),
    };
  }

  const createdCourses = new Map<string, string>();
  for (const course of plan.coursesToCreate) {
    const operation = operations[operationIndex]!;
    const created = await applyStep(
      operation,
      () => createCourse(gateway, config.NOTION_COURSES_DATA_SOURCE_ID, course),
      (value) => ({ pageId: value.pageId, recovered: value.recovered }),
    );
    createdCourses.set(course.key, created.pageId);
  }

  // Active creates and updates deliberately finish before any removal writes.
  for (const create of plan.assignmentsToCreate) {
    const target = create.source.uid;
    const completed: SyncOperationKind[] = [];
    const coursePageId = resolveCourseKey(create.courseKey, createdCourses);
    const pageOperation = operations[operationIndex]!;
    const created = await applyStep(
      pageOperation,
      () =>
        createAssignment(
          gateway,
          config.NOTION_ASSIGNMENTS_DATA_SOURCE_ID,
          create,
          coursePageId,
          config.NOTION_TIMEZONE,
        ),
      (value) => ({ pageId: value.pageId, recovered: value.recovered }),
    );
    completed.push(pageOperation.kind);
    counts.created += 1;

    const recordPartial = (failure: FailedSyncOperation) => {
      execution.partialAssignments.push(
        assignmentState(target, created.pageId, "create", completed, failure),
      );
    };
    const templateOperation = operations[operationIndex]!;
    await applyStep(
      templateOperation,
      () => waitForTemplate(gateway, created.pageId, options.templateWait),
      undefined,
      recordPartial,
    );
    completed.push(templateOperation.kind);

    const descriptionOperation = operations[operationIndex]!;
    await applyStep(
      descriptionOperation,
      () => replaceManagedDescription(gateway, created.pageId, create.source.descriptionMarkdown),
      undefined,
      recordPartial,
    );
    completed.push(descriptionOperation.kind);
    execution.assignmentsSynchronized.push(
      assignmentState(target, created.pageId, "create", completed),
    );
  }

  for (const update of plan.assignmentsToUpdate) {
    const completed: SyncOperationKind[] = [];
    const recordPartial = (failure: FailedSyncOperation) => {
      if (completed.length) {
        execution.partialAssignments.push(
          assignmentState(update.pageId, update.pageId, "update", completed, failure),
        );
      }
    };
    const properties = { ...update.properties };
    if (properties.coursePageId) {
      properties.coursePageId = resolveCourseKey(properties.coursePageId, createdCourses);
    }
    if (Object.keys(properties).length) {
      const propertyOperation = operations[operationIndex]!;
      await applyStep(
        propertyOperation,
        () => updateAssignment(gateway, update.pageId, properties),
        undefined,
        recordPartial,
      );
      completed.push(propertyOperation.kind);
    }
    if (update.updateDescription) {
      const descriptionOperation = operations[operationIndex]!;
      await applyStep(
        descriptionOperation,
        () => replaceManagedDescription(gateway, update.pageId, update.source.descriptionMarkdown),
        undefined,
        recordPartial,
      );
      completed.push(descriptionOperation.kind);
    }
    execution.assignmentsSynchronized.push(
      assignmentState(update.pageId, update.pageId, "update", completed),
    );
    counts.updated += 1;
  }

  for (const assignment of plan.assignmentsToRemove) {
    const operation = operations[operationIndex]!;
    await applyStep(operation, () =>
      updateAssignment(gateway, assignment.pageId, {
        removed: true,
        canvasState: "Removed",
      }),
    );
    counts.removed += 1;
  }
  return execution;
}
