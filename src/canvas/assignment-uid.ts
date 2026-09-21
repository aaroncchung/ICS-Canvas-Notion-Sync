/** Canvas calendar identity, including event-assignment-123 and assignment_123@canvas. */
export function canvasAssignmentIdFromUid(uid: string | undefined): string | undefined {
  return uid?.match(/(?:^|[-_:])assignment[-_:]?(\d+)(?:@|$|[-_:])/i)?.[1];
}
