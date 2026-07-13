import { readFile } from "node:fs/promises";
import { accessSync, constants } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { ASSIGNMENT_TYPES, type AssignmentType, type RunMode, type Trigger } from "./types.js";

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
  GITHUB_SERVER_URL: z.string().url().optional(),
  GITHUB_REPOSITORY: z.string().optional(),
  GITHUB_RUN_ID: z.string().optional(),
  GITHUB_SHA: z.string().optional(),
  GITHUB_STEP_SUMMARY: z.string().optional(),
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

async function readJsonIfPresent<T>(path: string, fallback: T): Promise<T> {
  try {
    accessSync(path, constants.R_OK);
  } catch {
    return fallback;
  }
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function loadConfig(
  argv = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
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
  const aliases = await readJsonIfPresent<Record<string, string>>(
    resolve("config/course-aliases.json"),
    {},
  );
  const rules = await readJsonIfPresent<Array<{ type: AssignmentType; patterns: string[] }>>(
    resolve("config/assignment-type-rules.json"),
    [],
  );
  if (rules.some((rule) => !ASSIGNMENT_TYPES.includes(rule.type))) {
    throw new Error("Invalid assignment type in config/assignment-type-rules.json");
  }
  return { ...parsed.data, ...parseArguments(argv), aliases, assignmentTypeRules: rules };
}

export function workflowUrl(config: AppConfig): string | undefined {
  if (!config.GITHUB_SERVER_URL || !config.GITHUB_REPOSITORY || !config.GITHUB_RUN_ID) return;
  return `${config.GITHUB_SERVER_URL}/${config.GITHUB_REPOSITORY}/actions/runs/${config.GITHUB_RUN_ID}`;
}
