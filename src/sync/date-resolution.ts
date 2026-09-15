import { calendarDate, DATE_ONLY } from "../calendar-date.ts";

/** The zone-local calendar date of a timestamp; an unparseable value keeps its leading date, if any. */
export function timestampCalendarDate(value: string, timeZone: string): string | undefined {
  const milliseconds = Date.parse(value);
  if (!Number.isNaN(milliseconds)) return calendarDate(milliseconds, timeZone);
  return /^\d{4}-\d{2}-\d{2}/.exec(value)?.[0];
}

export function datesEqual(
  left: string | undefined,
  right: string | undefined,
  timeZone: string,
): boolean {
  if (!left || !right) return left === right;
  const leftDateOnly = DATE_ONLY.test(left);
  const rightDateOnly = DATE_ONLY.test(right);
  if (leftDateOnly && rightDateOnly) return left === right;
  if (leftDateOnly !== rightDateOnly) {
    const dateOnly = leftDateOnly ? left : right;
    const timestamp = leftDateOnly ? right : left;
    return dateOnly === timestampCalendarDate(timestamp, timeZone);
  }
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (Number.isNaN(leftMs) || Number.isNaN(rightMs)) return left === right;
  return leftMs === rightMs;
}

export interface DateResolution {
  canvasDueDate?: string;
  effectiveDueDate?: string;
  overrideDueDate?: string;
  overrideChanged: boolean;
}

export function resolveDates(
  current: { canvasDueDate?: string; effectiveDueDate?: string; overrideDueDate?: string },
  incomingCanvasDueDate: string | undefined,
  timeZone: string,
): DateResolution {
  let override = current.overrideDueDate;
  const previousExpected = current.overrideDueDate ?? current.canvasDueDate;

  if (!previousExpected && current.effectiveDueDate) {
    override = current.effectiveDueDate;
  } else if (
    current.effectiveDueDate &&
    current.canvasDueDate &&
    datesEqual(current.effectiveDueDate, current.canvasDueDate, timeZone)
  ) {
    override = undefined;
  } else if (
    current.effectiveDueDate &&
    previousExpected &&
    !datesEqual(current.effectiveDueDate, previousExpected, timeZone)
  ) {
    override = current.effectiveDueDate;
  }

  const result: DateResolution = {
    overrideChanged: !datesEqual(override, current.overrideDueDate, timeZone),
  };
  if (incomingCanvasDueDate) result.canvasDueDate = incomingCanvasDueDate;
  if (override) result.overrideDueDate = override;
  const effective = override ?? incomingCanvasDueDate;
  if (effective) result.effectiveDueDate = effective;
  return result;
}
