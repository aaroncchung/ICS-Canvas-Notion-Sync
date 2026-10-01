import { pino, type DestinationStream } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseIcs } from "../../src/canvas/parse-ics.ts";
import { run, workflowAnnotations } from "../../src/cli.ts";
import { OfficialNotionGateway } from "../../src/notion/client.ts";
import { AmbiguousNotionWriteError } from "../../src/notion/failure.ts";
import { writeSyncLog } from "../../src/notion/sync-log.ts";
import { createLogger } from "../../src/observability/logger.ts";
import { safeError } from "../../src/observability/redaction.ts";
import { sliceText, truncateText } from "../../src/text.ts";
import type { ExternalAssignment } from "../../src/types.ts";
import {
  assignmentFeed,
  assignmentTypeMatcher,
  config,
  FakeGateway,
  FakeProvider,
  runResult,
} from "../helpers.ts";

const UID = "event-assignment-987654";
const PRIVATE_TEXT = "read chapter five of MyPrivateNotes";
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function capture(): { stream: DestinationStream; lines: string[] } {
  const lines: string[] = [];
  return { lines, stream: { write: (line: string) => void lines.push(line) } };
}

/**
 * A sync run with one new assignment whose page create fails with `error`, and whose Sync Log
 * create fails with `logError` when one is given.
 */
async function failedRun(error: Error, logError?: Error) {
  const gateway = new FakeGateway();
  gateway.courses.push({
    id: "course",
    properties: {
      Course: { title: [{ plain_text: "EE 10" }] },
      "Canvas Course ID": { rich_text: [{ plain_text: "123" }] },
    },
  });
  const createPage = gateway.createPage.bind(gateway);
  vi.spyOn(gateway, "createPage").mockImplementation((id, properties, options) =>
    id === "assignments"
      ? Promise.reject(error)
      : id === "log" && logError
        ? Promise.reject(logError)
        : createPage(id, properties, options),
  );
  const assignment: ExternalAssignment = {
    uid: UID,
    title: "Homework",
    courseName: "EE 10",
    canvasCourseId: "123",
    dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    inferredType: "Homework",
  };
  const feed = assignmentFeed({ assignments: [assignment] });
  feed.diagnostics.totalEvents = 1;
  feed.diagnostics.sourceUids = [UID];
  feed.diagnostics.normalizedAssignmentUids = [UID];
  const log = capture();
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    const result = await run(config({ GITHUB_ACTIONS: "true", GITHUB_RUN_ID: "redaction" }), {
      gateway,
      provider: new FakeProvider(feed),
      logger: createLogger(log.stream),
    });
    const annotations = stdout.mock.calls.map(([chunk]) => String(chunk));
    return { gateway, result, annotations, logLines: log.lines };
  } finally {
    stdout.mockRestore();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("surrogate-safe truncation", () => {
  it("never keeps half of a surrogate pair at either end", () => {
    const text = "ab😀cd😀";
    expect(truncateText(text, 3)).toBe("ab");
    expect(truncateText(text, 4)).toBe("ab😀");
    expect(sliceText(text, 3, 6)).toBe("cd");
    expect(sliceText(text, 2, 7)).toBe("😀cd");
    expect(truncateText("plain", 10)).toBe("plain");
  });

  it("keeps sanitized error text well formed at its length limits", () => {
    const message = safeError(new Error(`${"a".repeat(799)}😀 tail`));
    expect(message).not.toMatch(LONE_SURROGATE);
    expect(message).toContain("a".repeat(799));
  });
});

describe("failure details stay out of GitHub Actions output", () => {
  it("annotates and logs only the failure kind while the Sync Log keeps the details", async () => {
    const { gateway, result, annotations, logLines } = await failedRun(
      new Error(`${UID}: ${PRIVATE_TEXT} ${"x".repeat(300)}`),
    );
    expect(result.status).toBe("Failed");
    const error = annotations.filter((line) => line.startsWith("::error::"));
    expect(error).toEqual([
      "::error::assignment-page-create failed; 3 later operation(s) not attempted. See the Notion Sync Log for details.\n",
    ]);
    const output = [...annotations, ...logLines].join("\n");
    expect(output).not.toContain(UID);
    expect(output).not.toContain("MyPrivateNotes");

    // The full message is kept, not cut at 240 characters, and the Sync Log body records it.
    expect(result.execution?.failedOperation?.message).toContain("x".repeat(300));
    const syncLog = JSON.stringify([...gateway.blocks.values()]);
    expect(syncLog).toContain(UID);
    expect(syncLog).toContain(PRIVATE_TEXT);
  });

  it("logs only the classification of a Sync Log failure, which can quote the report", async () => {
    const { result, annotations, logLines } = await failedRun(
      new Error(`${UID}: ${PRIVATE_TEXT}`),
      Object.assign(new Error(`body.children: "${PRIVATE_TEXT}" (${UID}) is invalid`), {
        status: 400,
        code: "validation_error",
      }),
    );
    expect(result.status).toBe("Failed");
    expect(result.errors.join("\n")).toContain("Sync Log write failed");
    const output = [...annotations, ...logLines].join("\n");
    expect(output).not.toContain(UID);
    expect(output).not.toContain("MyPrivateNotes");
    const logged = logLines
      .map((line) => JSON.parse(line) as { msg: string; diagnostic?: unknown })
      .find((line) => line.msg === "Could not persist the run to Notion Sync Log");
    expect(logged?.diagnostic).toEqual({
      name: "Error",
      failureClass: "definite-response",
      status: 400,
      code: "validation_error",
    });
  });

  it("labels an apply failure by its cause", async () => {
    const ambiguous = await failedRun(new AmbiguousNotionWriteError(`lost ${PRIVATE_TEXT}`));
    expect(ambiguous.result.errors[0]).toBe(
      "ambiguous-write: ApplyPlanError: assignment-page-create ambiguous",
    );
    const rejected = await failedRun(
      Object.assign(new Error(`validation failed for ${PRIVATE_TEXT}`), { status: 400 }),
    );
    expect(rejected.result.errors[0]).toBe(
      "definite-response: ApplyPlanError: assignment-page-create failed (status 400)",
    );
  });

  it("annotates warnings in dry runs and failed runs", () => {
    const value = runResult({
      status: "Dry Run",
      warnings: [{ code: "suspicious", message: "1 assignment-like event(s) were quarantined" }],
    });
    expect(workflowAnnotations(config({ GITHUB_ACTIONS: "true" }), value)).toEqual([
      "::warning::Run found meaningful diagnostics (suspicious=0, malformed=0, duplicates=0, quarantined=0): 1 assignment-like event(s) were quarantined",
    ]);
    value.status = "Failed";
    expect(workflowAnnotations(config({ GITHUB_ACTIONS: "true" }), value)).toEqual([
      "::error::1 error(s) recorded. See workflow logs for details.",
      "::warning::Run found meaningful diagnostics (suspicious=0, malformed=0, duplicates=0, quarantined=0): 1 assignment-like event(s) were quarantined",
    ]);
    value.status = "Dry Run";
    value.warnings = [];
    expect(workflowAnnotations(config({ GITHUB_ACTIONS: "true" }), value)).toEqual([]);
  });

  it("keeps the Notion SDK's failed-request messages out of the console", async () => {
    const body = {
      object: "error",
      status: 400,
      code: "validation_error",
      message: `Title "${PRIVATE_TEXT}" is invalid`,
      request_id: "req-123",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 400,
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    );
    const consoleCalls = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const log = capture();
    const gateway = new OfficialNotionGateway(
      "secret_test-token-value",
      pino({ level: "debug" }, log.stream),
    );
    await expect(gateway.updatePage("page", {})).rejects.toMatchObject({ status: 400 });
    for (const spy of [...consoleCalls, stderr]) expect(spy).not.toHaveBeenCalled();
    const sdkLines = log.lines.filter((line) => line.includes("Notion SDK"));
    expect(sdkLines).toHaveLength(1);
    expect(JSON.parse(sdkLines[0]!)).toMatchObject({
      sdkLevel: "warn",
      code: "validation_error",
      requestId: "req-123",
      msg: "Notion SDK: request fail",
    });
    expect(log.lines.join("\n")).not.toContain("MyPrivateNotes");
  });

  it("counts node-ical warnings instead of printing their UIDs", () => {
    const warn = vi.spyOn(console, "warn");
    const event = (sequence: number) =>
      [
        "BEGIN:VEVENT",
        `UID:${UID}`,
        `SEQUENCE:${sequence}`,
        "DTSTART:20261001T120000Z",
        "SUMMARY:Homework",
        "END:VEVENT",
      ].join("\r\n");
    const feed = parseIcs(
      ["BEGIN:VCALENDAR", "VERSION:2.0", event(2), event(1), "END:VCALENDAR"].join("\r\n"),
      assignmentTypeMatcher,
    );
    expect(warn).not.toHaveBeenCalled();
    expect(feed.diagnostics.parserWarnings).toBe(1);
    expect(console.warn).toBe(warn);
  });
});

describe("Sync Log run identity", () => {
  it("keeps a separate page for each re-run attempt", async () => {
    const titles = async (attempt?: string) => {
      const gateway = new FakeGateway();
      await writeSyncLog(
        gateway,
        config({ GITHUB_RUN_ID: "42", ...(attempt ? { GITHUB_RUN_ATTEMPT: attempt } : {}) }),
        "start",
        "finish",
        runResult(),
      );
      return JSON.stringify(gateway.pages.get("log"));
    };
    expect(await titles()).toContain('"Canvas sync GitHub run 42"');
    expect(await titles("1")).toContain('"Canvas sync GitHub run 42"');
    expect(await titles("2")).toContain('"Canvas sync GitHub run 42 attempt 2"');
  });
});
