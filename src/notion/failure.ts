const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 529]);
/** The server rejected the request under load and asked for a later retry (rate_limited, service_overload). */
const THROTTLE_STATUSES = new Set([429, 529]);
const AMBIGUOUS_RESPONSE_STATUSES = new Set([500, 502, 503, 504]);
const TRANSPORT_CODES = new Set([
  "ABORT_ERR",
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ERR_STREAM_PREMATURE_CLOSE",
  "ETIMEDOUT",
  "notionhq_client_request_timeout",
  "UND_ERR_ABORTED",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_RES_CONTENT_LENGTH_MISMATCH",
  "UND_ERR_SOCKET",
]);

export class AmbiguousNotionWriteError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AmbiguousNotionWriteError";
  }
}

export type NotionFailureClassification =
  | {
      kind: "definite-response";
      status: number;
      retryable: boolean;
      throttled: boolean;
      ambiguousWrite: boolean;
    }
  | {
      kind: "transport";
      retryableRead: true;
      ambiguousWrite: true;
      code?: string;
    }
  | {
      kind: "definite-client-error";
      retryable: false;
      ambiguousWrite: false;
    }
  | {
      kind: "ambiguous-write";
      retryable: false;
      ambiguousWrite: true;
    };

/** Reads a property from an untrusted thrown value; a throwing getter reads as undefined. */
export function property(value: unknown, name: string): unknown {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return;
  try {
    return (value as Record<string, unknown>)[name];
  } catch {
    return;
  }
}

function boundedErrorChain(error: unknown): unknown[] {
  const pending = [error];
  const values: unknown[] = [];
  const seen = new Set<unknown>();
  while (pending.length && values.length < 12) {
    const value = pending.shift();
    if (value === undefined || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
    if (values.length >= 4) continue;
    const cause = property(value, "cause");
    if (cause !== undefined) pending.push(cause);
    const errors = property(value, "errors");
    if (Array.isArray(errors)) pending.push(...(errors as unknown[]).slice(0, 3));
  }
  return values;
}

function responseStatus(value: unknown): number | undefined {
  const candidate = property(value, "status") ?? property(value, "statusCode");
  return typeof candidate === "number" &&
    Number.isInteger(candidate) &&
    candidate >= 100 &&
    candidate <= 599
    ? candidate
    : undefined;
}

function transportCode(value: unknown): string | undefined {
  const code = property(value, "code");
  return typeof code === "string" && TRANSPORT_CODES.has(code) ? code : undefined;
}

function isTransportSignal(value: unknown): boolean {
  if (transportCode(value)) return true;
  const name = property(value, "name");
  if (name === "AbortError") return true;
  const message = property(value, "message");
  return (
    (name === "TypeError" && ["fetch failed", "terminated"].includes(String(message))) ||
    (name === "FetchError" &&
      ["aborted", "request-timeout", "system"].includes(String(property(value, "type"))))
  );
}

export function classifyNotionFailure(error: unknown): NotionFailureClassification {
  if (error instanceof AmbiguousNotionWriteError) {
    return { kind: "ambiguous-write", retryable: false, ambiguousWrite: true };
  }
  const chain = boundedErrorChain(error);
  for (const value of chain) {
    const status = responseStatus(value);
    if (status !== undefined) {
      return {
        kind: "definite-response",
        status,
        retryable: RETRYABLE_STATUSES.has(status),
        throttled: THROTTLE_STATUSES.has(status),
        ambiguousWrite: AMBIGUOUS_RESPONSE_STATUSES.has(status),
      };
    }
  }
  for (const value of chain) {
    if (!isTransportSignal(value)) continue;
    const code = transportCode(value);
    return {
      kind: "transport",
      retryableRead: true,
      ambiguousWrite: true,
      ...(code ? { code } : {}),
    };
  }
  return { kind: "definite-client-error", retryable: false, ambiguousWrite: false };
}

function headerValue(headers: unknown, name: string): string | undefined {
  const get = property(headers, "get");
  if (typeof get === "function") {
    try {
      const value: unknown = get.call(headers, name);
      return typeof value === "string" ? value : undefined;
    } catch {
      return;
    }
  }
  if (!headers || typeof headers !== "object") return;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== name) continue;
    const value = property(headers, key);
    if (typeof value === "string") return value;
    if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  }
  return;
}

/** The delay a response's Retry-After header asks for, as delta-seconds or an HTTP date. */
export function retryAfterMs(error: unknown, now: number): number | undefined {
  const response = boundedErrorChain(error).find((value) => responseStatus(value) !== undefined);
  const header = headerValue(property(response, "headers"), "retry-after")?.trim();
  if (!header) return;
  if (/^\d+$/.test(header)) return Number(header) * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
