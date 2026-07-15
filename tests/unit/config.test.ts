import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadConfig,
  parseAssignmentTypeRules,
  parseCourseAliases,
  parseJsonConfiguration,
} from "../../src/config.js";

const environment = {
  CANVAS_ICS_URL: "https://canvas.example.edu/feed.ics",
  NOTION_TOKEN: "secret_test-token",
  NOTION_ASSIGNMENTS_DATA_SOURCE_ID: "assignments",
  NOTION_COURSES_DATA_SOURCE_ID: "courses",
  NOTION_SYNC_LOG_DATA_SOURCE_ID: "log",
};

const temporaryDirectories: string[] = [];

async function temporaryConfigDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "canvas-notion-config-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("optional JSON configuration", () => {
  it("uses defaults when both optional files are missing", async () => {
    const directory = await temporaryConfigDirectory();
    await expect(loadConfig([], environment, directory)).resolves.toMatchObject({
      aliases: {},
      assignmentTypeRules: [],
    });
  });

  it("loads either optional file when the other is missing", async () => {
    const aliasesOnly = await temporaryConfigDirectory();
    await writeFile(join(aliasesOnly, "course-aliases.json"), '{"EN 1":"Engineering 1"}');
    await expect(loadConfig([], environment, aliasesOnly)).resolves.toMatchObject({
      aliases: { "EN 1": "Engineering 1" },
      assignmentTypeRules: [],
    });

    const rulesOnly = await temporaryConfigDirectory();
    await writeFile(
      join(rulesOnly, "assignment-type-rules.json"),
      '[{"type":"Quiz","patterns":["quiz"]}]',
    );
    await expect(loadConfig([], environment, rulesOnly)).resolves.toMatchObject({
      aliases: {},
      assignmentTypeRules: [{ type: "Quiz", patterns: ["quiz"] }],
    });
  });

  it.each([
    ["course-aliases.json", "config/course-aliases.json"],
    ["assignment-type-rules.json", "config/assignment-type-rules.json"],
  ])(
    "reports the correct optional filename for an independent read failure",
    async (file, label) => {
      const directory = await temporaryConfigDirectory();
      await mkdir(join(directory, file));
      await expect(loadConfig([], environment, directory)).rejects.toThrow(
        `${label}: could not be read`,
      );
    },
  );

  it("defaults missing-evidence removal to six hours and rejects shorter intervals", async () => {
    await expect(loadConfig([], environment)).resolves.toMatchObject({
      CANVAS_MISSING_EVIDENCE_MINIMUM_HOURS: 6,
    });
    await expect(
      loadConfig([], { ...environment, CANVAS_MISSING_EVIDENCE_MINIMUM_HOURS: "5" }),
    ).rejects.toThrow("Invalid environment configuration");
  });

  it("rejects malformed JSON with the configuration filename", () => {
    expect(() => parseJsonConfiguration("{", "config/course-aliases.json")).toThrow(
      "config/course-aliases.json: malformed JSON",
    );
  });

  it.each([null, [], { "": "EE 10" }, { EE: " " }, { EE: { course: "EE 10" } }])(
    "rejects structurally invalid course aliases",
    (value) => {
      expect(() => parseCourseAliases(value)).toThrow("config/course-aliases.json");
    },
  );

  it("preserves configured alias spelling for diagnostics", () => {
    expect(parseCourseAliases({ "  EN 1  ": "Engineering One" })).toEqual({
      "  EN 1  ": "Engineering One",
    });
  });

  it.each([
    ["punctuation", "EE-10", "EE 10"],
    ["whitespace", "EE   10", " EE 10 "],
    ["Unicode normalization", "Caf\u00e9", "Cafe\u0301"],
    ["casing", "Engineering One", "engineering one"],
  ])("rejects %s collisions between normalized alias sources", (_label, first, second) => {
    const aliases = { [first]: "Target One", [second]: "Target Two" };
    expect(() => parseCourseAliases(aliases)).toThrow(second);
    expect(() => parseCourseAliases(aliases)).toThrow(first);
    expect(() => parseCourseAliases(aliases)).toThrow("their targets differ");
  });

  it("rejects equivalent normalized alias mappings for clarity", () => {
    const aliases = {
      "EN-1": "Engineering-One",
      " en 1 ": "engineering one",
    };
    expect(() => parseCourseAliases(aliases)).toThrow(" en 1 ");
    expect(() => parseCourseAliases(aliases)).toThrow("EN-1");
    expect(() => parseCourseAliases(aliases)).toThrow(
      "equivalent mappings are rejected for clarity",
    );
  });

  const invalidRules: unknown[] = [
    [],
    [{ type: "Unsupported", patterns: ["quiz"] }],
    [{ type: "Quiz", patterns: [] }],
    [{ type: "Quiz", patterns: [""] }],
    [
      { type: "Quiz", patterns: ["Problem   Set"] },
      { type: "Quiz", patterns: [" problem set "] },
    ],
  ];

  it.each(invalidRules.map((value) => [value]))(
    "rejects structurally invalid assignment type rules",
    (value) => {
      expect(() => parseAssignmentTypeRules(value)).toThrow("config/assignment-type-rules.json");
    },
  );
});
