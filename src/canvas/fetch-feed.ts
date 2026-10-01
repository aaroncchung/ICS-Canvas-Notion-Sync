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

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Follows redirects by hand so that the secret feed path is only ever sent over HTTPS: an
 * automatic redirect to `http:` would resend it in cleartext. Errors never quote a URL.
 */
async function fetchOverHttps(
  url: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<Response> {
  let current = url;
  for (let redirects = 0; ; redirects += 1) {
    const response = await fetchImpl(current, {
      signal,
      headers: { Accept: "text/calendar, text/plain;q=0.9" },
      redirect: "manual",
    });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    void response.body?.cancel().catch(() => undefined);
    if (redirects >= MAX_REDIRECTS) {
      throw new Error(`Canvas feed redirected more than ${MAX_REDIRECTS} times`);
    }
    const location = response.headers.get("location");
    let next: URL;
    try {
      if (!location) throw new Error("missing Location");
      next = new URL(location, current);
    } catch {
      throw new Error("Canvas feed redirect has no valid Location header");
    }
    if (next.protocol !== "https:") {
      throw new Error("Canvas feed redirect to a non-HTTPS URL was refused");
    }
    current = next.toString();
  }
}

export async function fetchFeed(url: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetchOverHttps(url, fetchImpl, controller.signal);
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
