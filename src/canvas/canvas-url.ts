const CANVAS_ASSIGNMENT_PATH = /^\/courses\/(\d+)\/assignments\/(\d+)(?:\/.*)?$/i;
const CANVAS_COURSE_PATH = /^\/courses\/(\d+)(?:\/.*)?$/i;

export interface CanvasAssignmentUrlIdentity {
  url: string;
  normalizedUrl: string;
  courseId: string;
  assignmentId: string;
}

export function cleanUrlCandidate(value: string): string {
  return value
    .trim()
    .replace(/&amp;/gi, "&")
    .replace(/[),.;!?]+$/, "");
}

function httpUrl(value: string): URL | undefined {
  try {
    const url = new URL(cleanUrlCandidate(value));
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    return url;
  } catch {
    return;
  }
}

export function canvasAssignmentUrlIdentity(
  value: string,
): CanvasAssignmentUrlIdentity | undefined {
  const url = httpUrl(value);
  if (!url) return;
  const route = url.pathname.match(CANVAS_ASSIGNMENT_PATH);
  if (!route?.[1] || !route[2]) return;
  const normalized = new URL(url);
  normalized.search = "";
  normalized.hash = "";
  normalized.pathname = normalized.pathname.replace(/\/+$/, "");
  return {
    url: url.toString(),
    normalizedUrl: normalized.toString(),
    courseId: route[1],
    assignmentId: route[2],
  };
}

export interface CanvasCalendarLinkIdentity {
  kind: "assignment" | "calendar-event";
  id: string;
  origin: string;
  courseId?: string;
}

/**
 * Canvas writes each feed event's URL as a calendar view link:
 * `/calendar?include_contexts=course_N&month=M&year=Y#assignment_N` or `#calendar_event_N`.
 * The fragment names the item, and a single course context names its course.
 */
export function canvasCalendarLinkIdentity(value: string): CanvasCalendarLinkIdentity | undefined {
  const url = httpUrl(value);
  if (!url || !/^\/calendar2?\/?$/i.test(url.pathname)) return;
  const fragment = url.hash.match(/^#(assignment|calendar_event)_(\d+)$/i);
  if (!fragment?.[1] || !fragment[2]) return;
  const courseIds = url.searchParams
    .getAll("include_contexts")
    .flatMap((contexts) => contexts.split(","))
    .flatMap((context) => context.trim().match(/^course_(\d+)$/i)?.[1] ?? []);
  const courseId = courseIds.length === 1 ? courseIds[0] : undefined;
  return {
    kind: fragment[1].toLowerCase() === "assignment" ? "assignment" : "calendar-event",
    id: fragment[2],
    origin: url.origin,
    ...(courseId ? { courseId } : {}),
  };
}

export function verifiedCanvasOrigin(value: string, courseId: string): string | undefined {
  const url = httpUrl(value);
  if (!url) return;
  const route = url.pathname.match(CANVAS_COURSE_PATH);
  if (route?.[1] !== courseId) return;
  return url.origin;
}
