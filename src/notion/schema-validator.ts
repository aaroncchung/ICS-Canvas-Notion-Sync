import type { AppConfig } from "../config.ts";
import { ASSIGNMENT_TYPES } from "../types.ts";
import { settleReads, type NotionGateway } from "./client.ts";

type Expected = Record<string, string | string[]>;

const ASSIGNMENTS: Expected = {
  Assignment: "title",
  Course: "relation",
  "Effective Due Date": "date",
  "Canvas Due Date": "date",
  "Override Due Date": "date",
  "Canvas Missing Since": "date",
  "Canvas Missing Count": "number",
  "Personal Status": "status",
  Priority: "select",
  "Assignment Type": "select",
  "Canvas URL": "url",
  "Canvas UID": "rich_text",
  "Canvas State": "select",
  "Imported From": "select",
  "Last Synced": "date",
  "Removed from Canvas": "checkbox",
  "Raw Description": "rich_text",
  "Canvas Description Hash": "rich_text",
  "Canvas Description Verified At": "date",
  Notes: "rich_text",
};

const COURSES: Expected = {
  Course: "title",
  "Course Code": "rich_text",
  "Canvas Course ID": "rich_text",
  "Canvas URL": "url",
  Active: "checkbox",
  "Sync Updated At": "date",
};

const SYNC_LOG: Expected = {
  Run: "title",
  "Started At": "date",
  "Finished At": "date",
  Status: "select",
  Trigger: "select",
  Mode: "select",
  "Feed Items": "number",
  "Assignments Parsed": "number",
  Created: "number",
  Updated: "number",
  Removed: "number",
  Unchanged: "number",
  Skipped: "number",
  "Warning Count": "number",
  "Error Summary": "rich_text",
  "Workflow URL": "url",
  "Commit SHA": "rich_text",
};

function validateProperties(
  label: string,
  response: Record<string, unknown>,
  expected: Expected,
): Record<string, Record<string, unknown>> {
  if (!response.properties || typeof response.properties !== "object") {
    throw new Error(`${label} data source did not return a property schema`);
  }
  const properties = response.properties as Record<string, Record<string, unknown>>;
  const problems: string[] = [];
  for (const [name, types] of Object.entries(expected)) {
    const actual = properties[name]?.type;
    const allowed = Array.isArray(types) ? types : [types];
    if (typeof actual !== "string") problems.push(`${name} is missing`);
    else if (!allowed.includes(actual)) problems.push(`${name} must be ${allowed.join(" or ")}`);
  }
  if (problems.length) throw new Error(`${label} schema is incompatible: ${problems.join("; ")}`);
  return properties;
}

function validateOptions(
  label: string,
  properties: Record<string, Record<string, unknown>>,
  propertyName: string,
  required: readonly string[],
): void {
  const property = properties[propertyName];
  if (!property) throw new Error(`${label} schema is incompatible: ${propertyName} is missing`);
  const type = property?.type;
  const configuration =
    typeof type === "string" && property[type] && typeof property[type] === "object"
      ? (property[type] as Record<string, unknown>)
      : undefined;
  const options = Array.isArray(configuration?.options) ? configuration.options : [];
  const names = options.flatMap((option) => {
    if (!option || typeof option !== "object") return [];
    const name = (option as Record<string, unknown>).name;
    return typeof name === "string" ? [name] : [];
  });
  const missing = required.filter((name) => !names.includes(name));
  if (missing.length) {
    throw new Error(
      `${label} schema is incompatible: ${propertyName} is missing options ${missing.join(", ")}`,
    );
  }
}

export async function validateNotionSchemas(
  gateway: NotionGateway,
  config: AppConfig,
): Promise<void> {
  const [assignments, courses, syncLog] = await settleReads([
    gateway.retrieveDataSource(config.NOTION_ASSIGNMENTS_DATA_SOURCE_ID),
    gateway.retrieveDataSource(config.NOTION_COURSES_DATA_SOURCE_ID),
    gateway.retrieveDataSource(config.NOTION_SYNC_LOG_DATA_SOURCE_ID),
  ]);
  const assignmentProperties = validateProperties("Assignments", assignments, ASSIGNMENTS);
  validateProperties("Courses", courses, COURSES);
  const syncLogProperties = validateProperties("Sync Log", syncLog, SYNC_LOG);

  validateOptions("Assignments", assignmentProperties, "Personal Status", [
    "Not started",
    "In progress",
    "Done",
  ]);
  validateOptions("Assignments", assignmentProperties, "Assignment Type", ASSIGNMENT_TYPES);
  validateOptions("Assignments", assignmentProperties, "Canvas State", ["Active", "Removed"]);
  validateOptions("Assignments", assignmentProperties, "Imported From", ["Canvas ICS"]);
  validateOptions("Sync Log", syncLogProperties, "Status", [
    "Success",
    "Warning",
    "Failed",
    "Dry Run",
  ]);
  validateOptions("Sync Log", syncLogProperties, "Trigger", ["Scheduled", "Manual"]);
  validateOptions("Sync Log", syncLogProperties, "Mode", ["Sync", "Dry Run", "Validate"]);

  const relation = assignmentProperties.Course?.relation;
  const relationRecord =
    relation && typeof relation === "object" ? (relation as Record<string, unknown>) : undefined;
  const target = relationRecord?.data_source_id;
  if (target !== config.NOTION_COURSES_DATA_SOURCE_ID) {
    throw new Error("Assignments Course relation targets the wrong data source");
  }
}
