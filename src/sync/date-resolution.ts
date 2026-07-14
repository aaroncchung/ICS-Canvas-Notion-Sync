export function datesEqual(left?: string, right?: string): boolean {
  if (!left || !right) return left === right;
  const leftDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(left);
  const rightDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(right);
  if (leftDateOnly || rightDateOnly) {
    const leftDay = leftDateOnly ? left : left.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
    const rightDay = rightDateOnly ? right : right.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
    return leftDay !== undefined && leftDay === rightDay;
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
  incomingCanvasDueDate?: string,
): DateResolution {
  let override = current.overrideDueDate;
  const previousExpected = current.overrideDueDate ?? current.canvasDueDate;

  if (!previousExpected && current.effectiveDueDate) {
    override = current.effectiveDueDate;
  } else if (
    current.effectiveDueDate &&
    current.canvasDueDate &&
    datesEqual(current.effectiveDueDate, current.canvasDueDate)
  ) {
    override = undefined;
  } else if (
    current.effectiveDueDate &&
    previousExpected &&
    !datesEqual(current.effectiveDueDate, previousExpected)
  ) {
    override = current.effectiveDueDate;
  }

  const result: DateResolution = {
    overrideChanged: !datesEqual(override, current.overrideDueDate),
  };
  if (incomingCanvasDueDate) result.canvasDueDate = incomingCanvasDueDate;
  if (override) result.overrideDueDate = override;
  const effective = override ?? incomingCanvasDueDate;
  if (effective) result.effectiveDueDate = effective;
  return result;
}
