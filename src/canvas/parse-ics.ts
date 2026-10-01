import ical from "node-ical";
import type { AssignmentFeed, FeedEventDiagnostic } from "../types.ts";
import { classifyEvent } from "./classify-event.ts";
import {
  normalizeAssignment,
  type AssignmentTypeMatcher,
  type RawCalendarEvent,
} from "./normalize-assignment.ts";

const VEVENT_START = /^BEGIN:VEVENT\r?$/gim;
const VEVENT_BLOCK = /^BEGIN:VEVENT\r?$[\s\S]*?^END:VEVENT\r?$/gim;
/** A UID line, unfolded, whose parameters may quote a colon. */
const UID_LINE = /^UID(?:;(?:[^":\r\n]|"[^"\r\n]*")*)?:(.*?)\r?$/gim;
const NESTED_COMPONENT = /^BEGIN:(?!VEVENT\r?$)([A-Z0-9-]+)\r?$[\s\S]*?^END:\1\r?$/gim;
const CALENDAR_END = "END:VCALENDAR";

/**
 * node-ical returns a property that carries parameters, such as `URL;VALUE=URI:`, as
 * `{ params, val }`, so the value is unwrapped here.
 */
function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "val" in value) {
    return typeof value.val === "string" ? value.val : undefined;
  }
  return;
}

/** A parameter's value, matching its name case-insensitively as RFC 5545 requires. */
function parameter(value: object, name: string): string | undefined {
  if (!("params" in value) || !value.params || typeof value.params !== "object") return;
  const entry = Object.entries(value.params).find(([key]) => key.toUpperCase() === name);
  return typeof entry?.[1] === "string" ? entry[1] : undefined;
}

/**
 * Canvas writes plain text, converted from the assignment's HTML, to DESCRIPTION and the HTML
 * itself to `X-ALT-DESC;FMTTYPE=text/html`, which node-ical exposes as `ALT-DESC`. The HTML is
 * used only when exactly one such value is marked as HTML; anything else falls back to the plain
 * text, so an unusual ALT-DESC can never quarantine an event.
 */
function htmlAltDescription(value: unknown): string | undefined {
  const candidates = (Array.isArray(value) ? value : [value]).filter(
    (item): item is { val: string } =>
      Boolean(item) &&
      typeof item === "object" &&
      typeof (item as { val?: unknown }).val === "string" &&
      parameter(item as object, "FMTTYPE")
        ?.trim()
        .toLowerCase() === "text/html",
  );
  return candidates.length === 1 ? candidates[0]?.val : undefined;
}

function asDate(value: unknown): Date | undefined {
  return value instanceof Date ? value : undefined;
}

/** Properties RFC 5545 allows once per event; node-ical returns a repeated one as an array. */
const SINGLE_TEXT_PROPERTIES = ["summary", "description", "url", "location", "status"] as const;

function toEvent(value: unknown, uid: string | undefined): RawCalendarEvent | "repeated-property" {
  const item = value as Record<string, unknown>;
  if (SINGLE_TEXT_PROPERTIES.some((name) => Array.isArray(item[name]))) return "repeated-property";
  const categories =
    item.categories === undefined
      ? undefined
      : (Array.isArray(item.categories) ? item.categories : [item.categories])
          .map(asString)
          .filter((category): category is string => category !== undefined);
  const start = asDate(item.start);
  const dateOnly =
    item.datetype === "date" ||
    (start && "dateOnly" in start && (start as Date & { dateOnly?: boolean }).dateOnly);
  const summary = asString(item.summary);
  const description = asString(item.description);
  const htmlDescription = htmlAltDescription(item["ALT-DESC"]);
  const url = asString(item.url);
  const location = asString(item.location);
  const status = asString(item.status);
  return {
    ...(uid ? { uid } : {}),
    ...(summary ? { summary } : {}),
    ...(start ? { start } : {}),
    ...(description ? { description } : {}),
    ...(htmlDescription ? { htmlDescription } : {}),
    ...(url ? { url } : {}),
    ...(location ? { location } : {}),
    ...(status ? { status } : {}),
    ...(categories ? { categories } : {}),
    ...(dateOnly ? { datetype: "date" } : {}),
  };
}

/**
 * Runs node-ical's synchronous parser with `console.warn` captured. node-ical warns with raw UIDs
 * and feed values (for example when it drops an older SEQUENCE of a duplicate UID), and those
 * would reach the Actions log unredacted. Only the number of warnings is kept.
 */
function parseQuietly(source: string): { parsed: unknown; parserWarnings: number } {
  const warn = console.warn;
  let parserWarnings = 0;
  console.warn = () => {
    parserWarnings += 1;
  };
  try {
    return { parsed: ical.sync.parseICS(source), parserWarnings };
  } finally {
    console.warn = warn;
  }
}

function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, character: string) =>
    character === "n" || character === "N" ? "\n" : character,
  );
}

/**
 * The UID as written in the unfolded source event, unescaped and trimmed. Every comparison of UIDs
 * uses this one form, so copies that differ only by whitespace or escaping are duplicates.
 */
function sourceUid(block: string): { uid?: string; repeated: boolean } {
  // A nested component such as VALARM may carry a UID of its own (RFC 9074).
  const values = [...block.replace(NESTED_COMPONENT, "").matchAll(UID_LINE)].map((match) =>
    unescapeText(match[1] ?? "").trim(),
  );
  const uid = values[0];
  return { ...(uid ? { uid } : {}), repeated: values.length > 1 };
}

interface SourceEvent {
  uid?: string;
  /** The parsed event, or why it could not be read. */
  event: RawCalendarEvent | "unparseable" | "repeated-property";
}

/**
 * Parses each VEVENT on its own, inside the calendar's other components (such as VTIMEZONE), so
 * that one malformed event is quarantined instead of failing the whole feed. Parsing per event
 * also keeps events that node-ical would otherwise index together by UID.
 */
function parseEvents(folded: string): { events: SourceEvent[]; parserWarnings: number } {
  // Component boundaries are content lines too, so they can be folded like any other.
  const source = folded.replace(/\r?\n[ \t]/g, "");
  const blocks = source.match(VEVENT_BLOCK) ?? [];
  const head = source.replace(VEVENT_BLOCK, "").trimEnd().slice(0, -CALENDAR_END.length);
  if ((source.match(VEVENT_START) ?? []).length !== blocks.length) {
    throw new Error("Canvas feed has an unterminated VEVENT");
  }
  // Calendar-level content is shared by every event, so its failure still fails the feed.
  const skeleton = parseQuietly(`${head}${CALENDAR_END}`);
  if (!skeleton.parsed || typeof skeleton.parsed !== "object") {
    throw new Error("Canvas feed parser returned no calendar data");
  }
  let parserWarnings = skeleton.parserWarnings;
  const events = blocks.map((block): SourceEvent => {
    const { uid, repeated } = sourceUid(block);
    const identity = uid ? { uid } : {};
    if (repeated) return { ...identity, event: "repeated-property" };
    let parsed: unknown;
    try {
      const result = parseQuietly(`${head}${block}\n${CALENDAR_END}`);
      parsed = result.parsed;
      parserWarnings += Math.max(0, result.parserWarnings - skeleton.parserWarnings);
    } catch {
      return { ...identity, event: "unparseable" };
    }
    const vevents = Object.values((parsed ?? {}) as Record<string, unknown>).filter(
      (value) =>
        value && typeof value === "object" && (value as { type?: unknown }).type === "VEVENT",
    );
    if (vevents.length !== 1) return { ...identity, event: "unparseable" };
    return { ...identity, event: toEvent(vevents[0], uid) };
  });
  return { events, parserWarnings };
}

export function parseIcs(
  source: string,
  assignmentTypeMatcher: AssignmentTypeMatcher,
): AssignmentFeed {
  if (
    !source.trimStart().startsWith("BEGIN:VCALENDAR") ||
    !source.trimEnd().endsWith(CALENDAR_END)
  ) {
    throw new Error("Canvas feed is not a complete VCALENDAR document");
  }
  let sourceEvents: SourceEvent[];
  let parserWarnings: number;
  try {
    ({ events: sourceEvents, parserWarnings } = parseEvents(source));
  } catch {
    throw new Error("Canvas feed could not be parsed as RFC 5545 calendar data");
  }
  const sourceUidCounts = new Map<string, number>();
  for (const { uid } of sourceEvents) {
    if (uid) sourceUidCounts.set(uid, (sourceUidCounts.get(uid) ?? 0) + 1);
  }

  const assignments: AssignmentFeed["assignments"] = [];
  const cancelledAssignments: AssignmentFeed["cancelledAssignments"] = [];
  const events: FeedEventDiagnostic[] = [];
  const quarantinedUids = new Set<string>();
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

  for (const { uid, event } of sourceEvents) {
    if (uid && duplicateUids.has(uid)) continue;
    if (typeof event === "string") {
      if (uid) quarantinedUids.add(uid);
      events.push({
        kind: "malformed",
        reason: "unparseable-event",
        ...(uid ? { uid } : {}),
        indicators: event === "repeated-property" ? [event] : [],
      });
      continue;
    }

    const classification = classifyEvent(event);
    if (classification.kind === "ordinary") {
      events.push({
        kind: "ignored",
        reason: "ordinary-calendar-event",
        ...(uid ? { uid } : {}),
        indicators: classification.evidence,
      });
      continue;
    }
    if (classification.kind === "suspicious" || classification.kind === "mismatch") {
      if (uid) quarantinedUids.add(uid);
      events.push({
        kind: "suspicious",
        reason:
          classification.kind === "mismatch" ? "canvas-identity-mismatch" : "assignment-like-event",
        ...(uid ? { uid } : {}),
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
      if (uid) quarantinedUids.add(uid);
      events.push({
        kind: "malformed",
        reason: "malformed-assignment-event",
        ...(uid ? { uid } : {}),
        indicators: classification.evidence,
      });
    }
  }

  return {
    assignments,
    cancelledAssignments,
    diagnostics: {
      totalEvents: sourceEvents.length,
      sourceUids: [...sourceUidCounts.keys()],
      normalizedAssignmentUids: [...assignments, ...cancelledAssignments].map(
        (assignment) => assignment.uid,
      ),
      quarantinedUids: [...quarantinedUids],
      events,
      parserWarnings,
    },
  };
}
