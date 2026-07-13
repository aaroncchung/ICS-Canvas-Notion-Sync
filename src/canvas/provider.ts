import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import type { AssignmentFeed, AssignmentProvider, ExternalAssignment } from "../types.js";
import { fetchFeed } from "./fetch-feed.js";
import { parseIcs } from "./parse-ics.js";

export class CanvasIcsProvider implements AssignmentProvider {
  public lastFeed?: AssignmentFeed;

  public constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  public async fetchAssignments(): Promise<ExternalAssignment[]> {
    this.logger.info("Fetching Canvas ICS feed");
    const source = await fetchFeed(this.config.CANVAS_ICS_URL, this.fetchImpl);
    this.lastFeed = parseIcs(source, this.config.assignmentTypeRules);
    this.logger.info(
      {
        feedItems: this.lastFeed.diagnostics.totalEvents,
        assignments: this.lastFeed.assignments.length,
        skipped: this.lastFeed.diagnostics.skippedEvents.length,
      },
      "Canvas ICS feed parsed",
    );
    return this.lastFeed.assignments;
  }
}
