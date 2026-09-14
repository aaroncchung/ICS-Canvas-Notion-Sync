import type { AppConfig } from "../config.js";
import { safeError } from "../observability/redaction.js";
import { createAssignment, updateAssignment } from "../notion/assignments.js";
import { errorStatus, isAmbiguousWriteError, type NotionGateway } from "../notion/client.js";
import { createCourse, updateCourse } from "../notion/courses.js";
import {
  managedDescriptionHash,
  replaceManagedDescription,
  waitForTemplate,
  type TemplateWaitOptions,
} from "../notion/descriptions.js";
import type {
  AppliedSyncOperation,
  AssignmentExecutionState,
  Clock,
  FailedSyncOperation,
  SyncExecutionResult,
  SyncOperation,
  SyncOperationKind,
  SyncPlan,
} from "../types.js";
import { compilePlan, operationOf, type AssignmentWork, type SyncCommand } from "./commands.js";

function operationError(error: unknown): string {
  const status = errorStatus(error);
  if (status) return `Notion request failed with status ${status}`;
  if (error instanceof Error) return safeError(error).slice(0, 240);
  return "Notion operation failed";
}

export function plannedOperations(plan: SyncPlan): SyncOperation[] {
  return compilePlan(plan).map(operationOf);
}

export class ApplyPlanError extends Error {
  public readonly operation: SyncOperationKind | undefined;

  public constructor(
    public readonly execution: SyncExecutionResult,
    message: string,
  ) {
    super(message);
    this.name = "ApplyPlanError";
    this.operation = execution.failedOperation?.kind;
  }
}

export function emptyExecutionResult(): SyncExecutionResult {
  return {
    appliedOperations: [],
    assignmentsSynchronized: [],
    partialAssignments: [],
    notAttempted: [],
    ambiguousWriteRecoveries: 0,
  };
}

export interface ApplyPlanOptions {
  templateWait?: TemplateWaitOptions;
  /** Run clock; every timestamp written during apply is read from it. */
  now?: Clock;
}

interface AssignmentProgress {
  pageId?: string;
  completed: SyncOperationKind[];
  repaired: boolean;
}

export async function applyPlan(
  gateway: NotionGateway,
  config: AppConfig,
  plan: SyncPlan,
  options: ApplyPlanOptions = {},
): Promise<SyncExecutionResult> {
  const execution = emptyExecutionResult();
  const now = options.now ?? (() => new Date());
  const commands = compilePlan(plan);
  const createdCourses = new Map<string, string>();
  const progress = new Map<AssignmentWork, AssignmentProgress>();
  function coursePage(key: string): string {
    const pageId = key.startsWith("page:") ? key.slice(5) : createdCourses.get(key);
    if (!pageId) throw new Error("A planned course could not be resolved during apply");
    return pageId;
  }
  function state(work: AssignmentWork): AssignmentProgress {
    let value = progress.get(work);
    if (!value) {
      value = {
        completed: [],
        repaired: false,
        ...(work.intent === "update" ? { pageId: work.value.pageId } : {}),
      };
      progress.set(work, value);
    }
    return value;
  }
  function assignmentState(
    work: AssignmentWork,
    failedSubstep?: FailedSyncOperation,
  ): AssignmentExecutionState {
    const value = state(work);
    return {
      target: work.intent === "create" ? work.value.source.uid : work.value.pageId,
      pageId: value.pageId!,
      intent: work.intent,
      state: failedSubstep ? "requires-repair" : "synchronized",
      completedSubsteps: [...value.completed],
      ...(failedSubstep ? { failedSubstep } : {}),
    };
  }
  async function execute(command: SyncCommand): Promise<Partial<AppliedSyncOperation>> {
    switch (command.kind) {
      case "course-create": {
        const created = await createCourse(
          gateway,
          config.NOTION_COURSES_DATA_SOURCE_ID,
          command.course,
          { now },
        );
        createdCourses.set(command.course.key, created.pageId);
        return created;
      }
      case "course-update":
        await updateCourse(gateway, command.course);
        break;
      case "assignment-page-create": {
        const work = command.assignment;
        const created = await createAssignment(
          gateway,
          config.NOTION_ASSIGNMENTS_DATA_SOURCE_ID,
          work.value,
          coursePage(work.value.courseKey),
          config.NOTION_TIMEZONE,
          { now },
        );
        state(work).pageId = created.pageId;
        return created;
      }
      case "assignment-template-wait":
        await waitForTemplate(gateway, state(command.assignment).pageId!, options.templateWait);
        break;
      case "assignment-property-update": {
        const work = command.assignment;
        const properties = { ...work.value.properties };
        if (properties.coursePageId) properties.coursePageId = coursePage(properties.coursePageId);
        await updateAssignment(gateway, work.value.pageId, properties, now);
        break;
      }
      case "assignment-description-update": {
        const value = state(command.assignment);
        const integrity = await replaceManagedDescription(
          gateway,
          value.pageId!,
          command.assignment.value.source.descriptionMarkdown,
          () => {
            execution.ambiguousWriteRecoveries += 1;
          },
        );
        value.repaired = integrity.repaired;
        return { description: integrity };
      }
      case "assignment-description-hash-update": {
        const work = command.assignment;
        const value = state(work);
        const descriptionHash =
          work.intent === "create"
            ? managedDescriptionHash(work.value.source.descriptionMarkdown)
            : work.value.descriptionHash;
        const writeHash =
          work.intent === "create" ||
          work.value.descriptionHashNeedsUpdate !== false ||
          value.repaired;
        await updateAssignment(
          gateway,
          value.pageId!,
          {
            ...(writeHash ? { descriptionHash } : {}),
            descriptionVerifiedAt: now().toISOString(),
          },
          now,
        );
        break;
      }
      case "assignment-remove":
      case "assignment-missing-evidence-update": {
        const change = command.change;
        if (change.type === "evidence") {
          await updateAssignment(
            gateway,
            change.value.pageId,
            {
              canvasMissingSince: change.value.canvasMissingSince,
              canvasMissingCount: change.value.canvasMissingCount,
            },
            now,
          );
        } else {
          const value = change.value;
          await updateAssignment(
            gateway,
            value.pageId,
            {
              removed: true,
              canvasState: "Removed",
              ...(value.clearMissingEvidence
                ? { canvasMissingSince: null, canvasMissingCount: null }
                : {}),
              ...(value.canvasMissingCountAfter !== undefined
                ? { canvasMissingCount: value.canvasMissingCountAfter }
                : {}),
            },
            now,
          );
        }
        break;
      }
    }
    return {};
  }

  for (const [index, command] of commands.entries()) {
    const operation = operationOf(command);
    try {
      const applied = await execute(command);
      execution.appliedOperations.push({ ...operation, ...applied });
      if ("assignment" in command) {
        const work = command.assignment;
        state(work).completed.push(command.kind);
        const next = commands[index + 1];
        if (!next || !("assignment" in next) || next.assignment !== work) {
          execution.assignmentsSynchronized.push(assignmentState(work));
        }
      }
    } catch (error) {
      const failed: FailedSyncOperation = {
        ...operation,
        outcome: isAmbiguousWriteError(error) ? "ambiguous" : "failed",
        message: operationError(error),
      };
      execution.failedOperation = failed;
      if ("assignment" in command) {
        const value = state(command.assignment);
        if (
          value.pageId &&
          (value.completed.length || command.kind === "assignment-description-update")
        ) {
          execution.partialAssignments.push(assignmentState(command.assignment, failed));
        }
      }
      execution.notAttempted = commands.slice(index + 1).map(operationOf);
      throw new ApplyPlanError(
        execution,
        `${operation.kind} ${operation.target}: ${failed.message}`,
      );
    }
  }
  return execution;
}
