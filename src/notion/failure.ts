const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
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

function property(value: unknown, name: string): unknown {
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
