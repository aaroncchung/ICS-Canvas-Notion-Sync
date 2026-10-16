import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const origin = "https://canvas.test";
let page: EventTarget & { visibilityState: DocumentVisibilityState };
let frame: EventTarget;
let send: ReturnType<typeof vi.fn>;
let read: ReturnType<typeof vi.fn>;
/** The worker's answer to a wake, or nothing when it does not answer at all. */
let reply: { stop: boolean; quiet?: number } | undefined;
/** Holds the worker's answer back until it settles. */
let hold: Promise<void> | undefined;
/** What the worker left in the session area under the hint's key, if anything. */
let hint: unknown;
/** Whether Chrome refuses this page a read of the session area. */
let unreadable: boolean;
/** Injects the script into a Canvas page, as Chrome does once the page has loaded. */
async function inject(visibilityState: DocumentVisibilityState) {
  page = Object.assign(new EventTarget(), { visibilityState });
  frame = new EventTarget();
  // Chrome rejects the send when no answer comes.
  send = vi.fn(async () => {
    await hold;
    if (reply) return reply;
    throw new Error("The message port closed before a response");
  });
  // Chrome serves the read itself, without starting the worker.
  read = vi.fn((key: string) =>
    unreadable
      ? Promise.reject(new Error("Access to storage is not allowed from this context."))
      : Promise.resolve(hint === undefined ? {} : { [key]: structuredClone(hint) }),
  );
  vi.stubGlobal("document", page);
  vi.stubGlobal("window", frame);
  vi.stubGlobal("location", { origin });
  vi.stubGlobal("chrome", { runtime: { sendMessage: send }, storage: { session: { get: read } } });
  // A fresh page, where no copy of the script runs yet.
  vi.stubGlobal("canvasWatcher", undefined);
  await again();
}
/** Injects the script once more into the same page, as the worker or Chrome may. */
async function again() {
  vi.resetModules();
  await import("../src/canvas.ts");
  await answered();
}
/** Lets the hint be read, and an answer to a wake arrive. */
const answered = () => vi.advanceTimersByTimeAsync(0);
const running = () => (globalThis as { canvasWatcher?: () => void }).canvasWatcher;
async function show(visibilityState: DocumentVisibilityState) {
  page.visibilityState = visibilityState;
  page.dispatchEvent(new Event("visibilitychange"));
  await answered();
}
async function focus() {
  frame.dispatchEvent(new Event("focus"));
  await answered();
}
beforeEach(() => {
  vi.useFakeTimers();
  hint = undefined;
  unreadable = false;
});
afterEach(() => {
  reply = undefined;
  hold = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Canvas page script", () => {
  it("reports a page that loads in view, but not one loaded out of sight", async () => {
    await inject("visible");
    expect(send).toHaveBeenCalledExactlyOnceWith({ action: "wake" });
    await inject("hidden");
    expect(send).not.toHaveBeenCalled();
    // It is reported once it comes into view instead.
    await show("visible");
    expect(send).toHaveBeenCalledExactlyOnceWith({ action: "wake" });
  });
  it("reports the tab being shown, the window regaining focus, and a return to the page", async () => {
    await inject("hidden");
    await show("hidden");
    frame.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: false }));
    await answered();
    expect(send).not.toHaveBeenCalled();
    await show("visible");
    await focus();
    // Restored from the back-forward cache, where the script is not injected again.
    frame.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    await answered();
    expect(send).toHaveBeenCalledTimes(3);
    for (const [message] of send.mock.calls) expect(message).toEqual({ action: "wake" });
  });
  it("sends one report at a time, then stays quiet while the worker says no scan is due", async () => {
    let answer!: () => void;
    hold = new Promise((resolve) => {
      answer = resolve;
    });
    reply = { stop: false, quiet: 60_000 };
    await inject("visible");
    // A tab switch and a window focus while the report of the load is still unanswered.
    await show("hidden");
    await show("visible");
    await focus();
    expect(send).toHaveBeenCalledOnce();
    answer();
    await vi.advanceTimersByTimeAsync(59_000);
    await focus();
    await show("hidden");
    await show("visible");
    expect(send).toHaveBeenCalledOnce();
    // Once a scan could be due, the next return to the page is reported again.
    await vi.advanceTimersByTimeAsync(1_000);
    await focus();
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("adds no second set of listeners when injected into the same page again", async () => {
    await inject("visible");
    await again();
    await focus();
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("stops reporting when the worker stops it, or answers that sync is off", async () => {
    await inject("visible");
    running()!();
    expect(running()).toBeUndefined();
    await show("hidden");
    await show("visible");
    await focus();
    expect(send).toHaveBeenCalledOnce();
    // The worker answers stop to a page it could not reach when sync turned off.
    reply = { stop: true };
    await inject("visible");
    expect(running()).toBeUndefined();
    await focus();
    frame.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    await answered();
    expect(send).toHaveBeenCalledOnce();
    // Enable sync injects it again into that page, which then reports once more.
    reply = { stop: false };
    await again();
    await focus();
    expect(send).toHaveBeenCalledTimes(3);
    expect(running()).toBeDefined();
  });
  it("asks nothing of the worker while the hint says no scan is due for this Canvas", async () => {
    hint = { origin, until: Date.now() + 15 * 60_000 };
    await inject("visible");
    expect(read).toHaveBeenCalledExactlyOnceWith("quiet-hint");
    await show("hidden");
    await show("visible");
    await focus();
    expect(send).not.toHaveBeenCalled();
    // Once the time comes, the next return to the page is reported.
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await focus();
    expect(send).toHaveBeenCalledExactlyOnceWith({ action: "wake" });
  });
  it("follows the hint as soon as the schedule changes, ahead of the worker's last answer", async () => {
    // Asked with no hint to read, the worker answers that no scan is due for fifteen minutes.
    reply = { stop: false, quiet: 15 * 60_000 };
    await inject("visible");
    expect(send).toHaveBeenCalledOnce();
    // Then a Sync now that failed brings the next scan to a minute from now.
    hint = { origin, until: Date.now() + 60_000 };
    await focus();
    expect(send).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    await focus();
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("asks as before when the hint is missing, unreadable, for another Canvas, past, or too far ahead", async () => {
    const now = Date.now();
    const cases: Array<[unknown, boolean?]> = [
      [undefined],
      [{ origin, until: now + 15 * 60_000 }, true],
      [{ origin: "https://other.test", until: now + 15 * 60_000 }],
      [{ origin, until: now - 1 }],
      [{ origin, until: now }],
      // Further ahead than failures or Retry-After ever put a scan off.
      [{ origin, until: now + 60 * 60_000 + 1 }],
      [{ origin, until: "later" }],
      ["quiet"],
    ];
    for (const [value, refused = false] of cases) {
      hint = value;
      unreadable = refused;
      await inject("visible");
      expect(send).toHaveBeenCalledExactlyOnceWith({ action: "wake" });
    }
    // An hour ahead is as long as the worker waits, so that hint still holds.
    hint = { origin, until: now + 60 * 60_000 };
    unreadable = false;
    await inject("visible");
    expect(send).not.toHaveBeenCalled();
  });
});
