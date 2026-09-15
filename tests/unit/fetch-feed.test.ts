import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchFeed } from "../../src/canvas/fetch-feed.ts";

const MAX_FEED_BYTES = 10 * 1024 * 1024;
const TOO_LARGE_ERROR = "Canvas feed exceeds the 10 MiB safety limit";

function fetchResponse(response: Response): typeof fetch {
  return () => Promise.resolve(response);
}

function streamedResponse(
  chunks: Uint8Array[],
  options: { contentLength?: string; onCancel?: () => void; onRead?: () => void } = {},
): Response {
  let index = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        options.onRead?.();
        const chunk = chunks[index++];
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel() {
        options.onCancel?.();
      },
    },
    { highWaterMark: 0 },
  );
  const headers = options.contentLength ? { "Content-Length": options.contentLength } : undefined;
  const init: ResponseInit = { status: 200 };
  if (headers) init.headers = headers;
  return new Response(body, init);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Canvas feed fetching", () => {
  it("accepts a response below the limit without Content-Length", async () => {
    const response = streamedResponse([new TextEncoder().encode("BEGIN:VCALENDAR\nEND:VCALENDAR")]);

    await expect(fetchFeed("https://canvas.test/feed", fetchResponse(response))).resolves.toBe(
      "BEGIN:VCALENDAR\nEND:VCALENDAR",
    );
  });

  it("accepts a response exactly at the limit", async () => {
    const response = streamedResponse([new Uint8Array(MAX_FEED_BYTES).fill(97)]);

    const result = await fetchFeed("https://canvas.test/feed", fetchResponse(response));

    expect(result.length).toBe(MAX_FEED_BYTES);
    expect(result.startsWith("aaa")).toBe(true);
  });

  it("rejects a response one byte over the limit", async () => {
    const response = streamedResponse([new Uint8Array(MAX_FEED_BYTES + 1)]);

    await expect(fetchFeed("https://canvas.test/feed", fetchResponse(response))).rejects.toThrow(
      TOO_LARGE_ERROR,
    );
  });

  it("does not trust a misleadingly small Content-Length", async () => {
    const response = streamedResponse([new Uint8Array(MAX_FEED_BYTES + 1)], {
      contentLength: "1",
    });

    await expect(fetchFeed("https://canvas.test/feed", fetchResponse(response))).rejects.toThrow(
      TOO_LARGE_ERROR,
    );
  });

  it("rejects an oversized Content-Length before reading the body", async () => {
    const onCancel = vi.fn();
    const onRead = vi.fn();
    const response = streamedResponse([new Uint8Array(1)], {
      contentLength: String(MAX_FEED_BYTES + 1),
      onCancel,
      onRead,
    });

    await expect(fetchFeed("https://canvas.test/feed", fetchResponse(response))).rejects.toThrow(
      TOO_LARGE_ERROR,
    );
    expect(onRead).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("does not bypass the limit when Content-Length is missing", async () => {
    const response = streamedResponse([new Uint8Array(MAX_FEED_BYTES), new Uint8Array(1)]);

    await expect(fetchFeed("https://canvas.test/feed", fetchResponse(response))).rejects.toThrow(
      TOO_LARGE_ERROR,
    );
  });

  it("stops reading many chunks when the threshold is crossed", async () => {
    let reads = 0;
    const chunks = Array.from({ length: 12 }, () => new Uint8Array(1024 * 1024));
    const response = streamedResponse(chunks, { onRead: () => reads++ });

    await expect(fetchFeed("https://canvas.test/feed", fetchResponse(response))).rejects.toThrow(
      TOO_LARGE_ERROR,
    );
    expect(reads).toBe(11);
  });

  it("decodes UTF-8 characters split across chunk boundaries", async () => {
    const bytes = new TextEncoder().encode("A😀B");
    const response = streamedResponse([bytes.slice(0, 3), bytes.slice(3)]);

    await expect(fetchFeed("https://canvas.test/feed", fetchResponse(response))).resolves.toBe(
      "A😀B",
    );
  });

  it("cancels an oversized streamed response", async () => {
    const onCancel = vi.fn();
    const response = streamedResponse([new Uint8Array(MAX_FEED_BYTES + 1)], { onCancel });

    await expect(fetchFeed("https://canvas.test/feed", fetchResponse(response))).rejects.toThrow(
      TOO_LARGE_ERROR,
    );
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("retains size protection when response.body is unavailable", async () => {
    const response = {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: null,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(MAX_FEED_BYTES + 1)),
    } as Response;

    await expect(fetchFeed("https://canvas.test/feed", fetchResponse(response))).rejects.toThrow(
      TOO_LARGE_ERROR,
    );
  });

  it("preserves the timeout error", async () => {
    vi.useFakeTimers();
    const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted", "AbortError"));
        });
      })) as typeof fetch;

    const assertion = expect(fetchFeed("https://canvas.test/feed", fetchImpl)).rejects.toThrow(
      "Canvas feed request timed out",
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });

  it("preserves non-success HTTP status handling", async () => {
    const response = new Response("unavailable", { status: 503 });

    await expect(fetchFeed("https://canvas.test/feed", fetchResponse(response))).rejects.toThrow(
      "Canvas feed request failed with status 503",
    );
  });
});
