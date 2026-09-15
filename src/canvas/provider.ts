import type { Logger } from "pino";
import type { AppConfig } from "../config.ts";
import type { AssignmentFeed, AssignmentProvider } from "../types.ts";
import { fetchFeed } from "./fetch-feed.ts";
import { parseIcs } from "./parse-ics.ts";
import {
  compileAssignmentTypeMatcher,
  type AssignmentTypeMatcher,
} from "./normalize-assignment.ts";

export class CanvasIcsProvider implements AssignmentProvider {
  private readonly config: AppConfig;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly assignmentTypeMatcher: AssignmentTypeMatcher;

  public constructor(config: AppConfig, logger: Logger, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.assignmentTypeMatcher = compileAssignmentTypeMatcher(config.assignmentTypeRules);
  }

  public async fetchAssignments(): Promise<AssignmentFeed> {
    this.logger.info("Fetching Canvas ICS feed");
    const source = await fetchFeed(this.config.CANVAS_ICS_URL, this.fetchImpl);
    const feed = parseIcs(source, this.assignmentTypeMatcher);
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
