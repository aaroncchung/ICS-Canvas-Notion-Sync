import { afterEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { OfficialNotionGateway, settleReads } from "../../src/notion/client.ts";

// Route the gateway's sleeps through the global timers so fake timers control them.
vi.mock("node:timers/promises", () => ({
  setTimeout: (ms: number) => new Promise<void>((resolve) => globalThis.setTimeout(resolve, ms)),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

interface Scripted {
  status: number;
  code?: string;
  retryAfter?: string;
  /** How long the response takes to arrive, so requests can overlap in flight. */
  latencyMs?: number;
}

/** Reads data sources through the real gateway and records when each request is sent. */
async function recordSends(
  script: Record<string, Scripted[]>,
  read = (gateway: OfficialNotionGateway): Promise<unknown> =>
    settleReads(Object.keys(script).map((id) => gateway.retrieveDataSource(id))),
): Promise<Array<[string, number]>> {
  vi.useFakeTimers({ now: 0 });
  vi.spyOn(Math, "random").mockReturnValue(0);
  const sent: Array<[string, number]> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const id = new URL(input).pathname.split("/")[3]!;
      sent.push([id, Date.now()]);
      const next = script[id]!.shift() ?? { status: 200 };
      if (next.latencyMs) await new Promise((resolve) => setTimeout(resolve, next.latencyMs));
      const body =
        next.status === 200
          ? { object: "data_source", id }
          : { object: "error", status: next.status, code: next.code, message: "Try later" };
      return new Response(JSON.stringify(body), {
        status: next.status,
        headers: {
          "content-type": "application/json",
          ...(next.retryAfter === undefined ? {} : { "retry-after": next.retryAfter }),
        },
      });
    }),
  );
  const gateway = new OfficialNotionGateway("test-token", pino({ level: "silent" }));
  const reads = read(gateway);
  await vi.runAllTimersAsync();
  await reads;
  return sent;
}

describe("Notion gateway pacing", () => {
  it("holds a concurrent read that already had a slot for the Retry-After window", async () => {
    const sent = await recordSends({
      a: [{ status: 429, code: "rate_limited", retryAfter: "2" }],
      b: [],
    });
    // Without the hold, b would go out at its 340 ms slot inside the window Notion asked for.
    expect(sent).toEqual([
      ["a", 0],
      ["b", 2_000],
      ["a", 2_340],
    ]);
  });

  it("holds for the backoff of a throttle without Retry-After", async () => {
    const sent = await recordSends({
      a: [{ status: 429, code: "rate_limited" }],
      b: [],
    });
    // b wakes at 340 inside the 350 ms backoff hold and takes the next free slot instead.
    expect(sent).toEqual([
      ["a", 0],
      ["b", 680],
      ["a", 1_020],
    ]);
  });

  it("does not hold for a retry that was not throttled", async () => {
    const sent = await recordSends({
      a: [{ status: 503, code: "service_unavailable" }],
      b: [],
    });
    expect(sent).toEqual([
      ["a", 0],
      ["b", 340],
      ["a", 680],
    ]);
  });

  it("never shortens a hold when a shorter throttle arrives later", async () => {
    const sent = await recordSends({
      a: [{ status: 429, code: "rate_limited", retryAfter: "1", latencyMs: 1_000 }],
      b: [{ status: 429, code: "rate_limited", retryAfter: "10" }],
    });
    // a's one-second throttle lands at 1 s, inside b's hold until 10.34 s, and must not end it.
    expect(sent).toEqual([
      ["a", 0],
      ["b", 340],
      ["a", 10_340],
      ["b", 10_680],
    ]);
  });

  it("holds the next read after a throttle that exhausts its retries", async () => {
    const throttle = { status: 429, code: "rate_limited", retryAfter: "2" };
    const sent = await recordSends(
      { a: [throttle, throttle, throttle, throttle], b: [] },
      async (gateway) => {
        await expect(gateway.retrieveDataSource("a")).rejects.toMatchObject({ status: 429 });
        await gateway.retrieveDataSource("b");
      },
    );
    // The fourth 429 is not retried, but b still waits out the two seconds it asked for.
    expect(sent).toEqual([
      ["a", 0],
      ["a", 2_000],
      ["a", 4_000],
      ["a", 6_000],
      ["b", 8_000],
    ]);
  });
});
