const MAX_FEED_BYTES = 10 * 1024 * 1024;

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
    if (length > MAX_FEED_BYTES) throw new Error("Canvas feed exceeds the 10 MiB safety limit");
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_FEED_BYTES) {
      throw new Error("Canvas feed exceeds the 10 MiB safety limit");
    }
    return text;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Canvas feed request timed out", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
