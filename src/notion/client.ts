import { Client } from "@notionhq/client";
import type { Logger } from "pino";

export const NOTION_API_VERSION = "2026-03-11";
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);
const AMBIGUOUS_STATUSES = new Set([500, 502, 503, 504]);

export type NotionOperation =
  | "read"
  | "property-update"
  | "page-create"
  | "block-append"
  | "delete"
  | "sync-log-create";

export class AmbiguousNotionWriteError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AmbiguousNotionWriteError";
  }
}

export interface NotionGateway {
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
    },
  ): Promise<string>;
  updatePage(pageId: string, properties: Record<string, unknown>): Promise<void>;
  updateBlock(blockId: string, block: Record<string, unknown>): Promise<void>;
  listBlocks(pageId: string): Promise<Array<Record<string, unknown>>>;
  appendBlocks(parentId: string, children: Array<Record<string, unknown>>): Promise<string[]>;
  deleteBlock(blockId: string): Promise<void>;
}

export function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

export function isAmbiguousWriteError(error: unknown): boolean {
  return (
    error instanceof AmbiguousNotionWriteError || AMBIGUOUS_STATUSES.has(errorStatus(error) ?? 0)
  );
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: {
    attempts?: number;
    baseDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
    operation?: NotionOperation;
  } = {},
): Promise<T> {
  const attempts = options.attempts ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 350;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const operationType = options.operation ?? "read";
  const retriesAmbiguousFailures = ["read", "property-update"].includes(operationType);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const status = errorStatus(error) ?? 0;
      const retryable =
        TRANSIENT_STATUSES.has(status) && (status === 429 || retriesAmbiguousFailures);
      if (attempt === attempts - 1 || !retryable) throw error;
      const jitter = Math.floor(Math.random() * baseDelayMs);
      await sleep(baseDelayMs * 2 ** attempt + jitter);
    }
  }
  throw new Error("Retry attempts exhausted");
}

export class OfficialNotionGateway implements NotionGateway {
  private readonly client: Client;
  private nextRequestAt = 0;

  public constructor(
    token: string,
    private readonly logger: Logger,
  ) {
    this.client = new Client({ auth: token, notionVersion: NOTION_API_VERSION });
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
        has_more: boolean;
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
    } = {},
  ): Promise<string> {
    const request = {
      parent: { type: "data_source_id" as const, data_source_id: id },
      properties: properties as NonNullable<Parameters<Client["pages"]["create"]>[0]["properties"]>,
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
        has_more: boolean;
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
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
        return operation();
      },
      { operation: operationType },
    );
  }
}
