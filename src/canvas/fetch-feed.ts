const MAX_FEED_BYTES = 10 * 1024 * 1024;
const FEED_TOO_LARGE_ERROR = "Canvas feed exceeds the 10 MiB safety limit";

async function readFeedBody(response: Response): Promise<string> {
  if (!response.body) {
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_FEED_BYTES) throw new Error(FEED_TOO_LARGE_ERROR);
    return new TextDecoder().decode(bytes);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const textChunks: string[] = [];
  let bytesRead = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      bytesRead += value.byteLength;
      if (bytesRead > MAX_FEED_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new Error(FEED_TOO_LARGE_ERROR);
      }
      textChunks.push(decoder.decode(value, { stream: true }));
    }
    textChunks.push(decoder.decode());
    return textChunks.join("");
  } finally {
    reader.releaseLock();
  }
}

export async function fetchFeed(url: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { Accept: "text/calendar, text/plain;q=0.9" },
      redirect: "follow",
    });
    if (!response.ok) throw new Error(`Canvas feed request failed with status ${response.status}`);
    const length = Number(response.headers.get("content-length") ?? "0");
    if (length > MAX_FEED_BYTES) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error(FEED_TOO_LARGE_ERROR);
    }
    return await readFeedBody(response);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Canvas feed request timed out", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
