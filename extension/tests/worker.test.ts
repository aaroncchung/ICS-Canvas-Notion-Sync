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
      query: async () => [{ url: config.origin }],
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
    permissions: { contains: async () => true, remove: async () => true },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      requests.push({ url: url.toString(), method: init?.method ?? "GET" });
      if (url.origin === config.origin && canvas === "offline") throw new TypeError("offline");
      if (url.origin === config.origin && canvas === "signed-out")
        return new Response("{}", { status: 401 });
      if (url.pathname.endsWith("/profile")) return json({ id: userId });
      if (url.pathname === "/api/v1/courses") return json([{ id: 42 }]);
      if (url.pathname.endsWith("/assignments"))
        return json([
          {
            id: 123,
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
});
