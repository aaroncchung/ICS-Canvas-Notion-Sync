import type { AppConfig } from "../src/config.js";
import type { AssignmentFeed, AssignmentProvider } from "../src/types.js";
import type { NotionGateway } from "../src/notion/client.js";

export const rules: AppConfig["assignmentTypeRules"] = [
  { type: "Quiz", patterns: ["quiz"] },
  { type: "Exam", patterns: ["exam", "test"] },
  { type: "Lab", patterns: ["lab"] },
  { type: "Paper", patterns: ["paper", "essay"] },
  { type: "Project", patterns: ["project"] },
  { type: "Reading", patterns: ["reading"] },
  { type: "Homework", patterns: ["homework", "problem set", "pset"] },
];

export function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    CANVAS_ICS_URL: "https://canvas.example.edu/private/feed.ics?token=test-secret",
    NOTION_TOKEN: "secret_test-token-value",
    NOTION_ASSIGNMENTS_DATA_SOURCE_ID: "assignments",
    NOTION_COURSES_DATA_SOURCE_ID: "courses",
    NOTION_SYNC_LOG_DATA_SOURCE_ID: "log",
    NOTION_TIMEZONE: "America/Los_Angeles",
    mode: "sync",
    trigger: "manual",
    disableRemovals: false,
    aliases: {},
    assignmentTypeRules: rules,
    ...overrides,
  };
}

function schema(properties: Record<string, string>): Record<string, unknown> {
  const optionsByProperty: Record<string, string[]> = {
    "Personal Status": ["Not started", "In progress", "Done"],
    "Assignment Type": ["Homework", "Lab", "Quiz", "Exam", "Paper", "Project", "Reading", "Other"],
    "Canvas State": ["Active", "Removed"],
    "Imported From": ["Canvas ICS"],
    Status: ["Success", "Warning", "Failed", "Dry Run"],
    Trigger: ["Scheduled", "Manual"],
    Mode: ["Sync", "Dry Run", "Validate"],
  };
  return {
    properties: Object.fromEntries(
      Object.entries(properties).map(([name, type]) => [
        name,
        {
          type,
          ...(type === "relation" ? { relation: { data_source_id: "courses" } } : {}),
          ...(optionsByProperty[name]
            ? { [type]: { options: optionsByProperty[name].map((option) => ({ name: option })) } }
            : {}),
        },
      ]),
    ),
  };
}

const assignmentSchema = schema({
  Assignment: "title",
  Course: "relation",
  "Effective Due Date": "date",
  "Canvas Due Date": "date",
  "Override Due Date": "date",
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
  Notes: "rich_text",
});

const courseSchema = schema({
  Course: "title",
  "Course Code": "rich_text",
  "Canvas Course ID": "rich_text",
  "Canvas URL": "url",
  Active: "checkbox",
  "Sync Updated At": "date",
});

const logSchema = schema({
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
});

export class FakeGateway implements NotionGateway {
  public assignments: Array<Record<string, unknown>> = [];
  public courses: Array<Record<string, unknown>> = [];
  public writes: Array<{ kind: string; id: string; value?: unknown }> = [];
  public failOnAssignmentWrite = false;
  private sequence = 0;

  public async retrieveDataSource(id: string): Promise<Record<string, unknown>> {
    return Promise.resolve(
      id === "assignments" ? assignmentSchema : id === "courses" ? courseSchema : logSchema,
    );
  }

  public async queryDataSource(id: string): Promise<Array<Record<string, unknown>>> {
    return Promise.resolve(id === "assignments" ? this.assignments : this.courses);
  }

  public async createPage(id: string, properties: Record<string, unknown>): Promise<string> {
    if (this.failOnAssignmentWrite && id === "assignments")
      throw Object.assign(new Error("write failed"), { status: 400 });
    const pageId = `${id}-${++this.sequence}`;
    this.writes.push({ kind: "create", id, value: properties });
    return Promise.resolve(pageId);
  }

  public async updatePage(pageId: string, properties: Record<string, unknown>): Promise<void> {
    if (this.failOnAssignmentWrite && pageId.startsWith("assignment"))
      throw new Error("write failed");
    this.writes.push({ kind: "update", id: pageId, value: properties });
    return Promise.resolve();
  }

  public async listBlocks(): Promise<Array<Record<string, unknown>>> {
    return Promise.resolve([{ id: "template", type: "paragraph", paragraph: { rich_text: [] } }]);
  }

  public async appendBlocks(
    parentId: string,
    children: Array<Record<string, unknown>>,
  ): Promise<string[]> {
    this.writes.push({ kind: "append", id: parentId, value: children });
    return Promise.resolve(children.map((_, index) => `${parentId}-block-${index}`));
  }

  public async deleteBlock(blockId: string): Promise<void> {
    this.writes.push({ kind: "delete", id: blockId });
    return Promise.resolve();
  }
}

export class FakeProvider implements AssignmentProvider {
  public constructor(public lastFeed: AssignmentFeed) {}
  public fetchAssignments() {
    return Promise.resolve(this.lastFeed.assignments);
  }
}

export function pageProperty(type: string, value: unknown): Record<string, unknown> {
  return { type, [type]: value };
}
