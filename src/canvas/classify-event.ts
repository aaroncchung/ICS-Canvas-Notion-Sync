export interface ClassificationInput {
  uid?: string;
  url?: string;
  description?: string;
  location?: string;
  categories?: string[];
}

export interface ClassificationResult {
  isAssignment: boolean;
  evidence: string[];
  canvasUrl?: string;
  canvasCourseId?: string;
  canvasAssignmentId?: string;
}

const ASSIGNMENT_ROUTE =
  /https?:\/\/[^\s<>"']+\/courses\/(\d+)\/assignments\/(\d+)(?:[^\s<>"']*)?/i;
const PATH_ROUTE = /\/courses\/(\d+)\/assignments\/(\d+)/i;
const UID_ASSIGNMENT = /(?:^|[-_:])assignment[-_:]?(\d+)(?:@|$|[-_:])/i;

function cleanUrl(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/[).,;]+$/, "");
}

export function classifyEvent(input: ClassificationInput): ClassificationResult {
  const evidence: string[] = [];
  const fields = [input.url, input.location, input.description].filter((value): value is string =>
    Boolean(value),
  );
  let routeMatch: RegExpMatchArray | undefined;
  let canvasUrl: string | undefined;
  for (const field of fields) {
    const full = field.match(ASSIGNMENT_ROUTE);
    const path = field.match(PATH_ROUTE);
    const match = full ?? path;
    if (match) {
      routeMatch = match;
      canvasUrl = full ? cleanUrl(full[0]) : input.url;
      evidence.push("canvas-assignment-route");
      break;
    }
  }
  const uidMatch = input.uid?.match(UID_ASSIGNMENT);
  if (uidMatch) evidence.push("canvas-assignment-uid");
  if (input.categories?.some((category) => /assignment/i.test(category))) {
    evidence.push("assignment-category");
  }

  const isAssignment = Boolean(routeMatch || uidMatch);
  const result: ClassificationResult = { isAssignment, evidence };
  if (canvasUrl) result.canvasUrl = canvasUrl;
  if (routeMatch?.[1]) result.canvasCourseId = routeMatch[1];
  if (routeMatch?.[2]) result.canvasAssignmentId = routeMatch[2];
  if (!result.canvasAssignmentId && uidMatch?.[1]) result.canvasAssignmentId = uidMatch[1];
  return result;
}
