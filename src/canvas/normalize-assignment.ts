import sanitizeHtml from "sanitize-html";
import TurndownService from "turndown";
import type { AssignmentType, ExternalAssignment } from "../types.js";
import type { ClassificationResult } from "./classify-event.js";

export interface RawCalendarEvent {
  uid?: string;
  summary?: string;
  start?: Date;
  description?: string;
  url?: string;
  location?: string;
  status?: string;
  categories?: string[];
  datetype?: string;
}

const turndown = new TurndownService({ headingStyle: "atx", bulletListMarker: "-" });

export type AssignmentTypeMatcher = (title: string) => AssignmentType;

export function compileAssignmentTypeMatcher(
  rules: Array<{ type: AssignmentType; patterns: string[] }>,
): AssignmentTypeMatcher {
  const compiled = rules.map((rule) => ({
    type: rule.type,
    matchers: rule.patterns.map((pattern) => {
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
      return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, "iu");
    }),
  }));
  return (title) => {
    for (const rule of compiled) {
      if (rule.matchers.some((matcher) => matcher.test(title))) return rule.type;
    }
    return "Other";
  };
}

export function sanitizeDescription(html: string | undefined): {
  plainText?: string;
  markdown?: string;
} {
  if (!html) return {};
  const safeHtml = sanitizeHtml(html, {
    allowedTags: [
      "p",
      "br",
      "strong",
      "em",
      "b",
      "i",
      "ul",
      "ol",
      "li",
      "a",
      "code",
      "pre",
      "blockquote",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
    ],
    allowedAttributes: { a: ["href"] },
    allowedSchemes: ["http", "https", "mailto"],
    disallowedTagsMode: "discard",
  });
  const markdown = turndown.turndown(safeHtml).trim();
  const plainText = sanitizeHtml(safeHtml, { allowedTags: [] }).replace(/\s+/g, " ").trim();
  return {
    ...(plainText ? { plainText } : {}),
    ...(markdown ? { markdown } : {}),
  };
}

function parseCourse(summary: string, description?: string): { name?: string; code?: string } {
  const bracket = summary.match(/\s+\[([^\]]+)]\s*$/);
  const descriptionCourse = description?.match(/(?:course|context)\s*:\s*([^\n<]+)/i)?.[1]?.trim();
  const name = bracket?.[1]?.trim() ?? descriptionCourse;
  if (!name) return {};
  const code = name.match(/\b[A-Z]{2,}\s*[- ]?\d{1,4}[A-Z]?\b/i)?.[0];
  return { name, ...(code ? { code } : {}) };
}

function dueAt(event: RawCalendarEvent): string | undefined {
  if (!event.start || Number.isNaN(event.start.getTime())) return;
  if (event.datetype === "date") {
    // node-ical materializes VALUE=DATE starts at local midnight, so the calendar day must be read
    // from the local components; reading UTC components moves it backwards east of UTC.
    // Known limitation: on a calendar day the local zone skipped entirely (Pacific/Apia lost
    // 2011-12-30), that midnight does not exist and rolls forward, so the next day is reported.
    // Recovering the exact day needs the source DTSTART line, which cannot be re-associated with
    // a parsed event reliably once the parser has normalized and deduplicated UIDs.
    const year = `${event.start.getFullYear()}`.padStart(4, "0");
    const month = `${event.start.getMonth() + 1}`.padStart(2, "0");
    const day = `${event.start.getDate()}`.padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  return event.start.toISOString();
}

export function normalizeAssignment(
  event: RawCalendarEvent,
  classification: ClassificationResult,
  assignmentTypeMatcher: AssignmentTypeMatcher,
): ExternalAssignment {
  const uid = event.uid?.trim();
  const rawTitle = event.summary?.trim();
  if (!uid || !rawTitle) throw new Error("Assignment event is missing UID or SUMMARY");
  const course = parseCourse(rawTitle, event.description);
  const title = rawTitle.replace(/\s+\[[^\]]+]\s*$/, "").trim() || rawTitle;
  const description = sanitizeDescription(event.description);
  const due = dueAt(event);
  return {
    uid,
    title,
    ...(course.name ? { courseName: course.name } : {}),
    ...(course.code ? { courseCode: course.code } : {}),
    ...(classification.canvasCourseId ? { canvasCourseId: classification.canvasCourseId } : {}),
    ...(classification.canvasAssignmentId
      ? { canvasAssignmentId: classification.canvasAssignmentId }
      : {}),
    ...(classification.canvasUrl ? { canvasUrl: classification.canvasUrl } : {}),
    ...(due ? { dueAt: due } : {}),
    ...(description.plainText ? { descriptionPlainText: description.plainText } : {}),
    ...(description.markdown ? { descriptionMarkdown: description.markdown } : {}),
    inferredType: assignmentTypeMatcher(title),
  };
}
