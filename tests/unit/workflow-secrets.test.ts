import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = (
  await readFile(new URL("../../.github/workflows/sync.yml", import.meta.url), "utf8")
).replaceAll("\r\n", "\n");
const preflight = workflow
  .split("      - name: Check required secrets\n")[1]!
  .split("      - uses: actions/checkout@")[0]!;
const script = preflight
  .split("        run: |\n")[1]!
  .split("\n")
  .map((line) => line.replace(/^ {10}/, ""))
  .join("\n");
const bash =
  process.platform === "win32"
    ? join(process.env.ProgramFiles ?? "C:/Program Files", "Git/bin/bash.exe")
    : "bash";
const canvas = "https://canvas.example.edu/private-feed.ics?secret=sentinel";
const token = "secret_sentinel-notion-token";

describe("workflow secret preflight", () => {
  it("checks both secrets as the first step, before checkout", () => {
    expect(workflow).toMatch(/ {4}steps:\n(?: {6}#.*\n)* {6}- name: Check required secrets\n/);
    expect(preflight).toContain("CANVAS_ICS_URL: ${{ secrets.CANVAS_ICS_URL }}");
    expect(preflight).toContain("NOTION_TOKEN: ${{ secrets.NOTION_TOKEN }}");
  });

  it.each([
    ["", "", ["CANVAS_ICS_URL", "NOTION_TOKEN"]],
    ["", token, ["CANVAS_ICS_URL"]],
    [canvas, "", ["NOTION_TOKEN"]],
    [canvas, token, []],
  ])(
    "reports only missing names without leaking values (%s, %s)",
    async (url, notionToken, missing) => {
      const directory = await mkdtemp(join(tmpdir(), "workflow-secrets-"));
      const summaryPath = join(directory, "summary.md");
      try {
        const result = spawnSync(
          bash,
          ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              CANVAS_ICS_URL: url,
              NOTION_TOKEN: notionToken,
              GITHUB_SERVER_URL: "https://github.com",
              GITHUB_REPOSITORY: "aaroncchung/ICS-Canvas-Notion-Sync",
              GITHUB_STEP_SUMMARY: summaryPath.replaceAll("\\", "/"),
            },
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(missing.length ? 1 : 0);
        expect(result.stderr).toBe("");
        if (missing.length) {
          expect(result.stdout).toContain(
            `::error title=Missing required secrets::Missing required secrets in aaroncchung/ICS-Canvas-Notion-Sync: ${missing.join(", ")}.`,
          );
          expect(result.stdout).toContain(
            "private ICS-Canvas-Notion-Sync-runner repository's Actions tab",
          );
          expect(result.stdout).toContain("/settings/secrets/actions");
          const summary = await readFile(summaryPath, "utf8");
          expect(result.stdout).toBe(`::error title=Missing required secrets::${summary}`);
        } else {
          expect(result.stdout).toBe("");
        }
        expect(result.stdout).not.toContain(canvas);
        expect(result.stdout).not.toContain(token);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
