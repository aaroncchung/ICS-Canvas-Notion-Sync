/* eslint @typescript-eslint/require-await: "off" -- Chrome and HTTP promise doubles. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyState, object, type State } from "../src/model.ts";

const config = {
  origin: "https://canvas.test",
  token: "never-expose-this",
  dataSourceId: "12345678-1234-1234-1234-123456789012",
  userId: "7",
  enabled: true,
};
const extensionOrigin = "chrome-extension://test-extension/";
type MessageListener = Parameters<typeof chrome.runtime.onMessage.addListener>[0];
type UpdatedListener = Parameters<typeof chrome.tabs.onUpdated.addListener>[0];
type AlarmListener = Parameters<typeof chrome.alarms.onAlarm.addListener>[0];
let listener: MessageListener;
let updated: UpdatedListener;
let alarm: AlarmListener;
let stored: State;
let userId: number;
let notionStatus: string;
let canvas: "up" | "signed-out" | "offline";
let notion: "up" | "busy" | "read-only";
let activeTabUrl: string;
let hostAccess: boolean;
let revoke: ReturnType<typeof vi.fn>;
let requests: Array<{ url: string; method: string }>;
let access: ReturnType<typeof vi.fn>;
const json = (data: unknown) =>
  new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
function page() {
  return {
    id: "page-123",
    parent: { data_source_id: config.dataSourceId },
    properties: {
      Assignment: { title: [{ plain_text: "Homework" }] },
      "Canvas UID": { rich_text: [{ plain_text: "event-assignment-123" }] },
      "Canvas URL": { url: null },
      "Imported From": { type: "select", select: { name: "Canvas ICS" } },
      "Personal Status": { status: { name: notionStatus } },
      "Canvas State": { select: { name: "Active" } },
      "Removed from Canvas": { checkbox: false },
    },
  };
}
function ask(
  action: string,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    listener(
      { action, ...extra },
      { id: "test-extension", url: `${extensionOrigin}popup.html` },
      (value: unknown) => resolve(object(value)),
    );
  });
}
beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  stored = { ...emptyState(), config: { ...config }, previewReady: true };
  userId = 7;
  notionStatus = "In progress";
  canvas = "up";
  notion = "up";
  activeTabUrl = config.origin;
  hostAccess = true;
  revoke = vi.fn(async () => true);
  requests = [];
  access = vi.fn(async () => undefined);
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        setAccessLevel: access,
        get: async () => ({ "companion-v1": structuredClone(stored) }),
        set: async (value: Record<string, State>) => {
          stored = structuredClone(value["companion-v1"]!);
        },
      },
      session: { set: async () => undefined },
    },
    runtime: {
      id: "test-extension",
      getURL: (path: string) => extensionOrigin + path,
      onMessage: {
        addListener: (fn: MessageListener) => {
          listener = fn;
        },
      },
      onStartup: { addListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
    },
    tabs: {
      query: async () => [{ url: activeTabUrl }],
      onUpdated: {
        addListener: (fn: UpdatedListener) => {
          updated = fn;
        },
      },
      onActivated: { addListener: vi.fn() },
    },
    windows: {
      getLastFocused: async () => ({ focused: true, id: 1 }),
      onFocusChanged: { addListener: vi.fn() },
    },
    alarms: {
      get: async () => undefined,
      create: vi.fn(async () => undefined),
      clear: vi.fn(async () => true),
      onAlarm: {
        addListener: (fn: AlarmListener) => {
          alarm = fn;
        },
      },
    },
    action: { setBadgeText: vi.fn(async () => undefined) },
    permissions: { contains: async () => hostAccess, remove: revoke },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      requests.push({ url: url.toString(), method: init?.method ?? "GET" });
      const isCanvas = url.hostname !== "api.notion.com";
      if (isCanvas && canvas === "offline") throw new TypeError("offline");
      if (isCanvas && canvas === "signed-out") return new Response("{}", { status: 401 });
      if (!isCanvas && notion === "busy")
        return new Response("{}", { status: 429, headers: { "Retry-After": "600" } });
      if (!isCanvas && notion === "read-only" && init?.method === "PATCH")
        return new Response("{}", { status: 403 });
      if (url.pathname.endsWith("/profile")) return json({ id: userId });
      if (url.pathname === "/api/v1/courses") return json([{ id: 42 }]);
      if (url.pathname.endsWith("/assignments"))
        return json([
          {
            id: 123,
            name: "Homework",
            course_id: 42,
            submission: {
              assignment_id: 123,
              user_id: 7,
              workflow_state: "submitted",
              attempt: 1,
              submitted_at: "2026-09-21T12:00:00Z",
            },
          },
        ]);
      if (url.pathname.endsWith("/query")) return json({ results: [page()], has_more: false });
      if (url.pathname.startsWith("/v1/data_sources/"))
        return json({
          properties: {
            Assignment: { type: "title" },
            "Canvas UID": { type: "rich_text" },
            "Canvas URL": { type: "url" },
            "Imported From": { type: "select" },
            "Removed from Canvas": { type: "checkbox" },
            "Canvas State": { type: "select" },
            "Personal Status": { type: "status", status: { options: [{ name: "Done" }] } },
          },
        });
      if (url.pathname.startsWith("/v1/pages/")) {
        if (init?.method === "PATCH") notionStatus = "Done";
        return json(page());
      }
      throw new Error("Unexpected test request");
    }),
  );
  await import("../src/worker.ts");
  await ask("state");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("worker orchestration", () => {
  it("restricts storage and exposes neither token nor recovery state to the UI", async () => {
    expect(access).toHaveBeenCalledWith({ accessLevel: "TRUSTED_CONTEXTS" });
    const result = await ask("state");
    expect(JSON.stringify(result)).not.toContain(config.token);
    const respond = vi.fn();
    expect(
      listener({ action: "sync" }, { id: "test-extension", url: "https://canvas.test/" }, respond),
    ).toBe(false);
    expect(respond).not.toHaveBeenCalled();
  });
  it("coalesces page navigation events and preserves manual reopening on later visits", async () => {
    const tab = { url: config.origin } as chrome.tabs.Tab;
    updated(1, { status: "complete" }, tab);
    updated(2, { status: "complete" }, tab);
    await vi.advanceTimersByTimeAsync(20_000);
    await ask("state");
    expect(requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
    expect(stored.report?.updated).toBe(1);
    notionStatus = "In progress";
    updated(1, { status: "complete" }, tab);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    alarm({ name: "tick", scheduledTime: Date.now(), persistAcrossSessions: true });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(notionStatus).toBe("In progress");
    expect(requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
  });
  it("refuses automatic writes while paused but permits a read-only preview", async () => {
    await ask("pause");
    expect((await ask("sync")).ok).toBe(false);
    expect((await ask("preview")).ok).toBe(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(stored.report?.mode).toBe("preview");
    expect(stored.report?.eligible).toBe(1);
    expect(stored.acknowledged).toEqual({});
    expect(requests.some((r) => r.method === "PATCH")).toBe(false);
  });
  it("turns automatic sync off when the signed-in Canvas account changes", async () => {
    userId = 8;
    updated(1, { status: "complete" }, { url: config.origin } as chrome.tabs.Tab);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(stored.config?.enabled).toBe(false);
    expect(stored.error).toContain("account changed");
    expect(requests.some((r) => r.method === "PATCH")).toBe(false);
  });
  it("stays enabled through an expired session and an outage, then syncs by itself", async () => {
    const tab = { url: config.origin } as chrome.tabs.Tab;
    for (const failure of ["signed-out", "offline"] as const) {
      canvas = failure;
      updated(1, { status: "complete" }, tab);
      // Longer than the retries plus the one-minute cooldown after a failed scan.
      await vi.advanceTimersByTimeAsync(70_000);
      expect(stored.config?.enabled).toBe(true);
      expect(stored.error).toContain("Canvas");
      expect(stored.report?.failed).toBe(1);
    }
    canvas = "up";
    updated(1, { status: "complete" }, tab);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(stored.error).toBeUndefined();
    expect(stored.report?.updated).toBe(1);
  });
  it("turns automatic sync off when the integration may read but not update", async () => {
    notion = "read-only";
    updated(1, { status: "complete" }, { url: config.origin } as chrome.tabs.Tab);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(stored.error).toContain("Update content");
    expect(stored.config?.enabled).toBe(false);
    expect(stored.previewReady).toBe(false);
    expect(requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
  });
  it("stays away for as long as a throttling service asks, up to an hour", async () => {
    const tab = { url: config.origin } as chrome.tabs.Tab;
    notion = "busy";
    updated(1, { status: "complete" }, tab);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(stored.error).toContain("HTTP 429");
    expect(stored.config?.enabled).toBe(true);
    notion = "up";
    const before = requests.length;
    // Past the usual one-minute wait after a failure, but inside the ten minutes Notion asked for.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    updated(1, { status: "complete" }, tab);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(requests).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    updated(1, { status: "complete" }, tab);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(stored.report?.updated).toBe(1);
  });
  it("names withdrawn host access instead of reporting a dead network, and recovers", async () => {
    const tab = { url: config.origin } as chrome.tabs.Tab;
    hostAccess = false;
    updated(1, { status: "complete" }, tab);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(stored.error).toContain("host access was removed");
    expect(stored.config?.enabled).toBe(true);
    expect(requests).toEqual([]);
    hostAccess = true;
    await vi.advanceTimersByTimeAsync(60_000);
    updated(1, { status: "complete" }, tab);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(stored.error).toBeUndefined();
    expect(stored.report?.updated).toBe(1);
  });
  it("says which step is missing when Sync now is refused", async () => {
    await ask("pause");
    expect((await ask("sync")).error).toContain("Enable sync");
    stored.previewReady = false;
    expect((await ask("sync")).error).toContain("Run Preview");
  });
  it("answers the popup during a scan and stops promptly when paused", async () => {
    const started = await ask("sync");
    expect(object(started.state).running).toBe(true);
    // No timers advance here: neither reading state nor pausing waits for the scan's requests.
    expect(object((await ask("state")).state).running).toBe(true);
    expect((await ask("preview")).ok).toBe(false);
    const paused = object((await ask("pause")).state);
    expect(paused).toMatchObject({ running: false, enabled: false });
    expect(JSON.stringify(paused.report)).toContain("Paused before finishing");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(requests.some((r) => r.method === "PATCH")).toBe(false);
  });
  it("still works where Chrome cannot restrict the local storage area", async () => {
    // Chrome before 140 rejects setAccessLevel for storage.local.
    access.mockRejectedValue(
      new Error("This StorageArea is not available for setting access level"),
    );
    vi.mocked(chrome.alarms.create).mockClear();
    vi.resetModules();
    await import("../src/worker.ts");
    expect((await ask("state")).ok).toBe(true);
    expect(chrome.alarms.create).toHaveBeenCalledWith("tick", { periodInMinutes: 1 });
    expect((await ask("sync")).ok).toBe(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(stored.report?.updated).toBe(1);
  });
  it("pause also stops a scan that is queued but has not started", async () => {
    // Not awaited: the scan is in the queue, still reading its state, when Pause arrives.
    const syncing = ask("sync");
    const paused = await ask("pause");
    await syncing;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(object(paused.state)).toMatchObject({ running: false, enabled: false });
    expect(requests).toEqual([]);
  });
  it("scans on a timer only while Canvas is the visible tab", async () => {
    activeTabUrl = "https://example.com/";
    alarm({ name: "tick", scheduledTime: Date.now(), persistAcrossSessions: true });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(requests).toEqual([]);
    activeTabUrl = `${config.origin}/courses/42`;
    alarm({ name: "tick", scheduledTime: Date.now(), persistAcrossSessions: true });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(stored.report?.updated).toBe(1);
  });
});

describe("settings", () => {
  async function configure(values: Record<string, string>) {
    const pending = ask("configure", {
      config: { origin: config.origin, dataSourceId: config.dataSourceId, token: "", ...values },
    });
    await vi.advanceTimersByTimeAsync(20_000);
    return pending;
  }
  it("refuses a malformed origin or missing host access before contacting anything", async () => {
    for (const origin of ["https://canvas.test/courses", "http://canvas.test", "canvas.test"])
      expect((await configure({ origin })).error).toContain("without a path");
    expect((await configure({ dataSourceId: "not-a-uuid" })).error).toContain("data-source ID");
    hostAccess = false;
    expect((await configure({})).error).toContain("host access");
    expect(requests).toEqual([]);
  });
  it("saves the data-source ID in the lowercase form Notion answers with", async () => {
    const typed = "ABCDEF12-1234-1234-1234-123456789ABC";
    expect((await configure({ dataSourceId: typed })).ok).toBe(true);
    expect(stored.config?.dataSourceId).toBe(typed.toLowerCase());
    expect(requests.some((r) => r.url.includes(typed))).toBe(false);
  });
  it("does not keep new host access when the form itself is rejected", async () => {
    // First setup: there is no saved token for a blank field to fall back on.
    stored = emptyState();
    expect((await configure({ origin: "https://other.test" })).error).toContain("token");
    expect(
      (await configure({ origin: "https://other.test", dataSourceId: "x" })).error,
    ).toBeTruthy();
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenCalledWith({ origins: ["https://other.test/*"] });
    expect(requests).toEqual([]);
  });
  it("keeps the saved token and history for the same connection, and requires a new preview", async () => {
    stored.acknowledged = { "page-123:123": "attempt:1" };
    const result = await configure({ dataSourceId: config.dataSourceId.replaceAll("-", "") });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain(config.token);
    expect(stored.config).toMatchObject({ token: config.token, userId: "7", enabled: false });
    expect(stored.previewReady).toBe(false);
    expect(stored.acknowledged).toEqual({ "page-123:123": "attempt:1" });
    expect(revoke).not.toHaveBeenCalled();
  });
  it("starts fresh history for another data source or Canvas, releasing the old host", async () => {
    stored.acknowledged = { "page-123:123": "attempt:1" };
    await configure({ dataSourceId: "99999999-1234-1234-1234-123456789012", token: "new-token" });
    expect(stored.acknowledged).toEqual({});
    expect(stored.config?.token).toBe("new-token");
    expect(revoke).not.toHaveBeenCalled();
    await configure({ origin: "https://other.test" });
    expect(stored.config?.origin).toBe("https://other.test");
    expect(revoke).toHaveBeenCalledWith({ origins: [`${config.origin}/*`] });
  });
  it("does not keep host access for a new Canvas that failed verification", async () => {
    canvas = "signed-out";
    expect((await configure({})).error).toContain("HTTP 401");
    expect(revoke).not.toHaveBeenCalled();
    expect((await configure({ origin: "https://other.test" })).error).toContain("HTTP 401");
    expect(revoke).toHaveBeenCalledWith({ origins: ["https://other.test/*"] });
    expect(stored.config?.origin).toBe(config.origin);
  });
});
