import { pino, type DestinationStream, type Logger } from "pino";

export function createLogger(destination?: DestinationStream): Logger {
  const options = {
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
  };
  return destination ? pino(options, destination) : pino(options);
}
