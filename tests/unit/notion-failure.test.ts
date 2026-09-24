import { createRequestMetrics } from "../../src/observability/run-report.ts";
import { Client } from "@notionhq/client";
import { describe, expect, it } from "vitest";
import { isAmbiguousWriteError, withRetry } from "../../src/notion/client.ts";
import { classifyNotionFailure } from "../../src/notion/failure.ts";
import { safeDiagnostic } from "../../src/observability/redaction.ts";

interface ScriptedResponse {
  status: number;
  code?: string;
  headers?: Record<string, string>;
}

/** A real SDK client whose HTTP responses are scripted, so errors come from the SDK's own builder. */
function scriptedClient(...responses: ScriptedResponse[]): { client: Client; calls: () => number } {
  let calls = 0;
  const fetch = () => {
    const next = responses[Math.min(calls, responses.length - 1)]!;
    calls += 1;
    const body =
      next.status === 200
        ? { object: "page", id: "page-id" }
        : { object: "error", status: next.status, code: next.code, message: "Try later" };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: next.status,
        headers: { "content-type": "application/json", ...next.headers },
      }),
    );
  };
  const client = new Client({
    auth: "test-token",
    retry: false,
    fetch: fetch as unknown as NonNullable<
      NonNullable<ConstructorParameters<typeof Client>[0]>["fetch"]
    >,
    logger: () => undefined,
  });
  return { client, calls: () => calls };
}

const read = (client: Client) => () => client.pages.retrieve({ page_id: "page-id" });
const create = (client: Client) => () =>
  client.pages.create({ parent: { data_source_id: "source" }, properties: {} });

function recordedSleep(): { waits: number[]; sleep: (ms: number) => Promise<void> } {
  const waits: number[] = [];
  return {
    waits,
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  };
}

describe("Notion failure classification and retry policy", () => {
  it("retries a statusless read transport failure and succeeds", async () => {
    const metrics = createRequestMetrics();
    let attempts = 0;
    const value = await withRetry(
      () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(Object.assign(new Error("socket closed"), { code: "ECONNRESET" }))
          : Promise.resolve("ok");
      },
      { operation: "read", metrics, baseDelayMs: 0, sleep: () => Promise.resolve() },
    );
    expect(value).toBe("ok");
    expect(metrics.notionRequests).toBe(2);
    expect(metrics.readRetries).toBe(1);
  });

  it("exhausts bounded statusless read retries with a classified diagnostic", async () => {
    const metrics = createRequestMetrics();
    const error = Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" });
    await expect(
      withRetry(() => Promise.reject(error), {
        operation: "read",
        attempts: 3,
        metrics,
        baseDelayMs: 0,
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toBe(error);
    expect(metrics.notionRequests).toBe(3);
    expect(metrics.readRetries).toBe(2);
    expect(safeDiagnostic(error)).toMatchObject({
      failureClass: "transport",
      code: "ETIMEDOUT",
      operation: "read",
    });
  });

  it("retries a deterministic property update after a transport failure", async () => {
    const metrics = createRequestMetrics();
    let attempts = 0;
    await withRetry(
      () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(Object.assign(new Error("connection lost"), { code: "EPIPE" }))
          : Promise.resolve();
      },
      { operation: "property-update", metrics, baseDelayMs: 0, sleep: () => Promise.resolve() },
    );
    expect(attempts).toBe(2);
    expect(metrics.propertyUpdateRetries).toBe(1);
  });

  it("classifies the official Notion client timeout as transport ambiguity", () => {
    expect(
      classifyNotionFailure(
        Object.assign(new Error("Request to Notion API has timed out"), {
          name: "RequestTimeoutError",
          code: "notionhq_client_request_timeout",
        }),
      ),
    ).toEqual({
      kind: "transport",
      retryableRead: true,
      ambiguousWrite: true,
      code: "notionhq_client_request_timeout",
    });
  });

  it("classifies a statusless fetch response-stream termination", () => {
    expect(classifyNotionFailure(new TypeError("terminated"))).toEqual({
      kind: "transport",
      retryableRead: true,
      ambiguousWrite: true,
    });
  });

  it("does not classify an unknown programming error as transport ambiguity", () => {
    expect(classifyNotionFailure(new TypeError("Cannot read properties of undefined"))).toEqual({
      kind: "definite-client-error",
      retryable: false,
      ambiguousWrite: false,
    });
  });

  it("classifies a nested transport cause and exposes only sanitized diagnostics", () => {
    const token = "secret_abcdefghijk";
    const feedUrl = "https://canvas.example.edu/private/feed.ics?token=hidden";
    const error = new TypeError(`fetch failed ${token} ${feedUrl}`, {
      cause: Object.assign(new Error(`reset ${token}`), {
        code: "ECONNRESET",
        authorization: `Bearer ${token}`,
        request: { url: feedUrl },
      }),
    });
    expect(classifyNotionFailure(error)).toEqual({
      kind: "transport",
      retryableRead: true,
      ambiguousWrite: true,
      code: "ECONNRESET",
    });
    const serialized = JSON.stringify(safeDiagnostic(error, [token]));
    expect(serialized).toContain('"failureClass":"transport"');
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("canvas.example.edu");
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain("request");
  });

  it("waits the Retry-After delay of a 429 and counts the wait", async () => {
    const { client, calls } = scriptedClient(
      { status: 429, code: "rate_limited", headers: { "retry-after": "20" } },
      { status: 200 },
    );
    const metrics = createRequestMetrics();
    const { waits, sleep } = recordedSleep();
    await withRetry(read(client), { operation: "read", metrics, sleep });
    expect(calls()).toBe(2);
    expect(waits).toEqual([20_000]);
    expect(metrics).toMatchObject({
      notionRequests: 2,
      readRetries: 1,
      throttleRetries: 1,
      throttleWaitMs: 20_000,
    });
  });

  it("caps a long Retry-After at one minute", async () => {
    const { client } = scriptedClient(
      { status: 429, code: "rate_limited", headers: { "retry-after": "3600" } },
      { status: 200 },
    );
    const { waits, sleep } = recordedSleep();
    await withRetry(read(client), { operation: "read", sleep });
    expect(waits).toEqual([60_000]);
  });

  it("reads a Retry-After HTTP date against the injected clock", async () => {
    const now = Date.parse("2026-09-24T12:00:00Z");
    const { client } = scriptedClient(
      {
        status: 429,
        code: "rate_limited",
        headers: { "retry-after": "Thu, 24 Sep 2026 12:00:05 GMT" },
      },
      { status: 200 },
    );
    const { waits, sleep } = recordedSleep();
    await withRetry(read(client), { operation: "read", sleep, now: () => now });
    expect(waits).toEqual([5_000]);
  });

  it("falls back to exponential backoff when Retry-After is missing or malformed", async () => {
    const { client } = scriptedClient(
      { status: 429, code: "rate_limited", headers: { "retry-after": "soon" } },
      { status: 429, code: "rate_limited" },
      { status: 200 },
    );
    const metrics = createRequestMetrics();
    const { waits, sleep } = recordedSleep();
    await withRetry(read(client), { operation: "read", metrics, sleep, baseDelayMs: 100 });
    expect(waits).toHaveLength(2);
    expect(waits[0]).toBeGreaterThanOrEqual(100);
    expect(waits[0]).toBeLessThan(200);
    expect(waits[1]).toBeGreaterThanOrEqual(200);
    expect(waits[1]).toBeLessThan(300);
    expect(metrics.throttleRetries).toBe(2);
    expect(metrics.throttleWaitMs).toBe(waits[0]! + waits[1]!);
  });

  it("retries a 529 service_overload on a read", async () => {
    const { client, calls } = scriptedClient(
      { status: 529, code: "service_overload", headers: { "retry-after": "2" } },
      { status: 200 },
    );
    const metrics = createRequestMetrics();
    const { waits, sleep } = recordedSleep();
    await withRetry(read(client), { operation: "read", metrics, sleep });
    expect(calls()).toBe(2);
    expect(waits).toEqual([2_000]);
    expect(metrics).toMatchObject({ readRetries: 1, throttleRetries: 1, throttleWaitMs: 2_000 });
  });

  it("retries a 529 service_overload on a page create, which the server rejected", async () => {
    const { client, calls } = scriptedClient(
      { status: 529, code: "service_overload" },
      { status: 200 },
    );
    const metrics = createRequestMetrics();
    const { sleep } = recordedSleep();
    await withRetry(create(client), { operation: "page-create", metrics, sleep, baseDelayMs: 0 });
    expect(calls()).toBe(2);
    expect(metrics).toMatchObject({
      notionRequests: 2,
      requestsByOperation: { "page-create": 2 },
      throttleRetries: 1,
    });
  });

  it("reports an exhausted 529 page create as a definite, unambiguous failure", async () => {
    const { client, calls } = scriptedClient({ status: 529, code: "service_overload" });
    const { sleep } = recordedSleep();
    const failure = await withRetry(create(client), {
      operation: "page-create",
      attempts: 3,
      sleep,
      baseDelayMs: 0,
    }).catch((error: unknown) => error);
    expect(calls()).toBe(3);
    expect(classifyNotionFailure(failure)).toMatchObject({
      kind: "definite-response",
      status: 529,
      retryable: true,
      ambiguousWrite: false,
    });
    expect(isAmbiguousWriteError(failure)).toBe(false);
  });

  it("still does not retry an ambiguous 503 on a page create", async () => {
    const { client, calls } = scriptedClient({ status: 503, code: "service_unavailable" });
    const { sleep } = recordedSleep();
    await expect(
      withRetry(create(client), { operation: "page-create", sleep, baseDelayMs: 0 }),
    ).rejects.toMatchObject({ status: 503 });
    expect(calls()).toBe(1);
  });
});
