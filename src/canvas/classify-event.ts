import {
  canvasAssignmentUrlIdentity,
  canvasCalendarLinkIdentity,
  cleanUrlCandidate,
  verifiedCanvasOrigin,
} from "./canvas-url.ts";
import { canvasAssignmentIdFromUid, canvasCalendarEventIdFromUid } from "./assignment-uid.ts";

export interface ClassificationInput {
  uid?: string;
  url?: string;
  description?: string;
  location?: string;
  categories?: string[];
}

export interface ClassificationResult {
  /** `mismatch` means the UID and a link name different Canvas items, so neither can be trusted. */
  kind: "assignment" | "suspicious" | "mismatch" | "ordinary";
  evidence: string[];
  canvasUrl?: string;
  canvasCourseId?: string;
  canvasAssignmentId?: string;
}

const ABSOLUTE_URL = /https?:\/\/[^\s<>"']+/gi;
const PATH_ROUTE = /\/courses\/(\d+)\/assignments\/(\d+)(?=\/|[?#\s<>"')\],.;!?]|$)/gi;
const ASSIGNMENT_LIKE_ROUTE = /\/assignments(?:\/|\?|$)/i;
const FRAGMENT_ITEM = /#(assignment|calendar_event)_(\d+)(?!\d)/gi;
const COURSE_MENTION = /\bcourse_(\d+)(?!\d)|\/courses\/(\d+)(?!\d)/gi;

type CanvasItemKind = "assignment" | "calendar-event";

/** A Canvas item named by the URL or LOCATION field. */
interface LinkIdentity {
  kind: CanvasItemKind;
  id: string;
  evidence: "canvas-assignment-route" | "canvas-calendar-link";
  courseId?: string;
  canvasUrl?: string;
}

function absoluteUrls(value: string): string[] {
  return [...value.matchAll(ABSOLUTE_URL)].map((match) => cleanUrlCandidate(match[0]));
}

function absoluteLink(candidate: string): LinkIdentity | undefined {
  const route = canvasAssignmentUrlIdentity(candidate);
  if (route) {
    return {
      kind: "assignment",
      id: route.assignmentId,
      evidence: "canvas-assignment-route",
      courseId: route.courseId,
      canvasUrl: route.url,
    };
  }
  const link = canvasCalendarLinkIdentity(candidate);
  if (!link) return;
  const identity: LinkIdentity = { kind: link.kind, id: link.id, evidence: "canvas-calendar-link" };
  if (link.courseId) {
    identity.courseId = link.courseId;
    // The calendar view is not a page for the item, so link the assignment's own page instead.
    if (link.kind === "assignment") {
      identity.canvasUrl = new URL(
        `/courses/${link.courseId}/assignments/${link.id}`,
        link.origin,
      ).toString();
    }
  }
  return identity;
}

function relativeRoutes(value: string): LinkIdentity[] {
  return [...value.matchAll(PATH_ROUTE)].flatMap((match): LinkIdentity[] => {
    if (!match[1] || !match[2]) return [];
    const tokenPrefix = value.slice(0, match.index).split(/\s/).at(-1) ?? "";
    if (tokenPrefix.includes("://")) return [];
    return [
      { kind: "assignment", id: match[2], evidence: "canvas-assignment-route", courseId: match[1] },
    ];
  });
}

/**
 * Every item fragment, in whatever shape of link it appears, such as a relative
 * `/calendar?include_contexts=course_1#assignment_2` wrapped in brackets or quotes.
 */
function fragmentItems(value: string): LinkIdentity[] {
  return [...value.matchAll(FRAGMENT_ITEM)].flatMap((match): LinkIdentity[] =>
    match[1] && match[2]
      ? [
          {
            kind: match[1].toLowerCase() === "assignment" ? "assignment" : "calendar-event",
            id: match[2],
            evidence: "canvas-calendar-link",
          },
        ]
      : [],
  );
}

/** Every course named in any shape: `course_N` contexts and `/courses/N` paths. */
function courseMentions(value: string): string[] {
  return [...value.matchAll(COURSE_MENTION)].flatMap((match) => match[1] ?? match[2] ?? []);
}

/**
 * Only URL and LOCATION can name the event's own Canvas item. A description is prose that may link
 * any number of other assignments, so it never decides identity (#47). Every item and course those
 * fields mention is compared, whatever the shape of its link, because any second item or course
 * makes the event's identity unknowable.
 */
function linkIdentity(values: string[]): LinkIdentity | "conflict" | undefined {
  const links = [
    ...values.flatMap(absoluteUrls).flatMap((candidate) => absoluteLink(candidate) ?? []),
    ...values.flatMap(relativeRoutes),
    ...values.flatMap(fragmentItems),
  ];
  const [first] = links;
  if (!first) return;
  const courseIds = new Set([
    ...links.flatMap((link) => link.courseId ?? []),
    ...values.flatMap(courseMentions),
  ]);
  if (
    links.some((link) => link.kind !== first.kind || link.id !== first.id) ||
    courseIds.size > 1
  ) {
    return "conflict";
  }
  const identity: LinkIdentity = { ...first };
  // An assignment page route is the stronger evidence when it agrees with a calendar link.
  if (links.some((link) => link.evidence === "canvas-assignment-route")) {
    identity.evidence = "canvas-assignment-route";
  }
  const [courseId] = courseIds;
  if (courseId) identity.courseId = courseId;
  const canvasUrl = links.find((link) => link.canvasUrl)?.canvasUrl;
  if (canvasUrl) identity.canvasUrl = canvasUrl;
  else if (courseId && identity.kind === "assignment") {
    const origin = values
      .flatMap(absoluteUrls)
      .map((candidate) => verifiedCanvasOrigin(candidate, courseId))
      .find((value) => value !== undefined);
    if (origin) {
      identity.canvasUrl = new URL(
        `/courses/${courseId}/assignments/${identity.id}`,
        origin,
      ).toString();
    }
  }
  return identity;
}

function uidIdentity(uid: string | undefined): { kind: CanvasItemKind; id: string } | undefined {
  const assignmentId = canvasAssignmentIdFromUid(uid);
  if (assignmentId) return { kind: "assignment", id: assignmentId };
  const calendarEventId = canvasCalendarEventIdFromUid(uid);
  if (calendarEventId) return { kind: "calendar-event", id: calendarEventId };
  return;
}

export function classifyEvent(input: ClassificationInput): ClassificationResult {
  const evidence: string[] = [];
  const identityValues = [input.url, input.location].filter((value): value is string =>
    Boolean(value),
  );
  const found = linkIdentity(identityValues);
  const link = found === "conflict" ? undefined : found;
  if (link) evidence.push(link.evidence);
  const fromUid = uidIdentity(input.uid);
  if (fromUid?.kind === "assignment") evidence.push("canvas-assignment-uid");
  if (fromUid?.kind === "calendar-event") evidence.push("canvas-calendar-event-uid");

  if (
    found === "conflict" ||
    (fromUid && link && (link.kind !== fromUid.kind || link.id !== fromUid.id))
  ) {
    return { kind: "mismatch", evidence: [...evidence, "canvas-identity-mismatch"] };
  }

  // A calendar fragment alone is only trusted once the UID confirms it, so a UID without a Canvas
  // identity leaves such a link as evidence for quarantine rather than for import.
  const assignmentId =
    fromUid?.kind === "assignment"
      ? fromUid.id
      : link?.kind === "assignment" && link.evidence === "canvas-assignment-route"
        ? link.id
        : undefined;
  if (assignmentId) {
    const result: ClassificationResult = {
      kind: "assignment",
      evidence,
      canvasAssignmentId: assignmentId,
    };
    if (link?.canvasUrl) result.canvasUrl = link.canvasUrl;
    if (link?.courseId) result.canvasCourseId = link.courseId;
    return result;
  }

  if (input.categories?.some((category) => /assignment/i.test(category))) {
    evidence.push("assignment-category");
  }
  const hintValues = [
    ...(link ? [] : identityValues),
    // A known calendar event may link assignments in its description without being one.
    ...(fromUid?.kind === "calendar-event" || !input.description ? [] : [input.description]),
  ];
  if (hintValues.some((value) => ASSIGNMENT_LIKE_ROUTE.test(value))) {
    evidence.push("assignment-like-route");
  }
  if (!fromUid && input.uid && /assignment/i.test(input.uid)) {
    evidence.push("assignment-like-uid");
  }
  const assignmentHint =
    link?.kind === "assignment" ||
    evidence.some((item) =>
      ["assignment-category", "assignment-like-route", "assignment-like-uid"].includes(item),
    );
  return { kind: assignmentHint ? "suspicious" : "ordinary", evidence };
}
