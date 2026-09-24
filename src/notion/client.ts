import { createRequestMetrics } from "../observability/run-report.ts";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@notionhq/client";
import type { Logger } from "pino";
import type { RequestMetrics } from "../types.ts";
import { classifyNotionFailure, retryAfterMs } from "./failure.ts";
export { AmbiguousNotionWriteError } from "./failure.ts";

export const NOTION_API_VERSION = "2026-03-11";
/** Longest single wait a Retry-After header can impose before the next attempt. */
export const MAX_RETRY_AFTER_MS = 60_000;

export type NotionOperation =
  "read" | "property-update" | "page-create" | "block-append" | "delete" | "sync-log-create";

export interface NotionGateway {
  readonly requestMetrics: RequestMetrics;
  retrieveDataSource(id: string): Promise<Record<string, unknown>>;
  queryDataSource(
    id: string,
    filter?: Record<string, unknown>,
  ): Promise<Array<Record<string, unknown>>>;
  createPage(
    id: string,
    properties: Record<string, unknown>,
    options?: {
      useDefaultTemplate?: boolean;
      templateTimezone?: string;
      operation?: "page-create" | "sync-log-create";
      children?: Array<Record<string, unknown>>;
    },
  ): Promise<string>;
  updatePage(pageId: string, properties: Record<string, unknown>): Promise<void>;
  updateBlock(blockId: string, block: Record<string, unknown>): Promise<void>;
  listBlocks(pageId: string): Promise<Array<Record<string, unknown>>>;
  appendBlocks(parentId: string, children: Array<Record<string, unknown>>): Promise<string[]>;
  deleteBlock(blockId: string): Promise<void>;
}

/** Drain concurrent reads before reporting a failure, so no sync requests leak into logging. */
export async function settleReads<T extends unknown[]>(reads: {
  [K in keyof T]: Promise<T[K]>;
}): Promise<T> {
  const settled = await Promise.allSettled(reads);
  for (const result of settled) if (result.status === "rejected") throw result.reason;
  return settled.map((result) => (result.status === "fulfilled" ? result.value : undefined)) as T;
}

export function errorStatus(error: unknown): number | undefined {
  const classification = classifyNotionFailure(error);
  return classification.kind === "definite-response" ? classification.status : undefined;
}

export function isAmbiguousWriteError(error: unknown): boolean {
  return classifyNotionFailure(error).ambiguousWrite;
}

function classifyOperation(error: unknown, operation: NotionOperation): unknown {
  if (!error || (typeof error !== "object" && typeof error !== "function")) return error;
  try {
    if (!("operation" in error)) {
      Object.defineProperty(error, "operation", { value: operation, configurable: true });
    }
  } catch {
    // Some third-party error objects are non-extensible; the original error remains useful.
  }
  return error;
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: {
    attempts?: number;
    baseDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
    operation?: NotionOperation;
    onRetry?: (operation: NotionOperation) => void;
    metrics?: RequestMetrics;
    now?: () => number;
  } = {},
): Promise<T> {
  const attempts = options.attempts ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 350;
  const pause = options.sleep ?? sleep;
  const now = options.now ?? Date.now;
  const operationType = options.operation ?? "read";
  const retriesAmbiguousFailures = ["read", "property-update"].includes(operationType);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (options.metrics) {
      options.metrics.notionRequests += 1;
      options.metrics.requestsByOperation[operationType] =
        (options.metrics.requestsByOperation[operationType] ?? 0) + 1;
    }
    try {
      return await operation();
    } catch (error) {
      const failure = classifyNotionFailure(error);
      // A throttled request (429/529) was rejected, not processed, so every operation may retry it.
      const throttled = failure.kind === "definite-response" && failure.throttled;
      const retryable =
        failure.kind === "definite-response"
          ? failure.retryable && (throttled || retriesAmbiguousFailures)
          : failure.kind === "transport" && failure.retryableRead && retriesAmbiguousFailures;
      if (attempt === attempts - 1 || !retryable) {
        throw classifyOperation(error, operationType);
      }
      if (operationType === "read" && options.metrics) options.metrics.readRetries += 1;
      if (operationType === "property-update" && options.metrics) {
        options.metrics.propertyUpdateRetries += 1;
      }
      options.onRetry?.(operationType);
      const requested = throttled ? retryAfterMs(error, now()) : undefined;
      const delay =
        requested === undefined
          ? baseDelayMs * 2 ** attempt + Math.floor(Math.random() * baseDelayMs)
          : Math.min(requested, MAX_RETRY_AFTER_MS);
      if (throttled && options.metrics) {
        options.metrics.throttleRetries += 1;
        options.metrics.throttleWaitMs += delay;
      }
      await pause(delay);
    }
  }
  throw new Error("Retry attempts exhausted");
}

export class OfficialNotionGateway implements NotionGateway {
  private readonly client: Client;
  private nextRequestAt = 0;

  private readonly logger: Logger;
  public readonly requestMetrics: RequestMetrics;

  public constructor(
    token: string,
    logger: Logger,
    requestMetrics: RequestMetrics = createRequestMetrics(),
  ) {
    this.logger = logger;
    this.requestMetrics = requestMetrics;
    // Recovery and physical request accounting belong to this gateway, including DELETE.
    this.client = new Client({ auth: token, notionVersion: NOTION_API_VERSION, retry: false });
  }

  public async retrieveDataSource(id: string): Promise<Record<string, unknown>> {
    const response: unknown = await this.request("read", () =>
      this.client.dataSources.retrieve({ data_source_id: id }),
    );
    return response as Record<string, unknown>;
  }

  public async queryDataSource(
    id: string,
    filter?: Record<string, unknown>,
  ): Promise<Array<Record<string, unknown>>> {
    const results: Array<Record<string, unknown>> = [];
    let cursor: string | undefined;
    do {
      const request = {
        data_source_id: id,
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
        ...(filter ? { filter } : {}),
      };
      const response = (await this.request("read", () =>
        this.client.dataSources.query(request as Parameters<Client["dataSources"]["query"]>[0]),
      )) as unknown as {
        results: Array<Record<string, unknown>>;
        next_cursor: string | null;
      };
      results.push(...response.results);
      cursor = response.next_cursor ?? undefined;
    } while (cursor);
    return results;
  }

  public async createPage(
    id: string,
    properties: Record<string, unknown>,
    options: {
      useDefaultTemplate?: boolean;
      templateTimezone?: string;
      operation?: "page-create" | "sync-log-create";
      children?: Array<Record<string, unknown>>;
    } = {},
  ): Promise<string> {
    if (options.useDefaultTemplate && options.children) {
      throw new Error("Notion templates cannot be combined with initial children");
    }
    const request = {
      parent: { type: "data_source_id" as const, data_source_id: id },
      properties: properties as NonNullable<Parameters<Client["pages"]["create"]>[0]["properties"]>,
      ...(options.children
        ? {
            children: options.children as NonNullable<
              Parameters<Client["pages"]["create"]>[0]["children"]
            >,
          }
        : {}),
      ...(options.useDefaultTemplate
        ? {
            template: {
              type: "default" as const,
              ...(options.templateTimezone ? { timezone: options.templateTimezone } : {}),
            },
          }
        : {}),
    };
    const page = (await this.request(options.operation ?? "page-create", () =>
      this.client.pages.create(request),
    )) as { id: string };
    return page.id;
  }

  public async updatePage(pageId: string, properties: Record<string, unknown>): Promise<void> {
    await this.request("property-update", () =>
      this.client.pages.update({
        page_id: pageId,
        properties: properties as NonNullable<
          Parameters<Client["pages"]["update"]>[0]["properties"]
        >,
      }),
    );
  }

  public async updateBlock(blockId: string, block: Record<string, unknown>): Promise<void> {
    await this.request("property-update", () =>
      this.client.blocks.update({
        block_id: blockId,
        ...block,
      }),
    );
  }

  public async listBlocks(pageId: string): Promise<Array<Record<string, unknown>>> {
    const results: Array<Record<string, unknown>> = [];
    let cursor: string | undefined;
    do {
      const response = (await this.request("read", () =>
        this.client.blocks.children.list({
          block_id: pageId,
          page_size: 100,
          ...(cursor ? { start_cursor: cursor } : {}),
        }),
      )) as unknown as {
        results: Array<Record<string, unknown>>;
        next_cursor: string | null;
      };
      results.push(...response.results);
      cursor = response.next_cursor ?? undefined;
    } while (cursor);
    return results;
  }

  public async appendBlocks(
    parentId: string,
    children: Array<Record<string, unknown>>,
  ): Promise<string[]> {
    const response = (await this.request("block-append", () =>
      this.client.blocks.children.append({
        block_id: parentId,
        children: children as Parameters<Client["blocks"]["children"]["append"]>[0]["children"],
      }),
    )) as unknown as { results: Array<{ id: string }> };
    return response.results.map((block) => block.id);
  }

  public async deleteBlock(blockId: string): Promise<void> {
    await this.request("delete", () => this.client.blocks.delete({ block_id: blockId }));
  }

  private async request<T>(
    operationType: NotionOperation,
    operation: () => Promise<T>,
  ): Promise<T> {
    return withRetry(
      async () => {
        const now = Date.now();
        const scheduledAt = Math.max(now, this.nextRequestAt);
        this.nextRequestAt = scheduledAt + 340;
        const delay = scheduledAt - now;
        if (delay > 0) {
          this.logger.debug({ delay }, "Applying conservative Notion request pacing");
          await sleep(delay);
        }
        return operation();
      },
      {
        operation: operationType,
        metrics: this.requestMetrics,
      },
    );
  }
}
