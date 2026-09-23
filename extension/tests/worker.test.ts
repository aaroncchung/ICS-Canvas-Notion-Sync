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
type AlarmListener = Parameters<typeof chrome.alarms.onAlarm.addListener>[0];
type PermissionsListener = Parameters<typeof chrome.permissions.onRemoved.addListener>[0];
type Script = chrome.scripting.RegisteredContentScript;
let listener: MessageListener;
let alarm: AlarmListener;
/** The one pending alarm, as Chrome would keep it. */
let armed: chrome.alarms.AlarmCreateInfo | undefined;
/** Content scripts registered with Chrome, which outlive the worker. */
let scripts: Script[];
let accessRemoved: PermissionsListener;
let accessAdded: PermissionsListener;
let stored: State;
let userId: number;
let notionStatus: string;
let canvas: "up" | "signed-out" | "offline";
let notion: "up" | "busy" | "read-only" | "revoked" | "unshared";
/** An option the Notion schema no longer offers, or nothing. */
let schemaWithout: string;
let activeTabUrl: string | undefined;
let hostAccess: boolean;
let notionAccess: boolean;
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
/** The Canvas page script reporting that its page loaded, came into view, or regained focus. */
function visit(url = `${config.origin}/courses/42`) {
  const respond = vi.fn();
  const tab = { id: 1, url } as chrome.tabs.Tab;
  expect(listener({ action: "wake" }, { id: "test-extension", url, tab }, respond)).toBe(false);
  expect(respond).not.toHaveBeenCalled();
}
/** How long the last scan held the next automatic one back, counted from when it finished. */
const wait = () => stored.nextScanAt - Date.parse(stored.report?.finishedAt ?? "");
/** Runs the clock up to the moment the next automatic scan is due. */
const untilDue = () => vi.advanceTimersByTimeAsync(Math.max(0, stored.nextScanAt - Date.now()));
/** Scans that got as far as reading Notion. */
const scans = () => requests.filter((r) => r.url.endsWith("/query")).length;
/** The pending alarm going off, which spends it. */
function ring() {
  armed = undefined;
  alarm({ name: "tick", scheduledTime: Date.now(), persistAcrossSessions: true });
}
/** Loads the worker afresh, as Chrome does when it starts the worker again. */
async function restart() {
  vi.resetModules();
  await import("../src/worker.ts");
  await vi.advanceTimersByTimeAsync(1_000);
}
beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  stored = { ...emptyState(), config: { ...config }, previewReady: true };
  userId = 7;
  notionStatus = "In progress";
  canvas = "up";
  notion = "up";
  schemaWithout = "";
  activeTabUrl = config.origin;
  hostAccess = true;
  notionAccess = true;
  revoke = vi.fn(async () => true);
  requests = [];
  access = vi.fn(async () => undefined);
  armed = undefined;
  scripts = [];
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
    // No listeners here: tab and window events would wake the worker for every site.
    tabs: { query: async () => [{ url: activeTabUrl }] },
    windows: { getLastFocused: async () => ({ focused: true, id: 1 }) },
    scripting: {
      getRegisteredContentScripts: async ({ ids }: { ids: string[] }) =>
        structuredClone(scripts.filter((script) => ids.includes(script.id))),
      // Chrome refuses an ID it already has, or one it does not have, as these do.
      registerContentScripts: vi.fn(async (added: Script[]) => {
        if (added.some(({ id }) => scripts.some((script) => script.id === id)))
          throw new Error("Duplicate script ID");
        scripts.push(...structuredClone(added));
      }),
      updateContentScripts: vi.fn(async (changed: Script[]) => {
        if (changed.some(({ id }) => !scripts.some((script) => script.id === id)))
          throw new Error("Nonexistent script ID");
        scripts = scripts.map((script) => changed.find(({ id }) => id === script.id) ?? script);
      }),
      unregisterContentScripts: vi.fn(async ({ ids }: { ids: string[] }) => {
        if (ids.some((id) => !scripts.some((script) => script.id === id)))
          throw new Error("Nonexistent script ID");
        scripts = scripts.filter((script) => !ids.includes(script.id));
      }),
    },
    alarms: {
      get: async (name: string) =>
        armed && {
          name,
          scheduledTime: armed.when ?? Date.now(),
          periodInMinutes: armed.periodInMinutes,
        },
      create: vi.fn(async (_name: string, info: chrome.alarms.AlarmCreateInfo) => {
        armed = { ...info };
      }),
      clear: vi.fn(async () => {
        const cleared = Boolean(armed);
        armed = undefined;
        return cleared;
      }),
      onAlarm: {
        addListener: (fn: AlarmListener) => {
          alarm = fn;
        },
      },
    },
    action: { setBadgeText: vi.fn(async () => undefined) },
    permissions: {
      contains: async ({ origins }: { origins: string[] }) =>
        origins[0]?.includes("api.notion.com") ? notionAccess : hostAccess,
      remove: revoke,
      onRemoved: {
        addListener: (fn: PermissionsListener) => {
          accessRemoved = fn;
        },
      },
      onAdded: {
        addListener: (fn: PermissionsListener) => {
          accessAdded = fn;
        },
      },
    },
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
      if (!isCanvas && notion === "revoked") return new Response("{}", { status: 401 });
      if (!isCanvas && notion === "unshared" && url.pathname.startsWith("/v1/data_sources/"))
        return new Response("{}", { status: 404 });
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
      if (url.pathname.startsWith("/v1/data_sources/")) {
        const options = (...names: string[]) => ({
          options: names.filter((name) => name !== schemaWithout).map((name) => ({ name })),
        });
        return json({
          properties: {
            Assignment: { type: "title" },
            "Canvas UID": { type: "rich_text" },
            "Canvas URL": { type: "url" },
            "Imported From": { type: "select", select: options("Canvas ICS", "Manual") },
            "Removed from Canvas": { type: "checkbox" },
            "Canvas State": { type: "select", select: options("Active", "Removed") },
            "Personal Status": {
              type: "status",
              status: options("Not started", "In progress", "Done"),
            },
          },
        });
      }
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
    visit();
    visit();
    await vi.advanceTimersByTimeAsync(20_000);
    await ask("state");
    expect(requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
    expect(stored.report?.updated).toBe(1);
    notionStatus = "In progress";
    visit();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
    // Five minutes no longer brings the next scan; fifteen do.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    visit();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(scans()).toBe(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    ring();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(scans()).toBe(2);
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
    visit();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(stored.config?.enabled).toBe(false);
    expect(stored.error).toContain("account changed");
    expect(requests.some((r) => r.method === "PATCH")).toBe(false);
  });
  it("stays enabled through an expired session and an outage, then syncs by itself", async () => {
    for (const failure of ["signed-out", "offline"] as const) {
      canvas = failure;
      visit();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(stored.config?.enabled).toBe(true);
      expect(stored.error).toContain("Canvas");
      expect(stored.report?.failed).toBe(1);
      await untilDue();
    }
    canvas = "up";
    visit();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(stored.error).toBeUndefined();
    expect(stored.report?.updated).toBe(1);
  });
  it("turns automatic sync off when the integration may read but not update", async () => {
    notion = "read-only";
    visit();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(stored.error).toContain("Update content");
    expect(stored.config?.enabled).toBe(false);
    expect(stored.previewReady).toBe(false);
    expect(requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
  });
  it("turns automatic sync off when the token is revoked or the data source is no longer shared", async () => {
    for (const [failure, text] of [
      ["revoked", "token"],
      ["unshared", "Share it with the integration"],
    ] as const) {
      stored = { ...emptyState(), config: { ...config }, previewReady: true };
      notion = failure;
      visit();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(stored.config?.enabled).toBe(false);
      expect(stored.previewReady).toBe(false);
      expect(stored.error).toContain(text);
      expect(stored.report?.failed).toBe(1);
    }
    expect(requests.some((r) => r.method === "PATCH")).toBe(false);
  });
  it("turns automatic sync off when a required select option is renamed or removed", async () => {
    for (const [option, text] of [
      ["Canvas ICS", "Imported From needs the Canvas ICS option"],
      ["Removed", "Canvas State needs the Removed option"],
    ] as const) {
      stored = { ...emptyState(), config: { ...config }, previewReady: true };
      schemaWithout = option;
      visit();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(stored.config?.enabled).toBe(false);
      expect(stored.previewReady).toBe(false);
      expect(stored.error).toContain(text);
      expect(stored.report?.failed).toBe(1);
    }
    expect(requests.some((r) => r.url.endsWith("/query"))).toBe(false);
  });
  it("stays away for as long as a throttling service asks, up to an hour", async () => {
    notion = "busy";
    visit();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(stored.error).toContain("HTTP 429");
    expect(stored.config?.enabled).toBe(true);
    notion = "up";
    const before = requests.length;
    // Past the usual one-minute wait after a failure, but inside the ten minutes Notion asked for.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    visit();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(requests).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    visit();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(stored.report?.updated).toBe(1);
  });
  it("names withdrawn host access instead of reporting a dead network, and recovers", async () => {
    hostAccess = false;
    visit();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(stored.error).toContain("Canvas host access was removed");
    expect(stored.config?.enabled).toBe(true);
    expect(requests).toEqual([]);
    hostAccess = true;
    notionAccess = false;
    await untilDue();
    visit();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(stored.error).toContain("Notion host access was removed");
    expect(requests).toEqual([]);
    notionAccess = true;
    await untilDue();
    visit();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(stored.error).toBeUndefined();
    expect(stored.report?.updated).toBe(1);
  });
  it("notices withdrawn Canvas host access even though Chrome then hides the Canvas tab", async () => {
    // Without host access for Canvas, Chrome no longer tells this extension the tab's address.
    hostAccess = false;
    activeTabUrl = undefined;
    // Nor does Chrome run the Canvas page script there, but a wake that still arrived finds no tab.
    visit();
    ring();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(stored.error).toBeUndefined();
    accessRemoved({ origins: [`${config.origin}/*`] });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stored.error).toContain("Canvas host access was removed");
    expect(stored.config?.enabled).toBe(true);
    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: "!" });
    expect(requests).toEqual([]);
    // Granting access to some other site changes nothing; restoring Canvas clears the message.
    accessAdded({ origins: ["https://other.test/*"] });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stored.error).toContain("Canvas host access was removed");
    hostAccess = true;
    accessAdded({ origins: [`${config.origin}/*`] });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stored.error).toBeUndefined();
    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: "ON" });
    // A diagnosis that turned sync off outlives the access being withdrawn and restored.
    stored.config!.enabled = false;
    stored.error = "Canvas account changed. Verify your settings again before syncing.";
    hostAccess = false;
    accessRemoved({ origins: [`${config.origin}/*`] });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stored.error).toContain("account changed");
    hostAccess = true;
    accessAdded({ origins: [`${config.origin}/*`] });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stored.error).toContain("account changed");
    expect(requests).toEqual([]);
  });
  it("tells a paused user about withdrawn access only when they ask to sync", async () => {
    stored.config!.enabled = false;
    hostAccess = false;
    accessRemoved({ origins: [`${config.origin}/*`] });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stored.error).toBeUndefined();
    expect(chrome.action.setBadgeText).not.toHaveBeenCalledWith({ text: "!" });
    expect((await ask("enable")).error).toContain("Canvas host access was removed");
    expect(stored.config?.enabled).toBe(false);
    expect(requests).toEqual([]);
  });
  it("notices access withdrawn while the worker was not running", async () => {
    hostAccess = false;
    await restart();
    expect(stored.error).toContain("Canvas host access was removed");
    expect(stored.config?.enabled).toBe(true);
    expect(requests).toEqual([]);
  });
  it("clears a failed scan's message once Enable sync has checked the connection", async () => {
    canvas = "signed-out";
    visit();
    await vi.advanceTimersByTimeAsync(70_000);
    expect(stored.error).toContain("HTTP 401");
    await ask("pause");
    expect(stored.error).toContain("HTTP 401");
    // The account check waits on the request spacing timer, so the clock runs alongside it.
    const enable = async () => {
      const pending = ask("enable");
      await vi.advanceTimersByTimeAsync(20_000);
      return pending;
    };
    expect((await enable()).error).toContain("HTTP 401");
    expect(stored.config?.enabled).toBe(false);
    canvas = "up";
    expect((await enable()).ok).toBe(true);
    expect(stored.config?.enabled).toBe(true);
    expect(stored.error).toBeUndefined();
    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: "ON" });
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
    scripts = [];
    await restart();
    expect((await ask("state")).ok).toBe(true);
    expect(scripts.map((script) => script.matches)).toEqual([[`${config.origin}/*`]]);
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
    ring();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(requests).toEqual([]);
    activeTabUrl = `${config.origin}/courses/42`;
    ring();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(stored.report?.updated).toBe(1);
  });
});

describe("scheduling", () => {
  /** Advances past the time a scan takes, so it has finished and saved. */
  const settle = () => vi.advanceTimersByTimeAsync(20_000);
  it("wakes the worker only when a scan is due, instead of every minute", async () => {
    // Nothing has scanned yet, so the first scan waits for a Canvas page rather than an alarm.
    expect(armed).toBeUndefined();
    expect(chrome.alarms.create).not.toHaveBeenCalled();
    visit();
    await settle();
    expect(stored.report?.updated).toBe(1);
    expect(wait()).toBe(15 * 60_000);
    expect(armed).toEqual({ when: stored.nextScanAt });
    // Canvas is out of sight when the alarm rings: no scan, and no alarm after it.
    activeTabUrl = "https://example.com/";
    await untilDue();
    ring();
    await settle();
    expect(scans()).toBe(1);
    expect(armed).toBeUndefined();
    // Nor does a fresh start arm one for the due scan, since it would ring on every start.
    await restart();
    expect(armed).toBeUndefined();
    // The Canvas page coming into view starts that scan, which arms the alarm again.
    activeTabUrl = config.origin;
    visit();
    await settle();
    expect(scans()).toBe(2);
    expect(armed).toEqual({ when: stored.nextScanAt });
    // An alarm Chrome lost while the next scan is still ahead comes back from the saved state.
    armed = undefined;
    await restart();
    expect(armed).toEqual({ when: stored.nextScanAt });
    expect(chrome.alarms.create).not.toHaveBeenCalledWith("tick", { periodInMinutes: 1 });
  });
  it("replaces the repeating alarm an earlier version left", async () => {
    armed = { periodInMinutes: 1 };
    await restart();
    // The scan is already due, so the one-shot replacement rings once and is spent.
    expect(armed).toEqual({ when: expect.any(Number) as number });
    stored.config!.enabled = false;
    armed = { periodInMinutes: 1 };
    await restart();
    expect(armed).toBeUndefined();
    expect(scripts).toEqual([]);
  });
  it("listens only to a Canvas page that is in view", async () => {
    visit("https://example.com/");
    await settle();
    expect(requests).toEqual([]);
    activeTabUrl = "https://example.com/";
    visit();
    await settle();
    expect(requests).toEqual([]);
    activeTabUrl = config.origin;
    visit();
    await settle();
    expect(stored.report?.updated).toBe(1);
  });
  it("keeps no wakeup while sync is off, and restores both with Enable sync", async () => {
    expect(scripts).toEqual([
      {
        id: "canvas-watcher",
        matches: [`${config.origin}/*`],
        js: ["canvas.js"],
        runAt: "document_idle",
      },
    ]);
    visit();
    await settle();
    expect(armed).toBeDefined();
    await ask("pause");
    expect(armed).toBeUndefined();
    expect(scripts).toEqual([]);
    // A Canvas page that reports in view anyway starts nothing.
    await untilDue();
    visit();
    await settle();
    expect(scans()).toBe(1);
    const enabling = ask("enable");
    await settle();
    expect((await enabling).ok).toBe(true);
    expect(scripts.map((script) => script.matches)).toEqual([[`${config.origin}/*`]]);
    expect(armed).toBeDefined();
    // A scan that turns sync off takes both wakeups with it.
    userId = 8;
    ring();
    await settle();
    expect(stored.config?.enabled).toBe(false);
    expect(armed).toBeUndefined();
    expect(scripts).toEqual([]);
  });
  it("moves a Canvas page script left for another origin to the saved one", async () => {
    scripts = [{ id: "canvas-watcher", matches: ["https://old.test/*"], js: ["canvas.js"] }];
    await restart();
    expect(chrome.scripting.updateContentScripts).toHaveBeenCalled();
    expect(scripts.map((script) => script.matches)).toEqual([[`${config.origin}/*`]]);
  });
  it("doubles the wait after each failure in a row, up to an hour, which Sync now ignores", async () => {
    canvas = "signed-out";
    const minutes: number[] = [];
    for (let failures = 1; failures <= 8; failures++) {
      await untilDue();
      visit();
      await settle();
      expect(stored.failures).toBe(failures);
      expect(armed).toEqual({ when: stored.nextScanAt });
      minutes.push(wait() / 60_000);
    }
    expect(minutes).toEqual([1, 2, 4, 8, 16, 32, 60, 60]);
    // Canvas coming into view before the wait is up starts nothing.
    const before = requests.length;
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    visit();
    await settle();
    expect(requests).toHaveLength(before);
    canvas = "up";
    expect((await ask("sync")).ok).toBe(true);
    await settle();
    expect(stored.report?.updated).toBe(1);
    expect(stored.failures).toBeUndefined();
    expect(wait()).toBe(15 * 60_000);
    // After a success, the next failure waits a minute again.
    canvas = "signed-out";
    await untilDue();
    visit();
    await settle();
    expect(stored.failures).toBe(1);
    expect(wait()).toBe(60_000);
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
    expect((await configure({})).error).toContain("Canvas host access");
    hostAccess = true;
    notionAccess = false;
    expect((await configure({})).error).toContain("Notion host access");
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
  it("wakes for no Canvas page until sync is enabled for the new Canvas", async () => {
    expect(scripts.map((script) => script.matches)).toEqual([[`${config.origin}/*`]]);
    expect((await configure({ origin: "https://other.test" })).ok).toBe(true);
    expect(scripts).toEqual([]);
    expect(armed).toBeUndefined();
    stored.previewReady = true;
    const enabling = ask("enable");
    await vi.advanceTimersByTimeAsync(20_000);
    expect((await enabling).ok).toBe(true);
    expect(scripts.map((script) => script.matches)).toEqual([["https://other.test/*"]]);
  });
  it("turns sync off when the saved connection fails verification, but not for a new one", async () => {
    const untouched = () => {
      expect(stored.config).toMatchObject({ ...config, enabled: true });
      expect(stored.previewReady).toBe(true);
      expect(stored.error).toBeUndefined();
    };
    const disabled = (text: string) => {
      expect(stored.config).toMatchObject({ ...config, enabled: false });
      expect(stored.previewReady).toBe(false);
      expect(stored.error).toContain(text);
      expect(scripts).toEqual([]);
    };
    notion = "revoked";
    // A candidate token that Notion rejects proves nothing about the saved one.
    expect((await configure({ token: "candidate-token" })).error).toContain(
      "rejected the integration token",
    );
    untouched();
    // A blank token retries the saved connection itself, and that one is now proven unusable.
    expect((await configure({})).error).toContain("rejected the integration token");
    disabled("rejected the integration token");
    // Nor does another data source that is not shared say anything about the saved one.
    notion = "unshared";
    stored = { ...emptyState(), config: { ...config }, previewReady: true };
    expect(
      (await configure({ dataSourceId: "99999999-1234-1234-1234-123456789012" })).error,
    ).toContain("Share it with the integration");
    untouched();
    expect((await configure({})).error).toContain("Share it with the integration");
    disabled("Share it with the integration");
    // A schema that no longer fits is proof of the same kind.
    notion = "up";
    stored = { ...emptyState(), config: { ...config }, previewReady: true };
    schemaWithout = "Done";
    expect((await configure({})).error).toContain("Personal Status needs the Done option");
    disabled("Done option");
    stored = { ...emptyState(), config: { ...config }, previewReady: true };
    schemaWithout = "Canvas ICS";
    expect((await configure({})).error).toContain("Canvas ICS option");
    disabled("Canvas ICS option");
    // An expired Canvas login, by contrast, passes by itself and changes nothing.
    schemaWithout = "";
    stored = { ...emptyState(), config: { ...config }, previewReady: true };
    canvas = "signed-out";
    expect((await configure({})).error).toContain("HTTP 401");
    expect(stored.config?.enabled).toBe(true);
    expect(stored.previewReady).toBe(true);
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
