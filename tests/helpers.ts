import type { AppConfig } from "../src/config.js";
import type { AssignmentFeed, AssignmentProvider } from "../src/types.js";
import { createRunMetrics, type NotionGateway } from "../src/notion/client.js";

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
    CANVAS_MISSING_EVIDENCE_MINIMUM_HOURS: 6,
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
  public readonly metrics = createRunMetrics();
  public assignments: Array<Record<string, unknown>> = [];
  public courses: Array<Record<string, unknown>> = [];
  public writes: Array<{ kind: string; id: string; value?: unknown }> = [];
  public readonly listBlocksCalls = new Map<string, number>();
  public failOnAssignmentWrite = false;
  private sequence = 0;
  private readonly blocks = new Map<string, Array<Record<string, unknown>>>();

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
    if (id === "assignments") {
      this.blocks.set(pageId, [
        { id: `${pageId}-template`, type: "paragraph", paragraph: { rich_text: [] } },
      ]);
    }
    return Promise.resolve(pageId);
  }

  public async updatePage(pageId: string, properties: Record<string, unknown>): Promise<void> {
    if (this.failOnAssignmentWrite && pageId.startsWith("assignment"))
      throw new Error("write failed");
    this.writes.push({ kind: "update", id: pageId, value: properties });
    return Promise.resolve();
  }

  public async updateBlock(blockId: string, block: Record<string, unknown>): Promise<void> {
    this.writes.push({ kind: "update-block", id: blockId, value: block });
    for (const values of this.blocks.values()) {
      const index = values.findIndex((candidate) => candidate.id === blockId);
      if (index >= 0) {
        const current = values[index]!;
        values[index] = materializeBlock(blockId, { ...current, ...block });
      }
    }
    return Promise.resolve();
  }

  public async listBlocks(pageId: string): Promise<Array<Record<string, unknown>>> {
    this.listBlocksCalls.set(pageId, (this.listBlocksCalls.get(pageId) ?? 0) + 1);
    return Promise.resolve(this.blocks.get(pageId) ?? []);
  }

  public listBlocksCallCount(parentId: string): number {
    return this.listBlocksCalls.get(parentId) ?? 0;
  }

  public totalListBlocksCalls(): number {
    return [...this.listBlocksCalls.values()].reduce((total, count) => total + count, 0);
  }

  public async appendBlocks(
    parentId: string,
    children: Array<Record<string, unknown>>,
  ): Promise<string[]> {
    this.writes.push({ kind: "append", id: parentId, value: children });
    const ids = children.map(() => `${parentId}-block-${++this.sequence}`);
    const values = this.blocks.get(parentId) ?? [];
    values.push(...children.map((child, index) => materializeBlock(ids[index]!, child)));
    this.blocks.set(parentId, values);
    return Promise.resolve(ids);
  }

  public async deleteBlock(blockId: string): Promise<void> {
    this.writes.push({ kind: "delete", id: blockId });
    for (const [parentId, values] of this.blocks) {
      this.blocks.set(
        parentId,
        values.filter((block) => block.id !== blockId),
      );
    }
    this.blocks.delete(blockId);
    return Promise.resolve();
  }
}

type SimulatedFailure = {
  id: string;
  status?: number;
  code?: string;
  name?: string;
  applied: boolean;
  appliedCount?: number;
};

function simulatedFailure(message: string, failure: SimulatedFailure): Error {
  const error = new Error(message);
  if (failure.status !== undefined) Object.assign(error, { status: failure.status });
  if (failure.code) Object.assign(error, { code: failure.code });
  if (failure.name) error.name = failure.name;
  return error;
}

function richTextValue(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const record = item as Record<string, unknown>;
      if (typeof record.plain_text === "string") return record.plain_text;
      const text = record.text;
      if (!text || typeof text !== "object") return "";
      const content = (text as Record<string, unknown>).content;
      return typeof content === "string" ? content : "";
    })
    .join("");
}

function propertyText(property: unknown): string {
  if (!property || typeof property !== "object") return "";
  const record = property as Record<string, unknown>;
  return richTextValue(record.title ?? record.rich_text);
}

function materializeBlock(id: string, source: Record<string, unknown>): Record<string, unknown> {
  const type = typeof source.type === "string" ? source.type : "paragraph";
  const content = source[type];
  const record = content && typeof content === "object" ? (content as Record<string, unknown>) : {};
  const richText = Array.isArray(record.rich_text)
    ? (record.rich_text as unknown[]).map((item) => {
        if (!item || typeof item !== "object") return {};
        const value = item as Record<string, unknown>;
        const text = value.text;
        const contentValue =
          text && typeof text === "object"
            ? (text as Record<string, unknown>).content
            : value.plain_text;
        return {
          ...value,
          ...(typeof contentValue === "string" ? { plain_text: contentValue } : {}),
        };
      })
    : [];
  return { ...source, id, type, [type]: { ...record, rich_text: richText } };
}

export class StatefulFakeGateway implements NotionGateway {
  public readonly metrics = createRunMetrics();
  public readonly pages = new Map<string, Array<Record<string, unknown>>>();
  public readonly blocks = new Map<string, Array<Record<string, unknown>>>();
  public readonly writes: Array<{ kind: string; id: string; value?: unknown }> = [];
  public readonly listBlocksCalls = new Map<string, number>();
  public readonly createFailures: SimulatedFailure[] = [];
  public readonly appendFailures: SimulatedFailure[] = [];
  public readonly updateFailures: SimulatedFailure[] = [];
  public readonly deleteFailures: SimulatedFailure[] = [];
  public readonly queryVisibilityMisses = new Map<string, number>();
  private sequence = 0;

  public seedPage(dataSourceId: string, id: string, properties: Record<string, unknown>): void {
    const pages = this.pages.get(dataSourceId) ?? [];
    pages.push({ id, properties });
    this.pages.set(dataSourceId, pages);
  }

  public seedBlock(parentId: string, block: Record<string, unknown>): void {
    const values = this.blocks.get(parentId) ?? [];
    const id = typeof block.id === "string" ? block.id : `block-${++this.sequence}`;
    values.push(materializeBlock(id, block));
    this.blocks.set(parentId, values);
  }

  public async retrieveDataSource(id: string): Promise<Record<string, unknown>> {
    return Promise.resolve(
      id === "assignments" ? assignmentSchema : id === "courses" ? courseSchema : logSchema,
    );
  }

  public async queryDataSource(
    id: string,
    filter?: Record<string, unknown>,
  ): Promise<Array<Record<string, unknown>>> {
    const misses = this.queryVisibilityMisses.get(id) ?? 0;
    if (misses > 0) {
      this.queryVisibilityMisses.set(id, misses - 1);
      return Promise.resolve([]);
    }
    const pages = this.pages.get(id) ?? [];
    if (!filter || typeof filter.property !== "string") return Promise.resolve(pages);
    const condition =
      filter.rich_text && typeof filter.rich_text === "object"
        ? (filter.rich_text as Record<string, unknown>)
        : filter.title && typeof filter.title === "object"
          ? (filter.title as Record<string, unknown>)
          : undefined;
    const expected = condition?.equals;
    if (typeof expected !== "string") return Promise.resolve(pages);
    return Promise.resolve(
      pages.filter((page) => {
        const properties = page.properties as Record<string, unknown>;
        return propertyText(properties[filter.property as string]) === expected;
      }),
    );
  }

  public async createPage(id: string, properties: Record<string, unknown>): Promise<string> {
    const failureIndex = this.createFailures.findIndex((failure) => failure.id === id);
    const failure = failureIndex >= 0 ? this.createFailures.splice(failureIndex, 1)[0] : undefined;
    const newPageId = `${id}-${++this.sequence}`;
    this.writes.push({ kind: "create", id, value: properties });
    if (!failure || failure.applied) this.seedPage(id, newPageId, properties);
    if (failure) throw simulatedFailure("simulated create failure", failure);
    return Promise.resolve(newPageId);
  }

  public async updatePage(pageId: string, properties: Record<string, unknown>): Promise<void> {
    const failureIndex = this.updateFailures.findIndex((failure) => failure.id === pageId);
    const failure = failureIndex >= 0 ? this.updateFailures.splice(failureIndex, 1)[0] : undefined;
    this.writes.push({ kind: "update", id: pageId, value: properties });
    if (!failure || failure.applied) {
      for (const pages of this.pages.values()) {
        const page = pages.find((candidate) => candidate.id === pageId);
        if (page) page.properties = { ...(page.properties as object), ...properties };
      }
    }
    if (failure) throw simulatedFailure("simulated update failure", failure);
    return Promise.resolve();
  }

  public async updateBlock(blockId: string, block: Record<string, unknown>): Promise<void> {
    this.writes.push({ kind: "update-block", id: blockId, value: block });
    for (const values of this.blocks.values()) {
      const index = values.findIndex((candidate) => candidate.id === blockId);
      if (index < 0) continue;
      const current = values[index]!;
      const type = typeof current.type === "string" ? current.type : "toggle";
      values[index] = materializeBlock(blockId, { ...current, ...block, type });
      return Promise.resolve();
    }
    return Promise.resolve();
  }

  public async listBlocks(pageId: string): Promise<Array<Record<string, unknown>>> {
    this.listBlocksCalls.set(pageId, (this.listBlocksCalls.get(pageId) ?? 0) + 1);
    return Promise.resolve(this.blocks.get(pageId) ?? []);
  }

  public listBlocksCallCount(parentId: string): number {
    return this.listBlocksCalls.get(parentId) ?? 0;
  }

  public totalListBlocksCalls(): number {
    return [...this.listBlocksCalls.values()].reduce((total, count) => total + count, 0);
  }

  public async appendBlocks(
    parentId: string,
    children: Array<Record<string, unknown>>,
  ): Promise<string[]> {
    const failureIndex = this.appendFailures.findIndex((failure) => failure.id === parentId);
    const failure = failureIndex >= 0 ? this.appendFailures.splice(failureIndex, 1)[0] : undefined;
    const ids = children.map(() => `${parentId}-block-${++this.sequence}`);
    this.writes.push({ kind: "append", id: parentId, value: children });
    if (!failure || failure.applied) {
      const values = this.blocks.get(parentId) ?? [];
      const appliedChildren = children.slice(0, failure?.appliedCount ?? children.length);
      values.push(...appliedChildren.map((child, index) => materializeBlock(ids[index]!, child)));
      this.blocks.set(parentId, values);
    }
    if (failure) throw simulatedFailure("simulated append failure", failure);
    return Promise.resolve(ids);
  }

  public async deleteBlock(blockId: string): Promise<void> {
    this.writes.push({ kind: "delete", id: blockId });
    const failureIndex = this.deleteFailures.findIndex((failure) => failure.id === blockId);
    const failure = failureIndex >= 0 ? this.deleteFailures.splice(failureIndex, 1)[0] : undefined;
    if (!failure || failure.applied) {
      for (const [parentId, values] of this.blocks) {
        this.blocks.set(
          parentId,
          values.filter((block) => block.id !== blockId),
        );
      }
      this.blocks.delete(blockId);
    }
    if (failure) throw simulatedFailure("simulated delete failure", failure);
    return Promise.resolve();
  }
}

export class FakeProvider implements AssignmentProvider {
  public constructor(private readonly feed: AssignmentFeed) {}
  public fetchAssignments() {
    return Promise.resolve(this.feed);
  }
}

export function pageProperty(type: string, value: unknown): Record<string, unknown> {
  return { type, [type]: value };
}
