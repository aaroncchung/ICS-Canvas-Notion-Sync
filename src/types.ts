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

export interface FeedDiagnostics {
  totalEvents: number;
  assignmentsParsed: number;
  duplicateUids: string[];
  malformedEvents: number;
  skippedEvents: Array<{ reason: string; indicators: string[] }>;
  complete: boolean;
}

export interface AssignmentFeed {
  assignments: ExternalAssignment[];
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
}
