import type {
  AssignmentCreate,
  AssignmentMissingEvidenceUpdate,
  AssignmentRemoval,
  AssignmentUpdate,
  CourseCreate,
  CourseUpdate,
  SyncOperation,
  SyncPlan,
} from "../types.js";

export interface AssignmentCreateWork {
  intent: "create";
  value: AssignmentCreate;
}

export interface AssignmentUpdateWork {
  intent: "update";
  value: AssignmentUpdate;
}

export type AssignmentWork = AssignmentCreateWork | AssignmentUpdateWork;

export type SyncCommand =
  | { kind: "course-create"; target: string; course: CourseCreate }
  | { kind: "course-update"; target: string; course: CourseUpdate }
  | {
      kind: "assignment-page-create" | "assignment-template-wait";
      target: string;
      assignment: AssignmentCreateWork;
    }
  | { kind: "assignment-property-update"; target: string; assignment: AssignmentUpdateWork }
  | {
      kind: "assignment-description-update" | "assignment-description-hash-update";
      target: string;
      assignment: AssignmentWork;
    }
  | {
      kind: "assignment-remove" | "assignment-missing-evidence-update";
      target: string;
      change:
        | { type: "removal"; value: AssignmentRemoval }
        | { type: "evidence"; value: AssignmentMissingEvidenceUpdate };
    };

export function operationOf(command: SyncCommand): SyncOperation {
  return { kind: command.kind, target: command.target };
}

/** The only definition of write ordering, shared by execution and observability. */
export function compilePlan(plan: SyncPlan): SyncCommand[] {
  const commands: SyncCommand[] = [];
  for (const course of plan.coursesToCreate)
    commands.push({ kind: "course-create", target: course.key, course });
  for (const course of plan.coursesToUpdate)
    commands.push({ kind: "course-update", target: course.pageId, course });
  for (const value of plan.assignmentsToCreate) {
    const assignment: AssignmentCreateWork = { intent: "create", value };
    const target = value.source.uid;
    commands.push(
      { kind: "assignment-page-create", target, assignment },
      { kind: "assignment-template-wait", target, assignment },
      { kind: "assignment-description-update", target, assignment },
      { kind: "assignment-description-hash-update", target, assignment },
    );
  }
  for (const value of plan.assignmentsToUpdate) {
    const assignment: AssignmentUpdateWork = { intent: "update", value };
    if (Object.keys(value.properties).length)
      commands.push({ kind: "assignment-property-update", target: value.pageId, assignment });
    if (value.verifyDescription) {
      commands.push({ kind: "assignment-description-update", target: value.pageId, assignment });
      commands.push({
        kind: "assignment-description-hash-update",
        target: value.pageId,
        assignment,
      });
    }
  }
  const removals = (reason: AssignmentRemoval["reason"]) => {
    for (const value of plan.assignmentsToRemove.filter((item) => item.reason === reason)) {
      commands.push({
        kind: value.markRemoved ? "assignment-remove" : "assignment-missing-evidence-update",
        target: value.pageId,
        change: { type: "removal", value },
      });
    }
  };
  // No removal or missing-evidence mutation may precede active work.
  removals("explicit-cancellation");
  for (const value of plan.assignmentsMissingEvidenceToUpdate) {
    commands.push({
      kind: "assignment-missing-evidence-update",
      target: value.pageId,
      change: { type: "evidence", value },
    });
  }
  removals("persistent-absence");
  return commands;
}
