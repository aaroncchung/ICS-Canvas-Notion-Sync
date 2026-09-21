import {
  object,
  id,
  scalarText,
  targetFromPage,
  UserError,
  VerificationError,
  type Config,
  type Target,
} from "./model.ts";

export class ApiError extends UserError {
  readonly service: "Canvas" | "Notion";
  readonly status: number;
  readonly retryAfter: number;
  constructor(service: "Canvas" | "Notion", status: number, retryAfter = 0, detail?: string) {
    super(
      `${service}: ${detail ?? (status === 0 ? "network failure or sign-in redirect" : `HTTP ${status}`)}`,
    );
    this.service = service;
    this.status = status;
    this.retryAfter = retryAfter;
  }
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}
export interface Page<T> {
  items: T[];
  next?: string;
}
export interface SyncApi {
  user(): Promise<string>;
  validateSchema(): Promise<void>;
  targets(cursor?: string): Promise<Page<Target>>;
  courses(enrollment: "active" | "completed", cursor?: string): Promise<Page<string>>;
  assignments(courseId: string, cursor?: string): Promise<Page<unknown>>;
  target(pageId: string): Promise<Target | undefined>;
  markDone(pageId: string): Promise<void>;
}
export interface ApiOptions {
  fetcher?: typeof fetch;
  pause?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Cancels a scan: checked before every attempt and passed to fetch. */
  signal?: AbortSignal;
  /** Runs before every attempt. The worker uses it to stay alive through a long scan. */
  beat?: () => Promise<void>;
}
const RETRIES = 2;
const LONGEST_RETRY_WAIT = 20_000;
export class Api implements SyncApi {
  private nextRequest = 0;
  private readonly config: Pick<Config, "origin" | "token" | "dataSourceId">;
  private readonly fetcher: typeof fetch;
  private readonly pause: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly signal: AbortSignal | undefined;
  private readonly beat: (() => Promise<void>) | undefined;
  constructor(config: Pick<Config, "origin" | "token" | "dataSourceId">, options: ApiOptions = {}) {
    this.config = config;
    // Chrome rejects fetch when it is invoked as a method of another object.
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.signal = options.signal;
    this.pause =
      options.pause ??
      ((ms) =>
        new Promise((resolve) => {
          const timer = setTimeout(resolve, ms);
          this.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        }));
    this.now = options.now ?? Date.now;
    this.beat = options.beat;
  }

  /** Every request here is idempotent, including the PATCH, so transient failures are retried. */
  private async request(
    service: "Canvas" | "Notion",
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ): Promise<{ data: unknown; response: Response }> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.attempt(service, path, body, method);
      } catch (error) {
        if (
          !(error instanceof ApiError) ||
          !error.retryable ||
          attempt === RETRIES ||
          error.retryAfter > LONGEST_RETRY_WAIT
        )
          throw error;
        await this.pause(Math.max(error.retryAfter, 1000 * 2 ** attempt));
      }
    }
  }
  private async attempt(
    service: "Canvas" | "Notion",
    path: string,
    body: unknown,
    method: string,
  ): Promise<{ data: unknown; response: Response }> {
    await this.pause(Math.max(0, this.nextRequest - this.now()));
    this.signal?.throwIfAborted();
    await this.beat?.();
    this.nextRequest = this.now() + 400;
    const url = new URL(path, service === "Canvas" ? this.config.origin : "https://api.notion.com");
    const headers: Record<string, string> = { Accept: "application/json" };
    if (service === "Notion") {
      headers.Authorization = `Bearer ${this.config.token}`;
      headers["Notion-Version"] = "2026-03-11";
    }
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const timeout = AbortSignal.timeout(10_000);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method,
        headers,
        redirect: "error",
        credentials: service === "Canvas" ? "include" : "omit",
        signal: this.signal ? AbortSignal.any([this.signal, timeout]) : timeout,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      this.signal?.throwIfAborted();
      throw new ApiError(service, 0);
    }
    if (!response.ok) {
      const retry = response.headers.get("Retry-After");
      const delay =
        retry && /^\d+(?:\.\d+)?$/.test(retry)
          ? Number(retry) * 1000
          : retry
            ? Date.parse(retry) - this.now()
            : 0;
      throw new ApiError(service, response.status, Number.isFinite(delay) ? Math.max(0, delay) : 0);
    }
    // A login page or other non-JSON answer will not improve on retry.
    const unexpected = new ApiError(service, response.status, 0, "unexpected response");
    if (!response.headers.get("Content-Type")?.includes("application/json")) throw unexpected;
    try {
      const data: unknown = JSON.parse((await response.text()).replace(/^while\s*\(1\);\s*/, ""));
      return { data, response };
    } catch {
      this.signal?.throwIfAborted();
      throw unexpected;
    }
  }
  private canvasPath(cursor: string | undefined, initial: string): string {
    const expected = new URL(initial, this.config.origin);
    const url = new URL(cursor ?? initial, this.config.origin);
    if (
      url.origin !== this.config.origin ||
      url.pathname !== expected.pathname ||
      url.username ||
      url.password ||
      url.hash
    ) {
      throw new UserError("Canvas returned an unexpected pagination destination");
    }
    // Only the path is passed back into the fixed-origin request function.
    return url.pathname + url.search;
  }
  private async canvasList(initial: string, cursor?: string): Promise<Page<unknown>> {
    const path = this.canvasPath(cursor, initial);
    const { data, response } = await this.request("Canvas", path);
    if (!Array.isArray(data)) throw new UserError("Canvas returned an invalid list");
    const link = response.headers
      .get("Link")
      ?.split(",")
      .find((part) => /rel="next"/.test(part));
    const nextUrl = link?.match(/<([^>]+)>/)?.[1];
    const next = nextUrl ? this.canvasPath(nextUrl, initial) : undefined;
    if (next === path) throw new UserError("Canvas pagination did not advance");
    return { items: data as unknown[], ...(next ? { next } : {}) };
  }
  async user(): Promise<string> {
    const { data } = await this.request("Canvas", "/api/v1/users/self/profile");
    const userId = id(object(data).id);
    if (!userId) throw new UserError("Canvas session did not return a user identity");
    return userId;
  }
  async validateSchema(): Promise<void> {
    const { data } = await this.request("Notion", `/v1/data_sources/${this.config.dataSourceId}`);
    const properties = object(object(data).properties);
    const expected = {
      "Canvas UID": "rich_text",
      "Canvas URL": "url",
      "Imported From": "select",
      "Personal Status": "status",
      "Removed from Canvas": "checkbox",
      "Canvas State": "select",
      Assignment: "title",
    };
    for (const [name, type] of Object.entries(expected)) {
      if (object(properties[name]).type !== type)
        throw new VerificationError(`Notion schema needs ${name} (${type})`);
    }
    const options: unknown = object(object(properties["Personal Status"]).status).options;
    if (
      !Array.isArray(options) ||
      !options.some((option: unknown) => object(option).name === "Done")
    ) {
      throw new VerificationError("Notion Personal Status needs the Done option");
    }
  }
  async targets(cursor?: string): Promise<Page<Target>> {
    const { data } = await this.request(
      "Notion",
      `/v1/data_sources/${this.config.dataSourceId}/query`,
      {
        filter: { property: "Imported From", select: { equals: "Canvas ICS" } },
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      },
    );
    const result = object(data);
    if (!Array.isArray(result.results)) throw new UserError("Notion returned an invalid page list");
    const next = result.has_more === true ? result.next_cursor : undefined;
    if (result.has_more === true && (typeof next !== "string" || !next || next === cursor)) {
      throw new UserError("Notion pagination did not advance");
    }
    return {
      items: result.results.flatMap((page: unknown) => {
        const target = targetFromPage(page);
        return target ? [target] : [];
      }),
      ...(typeof next === "string" ? { next } : {}),
    };
  }
  async courses(enrollment: "active" | "completed", cursor?: string): Promise<Page<string>> {
    const page = await this.canvasList(
      `/api/v1/courses?enrollment_type=student&enrollment_state=${enrollment}&per_page=100`,
      cursor,
    );
    return {
      ...page,
      items: page.items.flatMap((raw) => {
        const course = object(raw),
          courseId = id(course.id);
        // Date-restricted courses are listed but their assignments cannot be read.
        return courseId && course.access_restricted_by_date !== true ? [courseId] : [];
      }),
    };
  }
  assignments(courseId: string, cursor?: string): Promise<Page<unknown>> {
    return this.canvasList(
      `/api/v1/courses/${courseId}/assignments?include%5B%5D=submission&per_page=100`,
      cursor,
    );
  }
  async target(pageId: string): Promise<Target | undefined> {
    let data: unknown;
    try {
      ({ data } = await this.request("Notion", `/v1/pages/${encodeURIComponent(pageId)}`));
    } catch (error) {
      // A page deleted since the query is no longer a destination.
      if (error instanceof ApiError && error.status === 404) return;
      throw error;
    }
    // A moved page is no longer a valid destination even if its properties look similar.
    const parent = object(object(data).parent);
    if (
      scalarText(parent.data_source_id).replaceAll("-", "") !==
      this.config.dataSourceId.replaceAll("-", "")
    )
      return;
    return targetFromPage(data);
  }
  async markDone(pageId: string): Promise<void> {
    await this.request(
      "Notion",
      `/v1/pages/${encodeURIComponent(pageId)}`,
      {
        properties: { "Personal Status": { status: { name: "Done" } } },
      },
      "PATCH",
    );
  }
}
