export const ASSIGNMENT_TYPES = [
  "Homework",
  "Lab",
  "Quiz",
  "Exam",
  "Paper",
  "Project",
  "Reading",
  "Other",
] as const;

export type AssignmentType = (typeof ASSIGNMENT_TYPES)[number];
export type RunMode = "sync" | "dry-run" | "validate";
export type Trigger = "scheduled" | "manual";

export interface ExternalAssignment {
  uid: string;
  title: string;
  courseName?: string;
  courseCode?: string;
  canvasCourseId?: string;
  canvasAssignmentId?: string;
  canvasUrl?: string;
  dueAt?: string;
  descriptionPlainText?: string;
  descriptionMarkdown?: string;
  sourceUpdatedAt?: string;
  inferredType: AssignmentType;
  rawClassificationEvidence: string[];
}

export interface AssignmentProvider {
  fetchAssignments(): Promise<ExternalAssignment[]>;
}

export type FeedEventDiagnostic =
  | {
      kind: "ignored";
      reason: "ordinary-calendar-event";
      uid?: string;
      indicators: string[];
    }
  | {
      kind: "suspicious";
      reason: "assignment-like-event";
      uid?: string;
      indicators: string[];
    }
  | {
      kind: "malformed";
      reason: "malformed-assignment-event" | "unparseable-event";
      uid?: string;
      indicators: string[];
    }
  | {
      kind: "duplicate";
      reason: "duplicate-source-uid";
      uid: string;
      indicators: string[];
    }
  | {
      kind: "cancelled";
      reason: "cancelled-assignment";
      uid: string;
      indicators: string[];
    };

export interface FeedDiagnostics {
  totalEvents: number;
  assignmentsParsed: number;
  sourceUids: string[];
  normalizedAssignmentUids: string[];
  quarantinedUids: string[];
  events: FeedEventDiagnostic[];
  ignoredEventCount: number;
  complete: boolean;
}

export interface AssignmentFeed {
  assignments: ExternalAssignment[];
  cancelledAssignments: ExternalAssignment[];
  diagnostics: FeedDiagnostics;
}

export interface CourseRecord {
  pageId: string;
  title: string;
  courseCode?: string;
  canvasCourseId?: string;
  url?: string;
}

export interface AssignmentRecord {
  pageId: string;
  uid: string;
  title: string;
  coursePageIds: string[];
  canvasUrl?: string;
  canvasDueDate?: string;
  effectiveDueDate?: string;
  overrideDueDate?: string;
  descriptionExcerpt?: string;
  managedDescription?: string;
  personalStatus?: string;
  priority?: string;
  assignmentType?: string;
  removed: boolean;
  canvasState?: string;
  importedFrom?: string;
}

export interface CourseCreate {
  key: string;
  title: string;
  courseCode?: string;
  canvasCourseId?: string;
  canvasUrl?: string;
}

export interface AssignmentCreate {
  source: ExternalAssignment;
  courseKey: string;
}

export interface AssignmentUpdate {
  pageId: string;
  source: ExternalAssignment;
  courseKey: string;
  properties: AssignmentPropertyUpdate;
  updateDescription: boolean;
  reactivate: boolean;
}

export interface AssignmentPropertyUpdate {
  title?: string;
  coursePageId?: string;
  canvasUrl?: string | null;
  canvasDueDate?: string | null;
  effectiveDueDate?: string | null;
  overrideDueDate?: string | null;
  rawDescription?: string;
  removed?: boolean;
  canvasState?: "Active" | "Removed";
}

export interface PlanWarning {
  code: string;
  message: string;
  details?: string[];
}

export interface SyncPlan {
  coursesToCreate: CourseCreate[];
  assignmentsToCreate: AssignmentCreate[];
  assignmentsToUpdate: AssignmentUpdate[];
  assignmentsToRemove: AssignmentRecord[];
  unchanged: number;
  skipped: number;
  warnings: PlanWarning[];
}

export interface RecoveredCreate {
  pageId: string;
  recovered: boolean;
}

export type SyncOperationKind =
  | "course-create"
  | "assignment-page-create"
  | "assignment-template-wait"
  | "assignment-property-update"
  | "assignment-description-update"
  | "assignment-remove";

export interface SyncOperation {
  kind: SyncOperationKind;
  target: string;
}

export interface AppliedSyncOperation extends SyncOperation {
  pageId?: string;
  recovered?: boolean;
}

export interface FailedSyncOperation extends SyncOperation {
  outcome: "failed" | "ambiguous";
  message: string;
}

export interface AssignmentExecutionState {
  target: string;
  pageId: string;
  intent: "create" | "update";
  state: "synchronized" | "requires-repair";
  completedSubsteps: SyncOperationKind[];
  failedSubstep?: FailedSyncOperation;
}

export interface SyncExecutionResult {
  appliedOperations: AppliedSyncOperation[];
  assignmentsSynchronized: AssignmentExecutionState[];
  partialAssignments: AssignmentExecutionState[];
  notAttempted: SyncOperation[];
  ambiguousOperations: FailedSyncOperation[];
  failedOperation?: FailedSyncOperation;
}

export interface RunCounts {
  feedItems: number;
  assignmentsParsed: number;
  created: number;
  updated: number;
  removed: number;
  unchanged: number;
  skipped: number;
  warningCount: number;
}

export interface RunResult {
  status: "Success" | "Warning" | "Failed" | "Dry Run";
  counts: RunCounts;
  warnings: PlanWarning[];
  errors: string[];
  plan?: SyncPlan;
  execution?: SyncExecutionResult;
}
