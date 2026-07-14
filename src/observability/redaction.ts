const TOKEN_PATTERN = /\b(?:secret|ntn|oauth|sk)[_-][A-Za-z0-9_-]{8,}\b/gi;
const AUTH_PATTERN = /(?:authorization\s*[:=]\s*|bearer\s+)[^\s,}\]]+/gi;
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;
const FEED_CONTENT_PATTERN = /BEGIN:(?:VCALENDAR|VEVENT)[\s\S]*/gi;
const DESCRIPTION_PATTERN = /\b(?:raw\s+)?description\s*[:=]\s*[^\r\n]*/gi;

export interface SanitizedDiagnostic {
  name: string;
  message: string;
  stack?: string;
  status?: number;
  code?: string;
  operation?: string;
  cause?: SanitizedDiagnostic;
  errors?: SanitizedDiagnostic[];
}

export function redactText(input: string, secrets: string[] = []): string {
  let output = input;
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    output = output.split(secret).join("[REDACTED]");
  }
  return output
    .replace(FEED_CONTENT_PATTERN, "[REDACTED_FEED_CONTENT]")
    .replace(DESCRIPTION_PATTERN, "Description: [REDACTED]")
    .replace(TOKEN_PATTERN, "[REDACTED_TOKEN]")
    .replace(AUTH_PATTERN, "Authorization: [REDACTED]")
    .replace(URL_PATTERN, "[REDACTED_URL]");
}

function property(value: unknown, name: string): unknown {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return;
  try {
    return (value as Record<string, unknown>)[name];
  } catch {
    return;
  }
}

function stringProperty(value: unknown, name: string): string | undefined {
  const candidate = property(value, name);
  return typeof candidate === "string" ? candidate : undefined;
}

function extract(
  error: unknown,
  secrets: string[],
  depth: number,
  seen: Set<unknown>,
): SanitizedDiagnostic {
  if (depth > 3 || seen.has(error)) return { name: "Error", message: "[cause omitted]" };
  if (error && (typeof error === "object" || typeof error === "function")) seen.add(error);
  const name = stringProperty(error, "name") ?? (error instanceof Error ? error.name : "Error");
  const rawMessage =
    stringProperty(error, "message") ?? (typeof error === "string" ? error : "Operation failed");
  const diagnostic: SanitizedDiagnostic = {
    name: redactText(name, secrets).slice(0, 120),
    message: redactText(rawMessage, secrets).slice(0, 800),
  };
  const stack = stringProperty(error, "stack");
  if (stack) diagnostic.stack = redactText(stack, secrets).slice(0, 2500);
  const status = property(error, "status") ?? property(error, "statusCode");
  if (typeof status === "number") diagnostic.status = status;
  for (const key of ["code", "operation"] as const) {
    const candidate = property(error, key);
    const value =
      typeof candidate === "number"
        ? String(candidate)
        : typeof candidate === "string"
          ? candidate
          : undefined;
    if (value && /^[A-Za-z0-9_.:-]{1,80}$/.test(value)) diagnostic[key] = value;
  }
  if (depth < 3) {
    const cause = property(error, "cause");
    if (cause !== undefined) diagnostic.cause = extract(cause, secrets, depth + 1, seen);
    const aggregate = property(error, "errors");
    if (Array.isArray(aggregate)) {
      diagnostic.errors = aggregate
        .slice(0, 3)
        .map((item) => extract(item, secrets, depth + 1, seen));
    }
  }
  return diagnostic;
}

function removeStacks(diagnostic: SanitizedDiagnostic): void {
  delete diagnostic.stack;
  if (diagnostic.cause) removeStacks(diagnostic.cause);
  for (const child of diagnostic.errors ?? []) removeStacks(child);
}

export function safeDiagnostic(error: unknown, secrets: string[] = []): SanitizedDiagnostic {
  const result = extract(error, secrets, 0, new Set());
  if (JSON.stringify(result).length > 6000) {
    removeStacks(result);
  }
  if (JSON.stringify(result).length > 6000) {
    if (result.errors) result.errors = result.errors.slice(0, 1);
    if (result.cause) {
      delete result.cause.cause;
      delete result.cause.errors;
    }
  }
  if (JSON.stringify(result).length > 6000) {
    delete result.cause;
    delete result.errors;
    result.message = result.message.slice(0, 500);
  }
  return result;
}

export function safeError(error: unknown, secrets: string[] = []): string {
  const diagnostic = safeDiagnostic(error, secrets);
  const status = diagnostic.status ? ` (status ${diagnostic.status})` : "";
  return `${diagnostic.name}: ${diagnostic.message}${status}`.slice(0, 1200);
}
