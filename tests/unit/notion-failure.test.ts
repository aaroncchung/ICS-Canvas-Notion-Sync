import { createRequestMetrics } from "../../src/observability/run-report.ts";
import { describe, expect, it } from "vitest";
import { withRetry } from "../../src/notion/client.ts";
import { classifyNotionFailure } from "../../src/notion/failure.ts";
import { safeDiagnostic } from "../../src/observability/redaction.ts";

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
});
