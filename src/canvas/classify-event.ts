import {
  canvasAssignmentUrlIdentity,
  cleanUrlCandidate,
  verifiedCanvasOrigin,
} from "./canvas-url.ts";

export interface ClassificationInput {
  uid?: string;
  url?: string;
  description?: string;
  location?: string;
  categories?: string[];
}

export interface ClassificationResult {
  kind: "assignment" | "suspicious" | "ordinary";
  evidence: string[];
  canvasUrl?: string;
  canvasCourseId?: string;
  canvasAssignmentId?: string;
}

const ABSOLUTE_URL = /https?:\/\/[^\s<>"']+/gi;
const PATH_ROUTE = /\/courses\/(\d+)\/assignments\/(\d+)(?=\/|[?#\s<>"')\],.;!?]|$)/gi;
const UID_ASSIGNMENT = /(?:^|[-_:])assignment[-_:]?(\d+)(?:@|$|[-_:])/i;

type EventField = "url" | "location" | "description";

interface FieldValue {
  name: EventField;
  value: string;
}

interface RouteMatch {
  field: EventField;
  courseId: string;
  assignmentId: string;
  canvasUrl?: string;
}

function absoluteUrls(value: string): string[] {
  return [...value.matchAll(ABSOLUTE_URL)].map((match) => cleanUrlCandidate(match[0]));
}

function relativeRoute(field: FieldValue): RouteMatch | undefined {
  for (const match of field.value.matchAll(PATH_ROUTE)) {
    if (!match[1] || !match[2]) continue;
    const tokenPrefix = field.value.slice(0, match.index).split(/\s/).at(-1) ?? "";
    if (tokenPrefix.includes("://")) continue;
    return { field: field.name, courseId: match[1], assignmentId: match[2] };
  }
  return;
}

export function classifyEvent(input: ClassificationInput): ClassificationResult {
  const evidence: string[] = [];
  const fields = (
    [
      ["url", input.url],
      ["location", input.location],
      ["description", input.description],
    ] as const
  ).flatMap(([name, value]): FieldValue[] => (value ? [{ name, value }] : []));
  let routeMatch: RouteMatch | undefined;
  for (const field of fields) {
    for (const candidate of absoluteUrls(field.value)) {
      const identity = canvasAssignmentUrlIdentity(candidate);
      if (!identity) continue;
      routeMatch = {
        field: field.name,
        courseId: identity.courseId,
        assignmentId: identity.assignmentId,
        canvasUrl: identity.url,
      };
      break;
    }
    if (routeMatch) break;
  }
  routeMatch ??= fields.map(relativeRoute).find((match) => match !== undefined);
  if (routeMatch) {
    evidence.push("canvas-assignment-route");
    if (!routeMatch.canvasUrl) {
      const origin = fields
        .flatMap((field) => absoluteUrls(field.value))
        .map((candidate) => verifiedCanvasOrigin(candidate, routeMatch.courseId))
        .find((value) => value !== undefined);
      if (origin) {
        routeMatch.canvasUrl = new URL(
          `/courses/${routeMatch.courseId}/assignments/${routeMatch.assignmentId}`,
          origin,
        ).toString();
      }
    }
  }
  const uidMatch = input.uid?.match(UID_ASSIGNMENT);
  if (uidMatch) evidence.push("canvas-assignment-uid");
  if (input.categories?.some((category) => /assignment/i.test(category))) {
    evidence.push("assignment-category");
  }

  if (!routeMatch && fields.some((field) => /\/assignments(?:\/|\?|$)/i.test(field.value))) {
    evidence.push("assignment-like-route");
  }
  if (!uidMatch && input.uid && /assignment/i.test(input.uid)) {
    evidence.push("assignment-like-uid");
  }

  const kind = routeMatch || uidMatch ? "assignment" : evidence.length ? "suspicious" : "ordinary";
  const result: ClassificationResult = { kind, evidence };
  if (routeMatch?.canvasUrl) result.canvasUrl = routeMatch.canvasUrl;
  if (routeMatch?.courseId) result.canvasCourseId = routeMatch.courseId;
  if (routeMatch?.assignmentId) result.canvasAssignmentId = routeMatch.assignmentId;
  if (!result.canvasAssignmentId && uidMatch?.[1]) result.canvasAssignmentId = uidMatch[1];
  return result;
}
