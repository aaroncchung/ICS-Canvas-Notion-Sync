import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { extractCourseCode } from "../src/canvas/normalize-assignment.js";
import { CanvasIcsProvider } from "../src/canvas/provider.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { readAssignments } from "../src/notion/assignments.js";
import { OfficialNotionGateway, settleReads } from "../src/notion/client.js";
import { readCourses } from "../src/notion/courses.js";
import { createLogger } from "../src/observability/logger.js";
import { safeError } from "../src/observability/redaction.js";
import {
  buildCourseIndex,
  matchCourseFromIndex,
  type CourseMatch,
} from "../src/sync/course-matcher.js";
import { buildPlan } from "../src/sync/plan.js";
import type {
  AssignmentFeed,
  AssignmentRecord,
  CourseRecord,
  ExternalAssignment,
  SyncPlan,
  Trigger,
} from "../src/types.js";

/**
 * Compares course-code extraction before and after issue #26 against a real feed and the real
 * Notion snapshot, without writing anything. The report names course codes but never assignment
 * titles, course names, descriptions, or Notion page IDs; destinations are shown as short digests.
 */

/** The pattern used before issue #26: case-insensitive, first match wins. */
export const LEGACY_COURSE_CODE_PATTERN = /\b[A-Z]{2,}\s*[- ]?\d{1,4}[A-Z]?\b/i;

export function legacyCourseCode(label: string | undefined): string | undefined {
  return label?.match(LEGACY_COURSE_CODE_PATTERN)?.[0];
}

export type CourseCodeExtractor = (label: string | undefined) => string | undefined;

export const currentCourseCode: CourseCodeExtractor = (label) =>
  label === undefined ? undefined : extractCourseCode(label);

function withCourseCode(
  assignment: ExternalAssignment,
  extractor: CourseCodeExtractor,
): ExternalAssignment {
  const rest: ExternalAssignment = { ...assignment };
  delete rest.courseCode;
  const courseCode = extractor(assignment.courseName);
  return courseCode ? { ...rest, courseCode } : rest;
}

/** Re-derives every course code from the course label using the supplied extractor. */
export function feedWithExtractor(feed: AssignmentFeed, extractor: CourseCodeExtractor) {
  return {
    ...feed,
    assignments: feed.assignments.map((assignment) => withCourseCode(assignment, extractor)),
    cancelledAssignments: feed.cancelledAssignments.map((assignment) =>
      withCourseCode(assignment, extractor),
    ),
  };
}

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

export interface CourseDestination {
  kind: CourseMatch["kind"];
  method?: string;
  /** Digest of the matched course key, planned create key, or ambiguous page set. */
  target?: string;
}

export function describeMatch(match: CourseMatch): CourseDestination {
  switch (match.kind) {
    case "matched":
    case "conflict":
      return { kind: match.kind, method: match.method, target: digest(match.courseKey) };
    case "ambiguous":
      return {
        kind: match.kind,
        method: match.method,
        target: digest(
          match.courses
            .map((course) => course.pageId)
            .sort()
            .join("\n"),
        ),
      };
    case "create":
      return { kind: match.kind, target: digest(match.course.key) };
    case "unidentified":
      return { kind: match.kind };
  }
}

function sameDestination(left: CourseDestination, right: CourseDestination): boolean {
  return left.kind === right.kind && left.method === right.method && left.target === right.target;
}

export interface AssignmentComparison {
  position: number;
  cancelled: boolean;
  hasCourseLabel: boolean;
  before: { code?: string; destination: CourseDestination };
  after: { code?: string; destination: CourseDestination };
  codeChanged: boolean;
  destinationChanged: boolean;
}

export interface PlanFieldComparison {
  field: string;
  /** Code-only fields may legitimately differ; destination fields must not. */
  kind: "destination" | "code";
  before: string;
  after: string;
  changed: boolean;
}

export interface CourseCodeDiff {
  assignments: AssignmentComparison[];
  plan: PlanFieldComparison[];
  summary: {
    assignments: number;
    codeChanges: number;
    destinationChanges: number;
    planDestinationChanges: number;
    planCodeChanges: number;
  };
}

export interface ComparisonInputs {
  feed: AssignmentFeed;
  existingAssignments: AssignmentRecord[];
  courses: CourseRecord[];
  aliases: Record<string, string>;
  notionTimezone: string;
  now: Date;
  trigger?: Trigger;
  minimumMissingIntervalMs?: number;
}

function planFields(plan: SyncPlan): Array<Omit<PlanFieldComparison, "changed" | "after">> {
  const list = (values: string[]) =>
    `${values.length} entries, digest ${digest(values.join("\n"))}`;
  return [
    {
      field: "Courses to create (keys)",
      kind: "destination",
      before: list(plan.coursesToCreate.map((course) => course.key)),
    },
    {
      field: "Courses to create (codes)",
      kind: "code",
      before: list(plan.coursesToCreate.map((course) => course.courseCode ?? "")),
    },
    {
      field: "Courses to enrich",
      kind: "destination",
      before: list(
        plan.coursesToUpdate.map(
          (course) => `${course.pageId}|${course.canvasCourseId ?? ""}|${course.canvasUrl ?? ""}`,
        ),
      ),
    },
    {
      field: "Assignments to create (course keys)",
      kind: "destination",
      before: list(plan.assignmentsToCreate.map((item) => `${item.source.uid}|${item.courseKey}`)),
    },
    {
      field: "Assignments to update (course relations)",
      kind: "destination",
      before: list(
        plan.assignmentsToUpdate.map(
          (item) => `${item.pageId}|${item.courseKey}|${item.properties.coursePageId ?? ""}`,
        ),
      ),
    },
    {
      field: "Assignments to remove",
      kind: "destination",
      before: list(plan.assignmentsToRemove.map((item) => `${item.pageId}|${item.reason}`)),
    },
    {
      field: "Missing-evidence updates",
      kind: "destination",
      before: list(plan.assignmentsMissingEvidenceToUpdate.map((item) => item.pageId)),
    },
    { field: "Unchanged", kind: "destination", before: `${plan.unchanged}` },
    { field: "Skipped", kind: "destination", before: `${plan.skipped}` },
    {
      field: "Warnings",
      kind: "destination",
      before: list(plan.warnings.map((warning) => warning.code).sort()),
    },
  ];
}

export function compareCourseExtraction(inputs: ComparisonInputs): CourseCodeDiff {
  const before = feedWithExtractor(inputs.feed, legacyCourseCode);
  const after = feedWithExtractor(inputs.feed, currentCourseCode);
  const index = buildCourseIndex(inputs.courses, inputs.aliases);
  const now = inputs.now.toISOString();
  const compare = (
    left: ExternalAssignment,
    right: ExternalAssignment,
    position: number,
    cancelled: boolean,
  ): AssignmentComparison => {
    const beforeDestination = describeMatch(matchCourseFromIndex(left, index, now));
    const afterDestination = describeMatch(matchCourseFromIndex(right, index, now));
    return {
      position,
      cancelled,
      hasCourseLabel: Boolean(left.courseName),
      before: {
        ...(left.courseCode ? { code: left.courseCode } : {}),
        destination: beforeDestination,
      },
      after: {
        ...(right.courseCode ? { code: right.courseCode } : {}),
        destination: afterDestination,
      },
      codeChanged: left.courseCode !== right.courseCode,
      destinationChanged: !sameDestination(beforeDestination, afterDestination),
    };
  };
  const assignments = [
    ...before.assignments.map((assignment, position) =>
      compare(assignment, after.assignments[position]!, position + 1, false),
    ),
    ...before.cancelledAssignments.map((assignment, position) =>
      compare(
        assignment,
        after.cancelledAssignments[position]!,
        before.assignments.length + position + 1,
        true,
      ),
    ),
  ];

  const buildFor = (feed: AssignmentFeed) =>
    buildPlan(feed, inputs.existingAssignments, inputs.courses, {
      aliases: inputs.aliases,
      notionTimezone: inputs.notionTimezone,
      now: inputs.now,
      trigger: inputs.trigger ?? "manual",
      ...(inputs.minimumMissingIntervalMs !== undefined
        ? { minimumMissingIntervalMs: inputs.minimumMissingIntervalMs }
        : {}),
    });
  const beforeFields = planFields(buildFor(before));
  const afterFields = planFields(buildFor(after));
  const plan = beforeFields.map((field, position) => {
    const after = afterFields[position]!.before;
    return { ...field, after, changed: field.before !== after };
  });

  return {
    assignments,
    plan,
    summary: {
      assignments: assignments.length,
      codeChanges: assignments.filter((item) => item.codeChanged).length,
      destinationChanges: assignments.filter((item) => item.destinationChanged).length,
      planDestinationChanges: plan.filter((item) => item.kind === "destination" && item.changed)
        .length,
      planCodeChanges: plan.filter((item) => item.kind === "code" && item.changed).length,
    },
  };
}

function code(value: string | undefined): string {
  return value === undefined ? "(none)" : `\`${value}\``;
}

function destination(value: CourseDestination): string {
  return [value.kind, value.method, value.target ? `#${value.target}` : undefined]
    .filter(Boolean)
    .join(" ");
}

export function renderReport(diff: CourseCodeDiff): string {
  const { summary } = diff;
  const verdict =
    summary.destinationChanges === 0 && summary.planDestinationChanges === 0
      ? "No course destination changes."
      : "Course destination changes found; review before merging.";
  const rows = diff.assignments.map((item) => {
    const status = item.destinationChanged
      ? "destination changed"
      : item.codeChanged
        ? "code only"
        : "same";
    return `| ${item.position}${item.cancelled ? " (cancelled)" : ""} | ${code(item.before.code)} | ${code(item.after.code)} | ${destination(item.before.destination)} | ${destination(item.after.destination)} | ${status} |`;
  });
  const planRows = diff.plan.map(
    (item) =>
      `| ${item.field} | ${item.before} | ${item.after} | ${item.changed ? (item.kind === "code" ? "code only" : "changed") : "same"} |`,
  );
  return [
    "## Course-code extraction comparison (issue #26)",
    "",
    `- Assignments compared: ${summary.assignments}`,
    `- Course codes that changed: ${summary.codeChanges}`,
    `- Course destinations that changed: ${summary.destinationChanges}`,
    `- Plan fields that changed (destination): ${summary.planDestinationChanges}`,
    `- Plan fields that changed (code only): ${summary.planCodeChanges}`,
    `- Verdict: ${verdict}`,
    "",
    "### Per-assignment course resolution",
    "",
    "| # | Code before | Code after | Destination before | Destination after | Result |",
    "| --- | --- | --- | --- | --- | --- |",
    ...(rows.length ? rows : ["| (no assignments in feed) | | | | | |"]),
    "",
    "### Dry-run plan comparison",
    "",
    "| Field | Before | After | Result |",
    "| --- | --- | --- | --- |",
    ...planRows,
    "",
  ].join("\n");
}

export async function runComparison(config: AppConfig): Promise<CourseCodeDiff> {
  const logger = createLogger();
  const gateway = new OfficialNotionGateway(config.NOTION_TOKEN, logger);
  const provider = new CanvasIcsProvider(config, logger);
  const feed = await provider.fetchAssignments();
  const [existingAssignments, courses] = await settleReads([
    readAssignments(gateway, config.NOTION_ASSIGNMENTS_DATA_SOURCE_ID),
    readCourses(gateway, config.NOTION_COURSES_DATA_SOURCE_ID),
  ]);
  return compareCourseExtraction({
    feed,
    existingAssignments,
    courses,
    aliases: config.aliases,
    notionTimezone: config.NOTION_TIMEZONE,
    now: new Date(),
    trigger: config.trigger,
    minimumMissingIntervalMs: config.CANVAS_MISSING_EVIDENCE_MINIMUM_HOURS * 60 * 60 * 1000,
  });
}

async function main(): Promise<void> {
  const secrets = [process.env.CANVAS_ICS_URL ?? "", process.env.NOTION_TOKEN ?? ""];
  try {
    const config = await loadConfig(["--mode", "dry-run", "--trigger", "manual"]);
    const diff = await runComparison(config);
    const report = renderReport(diff);
    process.stdout.write(`${report}\n`);
    if (config.GITHUB_STEP_SUMMARY) {
      await appendFile(config.GITHUB_STEP_SUMMARY, `${report}\n`, "utf8");
    }
    if (diff.summary.destinationChanges || diff.summary.planDestinationChanges) {
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${safeError(error, secrets)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
