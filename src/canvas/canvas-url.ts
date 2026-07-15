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

export function verifiedCanvasOrigin(value: string, courseId: string): string | undefined {
  const url = httpUrl(value);
  if (!url) return;
  const route = url.pathname.match(CANVAS_COURSE_PATH);
  if (route?.[1] !== courseId) return;
  return url.origin;
}
