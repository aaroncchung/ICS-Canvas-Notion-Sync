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
  inferredType: AssignmentType;
}

export interface AssignmentProvider {
  fetchAssignments(): Promise<AssignmentFeed>;
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
  sourceUids: string[];
  normalizedAssignmentUids: string[];
  quarantinedUids: string[];
  events: FeedEventDiagnostic[];
  complete: boolean;
}

export interface AssignmentFeed {
  assignments: ExternalAssignment[];
  cancelledAssignments: ExternalAssignment[];
  diagnostics: FeedDiagnostics;
}

export interface FeedDiagnosticSummary {
  totalEvents: number;
  activeAssignments: number;
  cancelledAssignments: number;
  ignoredEvents: number;
  suspiciousEvents: number;
  malformedEvents: number;
  duplicateUids: number;
  quarantinedUids: number;
  absenceRemovalSafe: boolean;
}

export interface CourseRecord {
  pageId: string;
  title: string;
  courseCode?: string;
  canvasCourseId?: string;
  url?: string;
  syncUpdatedAt?: string;
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
  canvasMissingSince?: string;
  canvasMissingCount?: number;
  descriptionExcerpt?: string;
  descriptionHash?: string;
  descriptionVerifiedAt?: string;
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

export interface CourseUpdate {
  pageId: string;
  canvasCourseId?: string;
  canvasUrl?: string;
  syncUpdatedAt?: string;
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
  verifyDescription: boolean;
  descriptionHash: string;
  descriptionHashNeedsUpdate?: boolean;
  missingEvidenceCleared: boolean;
}

export interface AssignmentMissingEvidenceUpdate {
  pageId: string;
  canvasMissingSince: string;
  canvasMissingCount: number;
  transition: "observed" | "advanced";
}

export interface AssignmentRemoval extends AssignmentRecord {
  reason: "explicit-cancellation" | "persistent-absence";
  markRemoved: boolean;
  clearMissingEvidence: boolean;
  canvasMissingCountAfter?: number;
}

export interface AssignmentPropertyUpdate {
  title?: string;
  coursePageId?: string;
  canvasUrl?: string | null;
  canvasDueDate?: string | null;
  effectiveDueDate?: string | null;
  overrideDueDate?: string | null;
  canvasMissingSince?: string | null;
  canvasMissingCount?: number | null;
  rawDescription?: string;
  descriptionHash?: string;
  descriptionVerifiedAt?: string;
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
  coursesToUpdate: CourseUpdate[];
  assignmentsToCreate: AssignmentCreate[];
  assignmentsToUpdate: AssignmentUpdate[];
  assignmentsMissingEvidenceToUpdate: AssignmentMissingEvidenceUpdate[];
  assignmentsToRemove: AssignmentRemoval[];
  missingCandidatesObserved: number;
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
  | "course-update"
  | "assignment-page-create"
  | "assignment-template-wait"
  | "assignment-property-update"
  | "assignment-description-update"
  | "assignment-description-hash-update"
  | "assignment-missing-evidence-update"
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
  cancelledAssignments: number;
  ignoredEvents: number;
  suspiciousEvents: number;
  malformedEvents: number;
  duplicateUids: number;
  quarantinedUids: number;
  created: number;
  updated: number;
  coursesUpdated: number;
  removed: number;
  missingObserved: number;
  missingAdvanced: number;
  missingCleared: number;
  unchanged: number;
  skipped: number;
  warningCount: number;
}

export interface RunMetrics {
  notionRequests: number;
  requestsByOperation: Record<string, number>;
  readRetries: number;
  propertyUpdateRetries: number;
  ambiguousWriteRecoveries: number;
  assignmentBodyReads: number;
  descriptionReplacements: number;
  descriptionUpdatesAvoided: number;
  descriptionIntegrityAuditsDue: number;
  descriptionIntegrityAuditsDeferred: number;
  descriptionIntegrityAuditsRun: number;
  descriptionIntegrityAuditsPassed: number;
  descriptionIntegrityRepairs: number;
  descriptionBodyReadsAvoided: number;
  coursesCreated: number;
  coursesRecovered: number;
  coursesEnriched: number;
  coursesConflicted: number;
  assignmentPagesCreated: number;
  assignmentPagesRecovered: number;
}

export interface PlanningOperationCounters {
  courseNormalizations: number;
  courseCandidatesExamined: number;
  assignmentNormalizations: number;
  assignmentCandidatesExamined: number;
}

export interface RunResult {
  status: "Success" | "Warning" | "Failed" | "Dry Run";
  counts: RunCounts;
  warnings: PlanWarning[];
  errors: string[];
  feedDiagnostics?: FeedDiagnosticSummary;
  metrics: RunMetrics;
  plan?: SyncPlan;
  execution?: SyncExecutionResult;
}
