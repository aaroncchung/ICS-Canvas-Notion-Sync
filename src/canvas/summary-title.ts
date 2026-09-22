/** A feed SUMMARY without the trailing " [Course]" label Canvas appends to an assignment's name. */
export function titleWithoutCourseLabel(summary: string): string {
  return summary.replace(/\s+\[[^\]]+]\s*$/, "").trim() || summary;
}
