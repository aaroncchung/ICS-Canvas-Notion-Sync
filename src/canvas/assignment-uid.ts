/** Canvas calendar identity, including event-assignment-123 and assignment_123@canvas. */
export function canvasAssignmentIdFromUid(uid: string | undefined): string | undefined {
  return uid?.match(/(?:^|[-_:])assignment[-_:]?(\d+)(?:@|$|[-_:])/i)?.[1];
}

/** Canvas calendar event identity, such as event-calendar-event-123. */
export function canvasCalendarEventIdFromUid(uid: string | undefined): string | undefined {
  return uid?.match(/(?:^|[-_:])calendar[-_]event[-_:]?(\d+)(?:@|$|[-_:])/i)?.[1];
}
