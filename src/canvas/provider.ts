import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import type { AssignmentFeed, AssignmentProvider } from "../types.js";
import { fetchFeed } from "./fetch-feed.js";
import { parseIcs } from "./parse-ics.js";

export class CanvasIcsProvider implements AssignmentProvider {
  public constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  public async fetchAssignments(): Promise<AssignmentFeed> {
    this.logger.info("Fetching Canvas ICS feed");
    const source = await fetchFeed(this.config.CANVAS_ICS_URL, this.fetchImpl);
    const feed = parseIcs(source, this.config.assignmentTypeRules);
    this.logger.info(
      {
        feedItems: feed.diagnostics.totalEvents,
        assignments: feed.assignments.length,
        cancelled: feed.cancelledAssignments.length,
        ignored: feed.diagnostics.events.filter((event) => event.kind === "ignored").length,
      },
      "Canvas ICS feed parsed",
    );
    return feed;
  }
}
