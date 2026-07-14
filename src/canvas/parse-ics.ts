import ical from "node-ical";
import type { AssignmentFeed, FeedEventDiagnostic } from "../types.js";
import { classifyEvent } from "./classify-event.js";
import {
  normalizeAssignment,
  type AssignmentTypeMatcher,
  type RawCalendarEvent,
} from "./normalize-assignment.js";

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
  const description = asString(item.description);
  const url = asString(item.url);
  const location = asString(item.location);
  const status = asString(item.status);
  return {
    ...(uid ? { uid } : {}),
    ...(summary ? { summary } : {}),
    ...(start ? { start } : {}),
    ...(description ? { description } : {}),
    ...(url ? { url } : {}),
    ...(location ? { location } : {}),
    ...(status ? { status } : {}),
    ...(categories ? { categories } : {}),
    ...(dateOnly ? { datetype: "date" } : {}),
  };
}

export function parseIcs(
  source: string,
  assignmentTypeMatcher: AssignmentTypeMatcher,
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
  // node-ical indexes VEVENTs by UID, so retain source identity before that index collapses it.
  const rawEvents = source.split(/^BEGIN:VEVENT\r?$/gim).slice(1);
  const sourceUids = rawEvents
    .map((rawEvent) => {
      const eventBody = rawEvent.split(/^END:VEVENT\r?$/im)[0] ?? rawEvent;
      const unfolded = eventBody.replace(/\r?\n[ \t]/g, "");
      return unfolded.match(/^UID(?:;[^:]*)?:(.+)\r?$/im)?.[1]?.trim();
    })
    .filter((uid): uid is string => Boolean(uid));
  const sourceUidCounts = new Map<string, number>();
  for (const uid of sourceUids) sourceUidCounts.set(uid, (sourceUidCounts.get(uid) ?? 0) + 1);
  const sourceEventCount = rawEvents.length;

  const assignments: AssignmentFeed["assignments"] = [];
  const cancelledAssignments: AssignmentFeed["cancelledAssignments"] = [];
  const events: FeedEventDiagnostic[] = [];
  const quarantinedUids = new Set<string>();
  const handledUids = new Set<string>();
  const duplicateUids = new Set(
    [...sourceUidCounts.entries()].filter(([, count]) => count > 1).map(([uid]) => uid),
  );
  for (const uid of duplicateUids) {
    quarantinedUids.add(uid);
    events.push({
      kind: "duplicate",
      reason: "duplicate-source-uid",
      uid,
      indicators: ["duplicate-uid"],
    });
  }
  let parsedEvents = 0;

  for (const value of Object.values(parsed as Record<string, unknown>)) {
    const event = toEvent(value);
    if (!event) continue;
    parsedEvents += 1;
    if (event.uid) handledUids.add(event.uid);
    if (event.uid && duplicateUids.has(event.uid)) continue;

    const classification = classifyEvent(event);
    if (classification.kind === "ordinary") {
      events.push({
        kind: "ignored",
        reason: "ordinary-calendar-event",
        ...(event.uid ? { uid: event.uid } : {}),
        indicators: classification.evidence,
      });
      continue;
    }
    if (classification.kind === "suspicious") {
      if (event.uid) quarantinedUids.add(event.uid);
      events.push({
        kind: "suspicious",
        reason: "assignment-like-event",
        ...(event.uid ? { uid: event.uid } : {}),
        indicators: classification.evidence,
      });
      continue;
    }
    try {
      const assignment = normalizeAssignment(event, classification, assignmentTypeMatcher);
      if (event.status?.trim().toUpperCase() === "CANCELLED") {
        cancelledAssignments.push(assignment);
        quarantinedUids.add(assignment.uid);
        events.push({
          kind: "cancelled",
          reason: "cancelled-assignment",
          uid: assignment.uid,
          indicators: [...classification.evidence, "status-cancelled"],
        });
      } else {
        assignments.push(assignment);
      }
    } catch {
      if (event.uid) quarantinedUids.add(event.uid);
      events.push({
        kind: "malformed",
        reason: "malformed-assignment-event",
        ...(event.uid ? { uid: event.uid } : {}),
        indicators: classification.evidence,
      });
    }
  }

  const duplicateExtras = [...sourceUidCounts.values()].reduce(
    (total, count) => total + Math.max(0, count - 1),
    0,
  );
  const unparsedEvents = Math.max(0, sourceEventCount - parsedEvents - duplicateExtras);
  const unhandledUids = [...sourceUidCounts.keys()].filter(
    (uid) => !handledUids.has(uid) && !duplicateUids.has(uid),
  );
  for (let index = 0; index < unparsedEvents; index += 1) {
    const uid = unhandledUids[index];
    if (uid) quarantinedUids.add(uid);
    events.push({
      kind: "malformed",
      reason: "unparseable-event",
      ...(uid ? { uid } : {}),
      indicators: [],
    });
  }

  return {
    assignments,
    cancelledAssignments,
    diagnostics: {
      totalEvents: sourceEventCount,
      sourceUids: [...sourceUidCounts.keys()],
      normalizedAssignmentUids: [...assignments, ...cancelledAssignments].map(
        (assignment) => assignment.uid,
      ),
      quarantinedUids: [...quarantinedUids],
      events,
      complete: true,
    },
  };
}
