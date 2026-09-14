import { afterEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { OfficialNotionGateway } from "../../src/notion/client.js";
import {
  MANAGED_DESCRIPTION_TITLE,
  replaceManagedDescription,
} from "../../src/notion/descriptions.js";
import { FakeGateway, readManagedDescription } from "../helpers.js";

afterEach(() => vi.unstubAllGlobals());

describe("recovery boundaries", () => {
  it("counts paginated reads and retry attempts at the physical SDK boundary", async () => {
    const response = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response({ object: "error", status: 429, code: "rate_limited", message: "Wait" }, 429),
      )
      .mockResolvedValueOnce(response({ results: [{ id: "first" }], next_cursor: "next" }))
      .mockResolvedValueOnce(response({ results: [{ id: "second" }], next_cursor: null }));
    vi.stubGlobal("fetch", fetch);
    const gateway = new OfficialNotionGateway("test-token", pino({ level: "silent" }));
    expect(await gateway.queryDataSource("source")).toEqual([{ id: "first" }, { id: "second" }]);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(gateway.requestMetrics).toEqual({
      notionRequests: 3,
      requestsByOperation: { read: 3 },
      readRetries: 1,
      propertyUpdateRetries: 0,
    });
  });

  it("sends an ambiguous delete once through the real SDK and records the physical request", async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            object: "error",
            status: 503,
            code: "service_unavailable",
            message: "Unavailable",
          }),
          { status: 503, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const gateway = new OfficialNotionGateway("test-token", pino({ level: "silent" }));
    await expect(gateway.deleteBlock("block-id")).rejects.toMatchObject({ status: 503 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(gateway.requestMetrics.notionRequests).toBe(1);
    expect(gateway.requestMetrics.requestsByOperation.delete).toBe(1);
  });

  it("stops after a successful append with no visible progress and repairs on the next run", async () => {
    const gateway = new FakeGateway();
    gateway.seedBlock("page", {
      id: "old",
      type: "toggle",
      toggle: {
        rich_text: [{ type: "text", text: { content: MANAGED_DESCRIPTION_TITLE } }],
      },
    });
    gateway.seedBlock("old", {
      type: "paragraph",
      paragraph: {
        rich_text: [{ type: "text", text: { content: "Original" } }],
      },
    });
    const list = gateway.listBlocks.bind(gateway);
    let hideReplacement = true;
    vi.spyOn(gateway, "listBlocks").mockImplementation((id) =>
      hideReplacement && id.startsWith("page-block-") ? Promise.resolve([]) : list(id),
    );
    await expect(replaceManagedDescription(gateway, "page", "New description")).rejects.toThrow(
      "no visible progress",
    );
    expect(await readManagedDescription(gateway, "page")).toBe("Original");
    expect(gateway.writes.filter((value) => value.kind === "append")).toHaveLength(1);
    hideReplacement = false;
    await replaceManagedDescription(gateway, "page", "New description");
    expect(await readManagedDescription(gateway, "page")).toBe("New description");
    expect(gateway.writes.filter((value) => value.kind === "append")).toHaveLength(1);
  });
});
