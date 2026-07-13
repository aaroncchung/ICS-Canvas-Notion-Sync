import ical from "node-ical";
import type { AssignmentType, AssignmentFeed } from "../types.js";
import { classifyEvent } from "./classify-event.js";
import { normalizeAssignment, type RawCalendarEvent } from "./normalize-assignment.js";

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asDate(value: unknown): Date | undefined {
  return value instanceof Date ? value : undefined;
}

function toEvent(value: unknown): RawCalendarEvent | undefined {
  if (!value || typeof value !== "object") return;
  const item = value as Record<string, unknown>;
  if (item.type !== "VEVENT") return;
  const categories = Array.isArray(item.categories)
    ? item.categories.filter((category): category is string => typeof category === "string")
    : typeof item.categories === "string"
      ? [item.categories]
      : undefined;
  const start = asDate(item.start);
  const dateOnly =
    item.datetype === "date" ||
    (start && "dateOnly" in start && (start as Date & { dateOnly?: boolean }).dateOnly);
  const uid = asString(item.uid);
  const summary = asString(item.summary);
  const end = asDate(item.end);
  const description = asString(item.description);
  const url = asString(item.url);
  const location = asString(item.location);
  const lastmodified = asDate(item.lastmodified);
  const status = asString(item.status);
  return {
    ...(uid ? { uid } : {}),
    ...(summary ? { summary } : {}),
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
    ...(description ? { description } : {}),
    ...(url ? { url } : {}),
    ...(location ? { location } : {}),
    ...(lastmodified ? { lastmodified } : {}),
    ...(typeof item.sequence === "number" ? { sequence: item.sequence } : {}),
    ...(status ? { status } : {}),
    ...(categories ? { categories } : {}),
    ...(dateOnly ? { datetype: "date" } : {}),
  };
}

export function parseIcs(
  source: string,
  rules: Array<{ type: AssignmentType; patterns: string[] }>,
): AssignmentFeed {
  if (
    !source.trimStart().startsWith("BEGIN:VCALENDAR") ||
    !source.trimEnd().endsWith("END:VCALENDAR")
  ) {
    throw new Error("Canvas feed is not a complete VCALENDAR document");
  }
  let parsed: unknown;
  try {
    parsed = ical.sync.parseICS(source);
  } catch {
    throw new Error("Canvas feed could not be parsed as RFC 5545 calendar data");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Canvas feed parser returned no calendar data");
  }

  // node-ical indexes VEVENTs by UID, so retain duplicate diagnostics before that index collapses them.
  const unfolded = source.replace(/\r?\n[ \t]/g, "");
  const sourceUids = [...unfolded.matchAll(/^UID(?:;[^:]*)?:(.+)\r?$/gim)].map((match) =>
    (match[1] ?? "").trim(),
  );
  const sourceUidCounts = new Map<string, number>();
  for (const uid of sourceUids) sourceUidCounts.set(uid, (sourceUidCounts.get(uid) ?? 0) + 1);
  const sourceEventCount = (source.match(/^BEGIN:VEVENT\r?$/gim) ?? []).length;

  const assignments = [];
  const skippedEvents: Array<{ reason: string; indicators: string[] }> = [];
  const seen = new Set<string>();
  const duplicateUids = [...sourceUidCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([uid]) => uid);
  let parsedEvents = 0;
  let malformedEvents = 0;

  for (const value of Object.values(parsed as Record<string, unknown>)) {
    const event = toEvent(value);
    if (!event) continue;
    parsedEvents += 1;
    const classification = classifyEvent(event);
    if (!classification.isAssignment) {
      skippedEvents.push({
        reason: "insufficient-assignment-evidence",
        indicators: classification.evidence,
      });
      continue;
    }
    try {
      const assignment = normalizeAssignment(event, classification, rules);
      if (seen.has(assignment.uid)) {
        if (!duplicateUids.includes(assignment.uid)) duplicateUids.push(assignment.uid);
        skippedEvents.push({ reason: "duplicate-source-uid", indicators: ["duplicate-uid"] });
        continue;
      }
      seen.add(assignment.uid);
      assignments.push(assignment);
    } catch {
      malformedEvents += 1;
      skippedEvents.push({
        reason: "malformed-assignment-event",
        indicators: classification.evidence,
      });
    }
  }

  const duplicateExtras = [...sourceUidCounts.values()].reduce(
    (total, count) => total + Math.max(0, count - 1),
    0,
  );
  malformedEvents += Math.max(0, sourceEventCount - parsedEvents - duplicateExtras);

  return {
    assignments,
    diagnostics: {
      totalEvents: sourceEventCount,
      assignmentsParsed: assignments.length,
      duplicateUids,
      malformedEvents,
      skippedEvents,
      complete: true,
    },
  };
}
