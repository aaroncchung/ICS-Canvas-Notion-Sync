import { describe, expect, it } from "vitest";
import {
  parseAssignmentTypeRules,
  parseCourseAliases,
  parseJsonConfiguration,
} from "../../src/config.js";

describe("optional JSON configuration", () => {
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
