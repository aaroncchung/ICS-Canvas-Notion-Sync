import type { AssignmentRecord, ExternalAssignment } from "../types.js";
import { datesEqual } from "./date-resolution.js";

function normalizeTitle(value: string): string {
  return value
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function possibleDuplicate(
  source: ExternalAssignment,
  existing: AssignmentRecord[],
): AssignmentRecord[] {
  return existing.filter((candidate) => {
    if (candidate.uid === source.uid) return false;
    if (source.canvasUrl && candidate.canvasUrl === source.canvasUrl) return true;
    return (
      normalizeTitle(candidate.title) === normalizeTitle(source.title) &&
      datesEqual(candidate.canvasDueDate, source.dueAt)
    );
  });
}
