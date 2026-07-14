import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { ASSIGNMENT_TYPES, type AssignmentType, type RunMode, type Trigger } from "./types.js";

export const DEFAULT_MISSING_EVIDENCE_MINIMUM_HOURS = 6;

const envSchema = z.object({
  CANVAS_ICS_URL: z
    .string()
    .url()
    .refine((url) => url.startsWith("https://"), "must use HTTPS"),
  NOTION_TOKEN: z.string().min(10),
  NOTION_ASSIGNMENTS_DATA_SOURCE_ID: z.string().min(1),
  NOTION_COURSES_DATA_SOURCE_ID: z.string().min(1),
  NOTION_SYNC_LOG_DATA_SOURCE_ID: z.string().min(1),
  NOTION_TIMEZONE: z.string().default("America/Los_Angeles"),
  CANVAS_MISSING_EVIDENCE_MINIMUM_HOURS: z.coerce
    .number()
    .min(DEFAULT_MISSING_EVIDENCE_MINIMUM_HOURS)
    .default(DEFAULT_MISSING_EVIDENCE_MINIMUM_HOURS),
  GITHUB_SERVER_URL: z.string().url().optional(),
  GITHUB_REPOSITORY: z.string().optional(),
  GITHUB_RUN_ID: z.string().optional(),
  GITHUB_RUN_ATTEMPT: z.string().optional(),
  GITHUB_SHA: z.string().optional(),
  GITHUB_STEP_SUMMARY: z.string().optional(),
  GITHUB_ACTIONS: z.enum(["true", "false"]).optional(),
});

const MAX_ALIAS_LENGTH = 200;
const MAX_RULES = 50;
const MAX_PATTERNS_PER_RULE = 50;
const MAX_PATTERN_LENGTH = 200;
const configuredString = (maximum: number) =>
  z
    .string()
    .max(maximum)
    .refine((value) => value.trim().length > 0, "must be a nonempty string");
const aliasesSchema = z
  .record(z.string(), configuredString(MAX_ALIAS_LENGTH))
  .superRefine((aliases, context) => {
    for (const key of Object.keys(aliases)) {
      if (!key.trim()) {
        context.addIssue({ code: "custom", path: [key], message: "key must be nonempty" });
      } else if (key.length > MAX_ALIAS_LENGTH) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: `key must contain at most ${MAX_ALIAS_LENGTH} characters`,
        });
      }
    }
  });
const assignmentTypeRulesSchema = z
  .array(
    z
      .object({
        type: z.enum(ASSIGNMENT_TYPES),
        patterns: z.array(configuredString(MAX_PATTERN_LENGTH)).min(1).max(MAX_PATTERNS_PER_RULE),
      })
      .strict(),
  )
  .min(1)
  .max(MAX_RULES)
  .superRefine((rules, context) => {
    const seen = new Map<string, string>();
    for (const [ruleIndex, rule] of rules.entries()) {
      for (const [patternIndex, pattern] of rule.patterns.entries()) {
        const normalized = pattern.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
        const key = `${rule.type}\u0000${normalized}`;
        if (seen.has(key)) {
          context.addIssue({
            code: "custom",
            path: [ruleIndex, "patterns", patternIndex],
            message: `duplicates ${seen.get(key)} after normalization`,
          });
        } else {
          seen.set(key, `rule ${ruleIndex} pattern ${patternIndex}`);
        }
      }
    }
  });

export interface AppConfig extends z.infer<typeof envSchema> {
  mode: RunMode;
  trigger: Trigger;
  disableRemovals: boolean;
  aliases: Record<string, string>;
  assignmentTypeRules: Array<{ type: AssignmentType; patterns: string[] }>;
}

function parseArguments(argv: string[]): Pick<AppConfig, "mode" | "trigger" | "disableRemovals"> {
  let mode: RunMode = "sync";
  let trigger: Trigger = "manual";
  let disableRemovals = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--disable-removals") {
      disableRemovals = true;
    } else if (argument === "--mode") {
      const value = argv[index + 1];
      if (!value || !["sync", "dry-run", "validate"].includes(value)) {
        throw new Error("--mode must be sync, dry-run, or validate");
      }
      mode = value as RunMode;
      index += 1;
    } else if (argument === "--trigger") {
      const value = argv[index + 1];
      if (!value || !["scheduled", "manual"].includes(value)) {
        throw new Error("--trigger must be scheduled or manual");
      }
      trigger = value as Trigger;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument ?? ""}`);
    }
  }
  return { mode, trigger, disableRemovals };
}

function invalidConfig(file: string, error: z.ZodError): Error {
  const issue = error.issues[0];
  const path = issue?.path.length ? JSON.stringify(issue.path) : "root";
  return new Error(`${file}: invalid value at ${path}: ${issue?.message ?? "invalid structure"}`);
}

export function parseCourseAliases(value: unknown): Record<string, string> {
  const result = aliasesSchema.safeParse(value);
  if (!result.success) throw invalidConfig("config/course-aliases.json", result.error);
  return result.data;
}

export function parseAssignmentTypeRules(
  value: unknown,
): Array<{ type: AssignmentType; patterns: string[] }> {
  const result = assignmentTypeRulesSchema.safeParse(value);
  if (!result.success) throw invalidConfig("config/assignment-type-rules.json", result.error);
  return result.data;
}

async function readJsonIfPresent(path: string, file: string): Promise<unknown> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(`${file}: could not be read`, { cause: error });
  }
  return parseJsonConfiguration(source, file);
}

export function parseJsonConfiguration(source: string, file: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new Error(`${file}: malformed JSON`);
  }
}

export async function loadConfig(
  argv = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  configurationDirectory = "config",
): Promise<AppConfig> {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`Invalid environment configuration: ${fields}`);
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: parsed.data.NOTION_TIMEZONE }).format();
  } catch {
    throw new Error("Invalid environment configuration: NOTION_TIMEZONE");
  }
  const [aliasesValue, rulesValue] = await Promise.all([
    readJsonIfPresent(
      resolve(configurationDirectory, "course-aliases.json"),
      "config/course-aliases.json",
    ),
    readJsonIfPresent(
      resolve(configurationDirectory, "assignment-type-rules.json"),
      "config/assignment-type-rules.json",
    ),
  ]);
  const aliases = aliasesValue === undefined ? {} : parseCourseAliases(aliasesValue);
  const rules = rulesValue === undefined ? [] : parseAssignmentTypeRules(rulesValue);
  return { ...parsed.data, ...parseArguments(argv), aliases, assignmentTypeRules: rules };
}

export function workflowUrl(config: AppConfig): string | undefined {
  if (!config.GITHUB_SERVER_URL || !config.GITHUB_REPOSITORY || !config.GITHUB_RUN_ID) return;
  return `${config.GITHUB_SERVER_URL}/${config.GITHUB_REPOSITORY}/actions/runs/${config.GITHUB_RUN_ID}`;
}
