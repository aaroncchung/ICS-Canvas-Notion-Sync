import { AmbiguousNotionWriteError } from "./client.ts";
import { setTimeout as sleep } from "node:timers/promises";

export interface VisibilityPollingOptions {
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export async function pollForUniquePage(
  query: () => Promise<Array<Record<string, unknown>>>,
  multipleMessage: (count: number) => string,
  options: VisibilityPollingOptions = {},
): Promise<Record<string, unknown> | undefined> {
  const attempts = options.attempts ?? 4;
  const delayMs = options.delayMs ?? 250;
  const pause = options.sleep ?? sleep;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const matches = await query();
    if (matches.length > 1) throw new AmbiguousNotionWriteError(multipleMessage(matches.length));
    if (matches[0]) return matches[0];
    if (attempt < attempts - 1) await pause(delayMs);
  }
}
