import { pino, type Logger } from "pino";

export function createLogger(): Logger {
  return pino({
    level: process.env.LOG_LEVEL ?? "info",
    redact: {
      paths: [
        "CANVAS_ICS_URL",
        "NOTION_TOKEN",
        "*.CANVAS_ICS_URL",
        "*.NOTION_TOKEN",
        "*.authorization",
        "*.headers.authorization",
      ],
      censor: "[REDACTED]",
    },
  });
}
