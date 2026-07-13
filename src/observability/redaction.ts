const TOKEN_PATTERN = /\b(?:secret|ntn|oauth)[_-][A-Za-z0-9_-]{10,}\b/gi;
const AUTH_PATTERN = /(?:authorization\s*[:=]\s*|bearer\s+)[^\s,}\]]+/gi;
const URL_PATTERN = /https?:\/\/[^\s"']+/gi;

export function redactText(input: string, secrets: string[] = []): string {
  let output = input;
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    output = output.split(secret).join("[REDACTED]");
  }
  output = output.replace(TOKEN_PATTERN, "[REDACTED_TOKEN]");
  output = output.replace(AUTH_PATTERN, "Authorization: [REDACTED]");
  output = output.replace(URL_PATTERN, (raw) => {
    try {
      const url = new URL(raw);
      if (url.search || /calendar|feed|ics/i.test(url.pathname)) {
        return `${url.origin}${url.pathname}?[REDACTED]`;
      }
      return raw;
    } catch {
      return "[REDACTED_URL]";
    }
  });
  return output;
}

export function safeError(error: unknown, secrets: string[] = []): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactText(message, secrets).slice(0, 2000);
}
