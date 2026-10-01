import { afterEach, describe, expect, it, vi } from "vitest";

let page: EventTarget & { visibilityState: DocumentVisibilityState };
let frame: EventTarget;
let send: ReturnType<typeof vi.fn>;
/** The worker's answer to a wake, or nothing when it does not answer at all. */
let reply: { stop: boolean; quiet?: number } | undefined;
/** Holds the worker's answer back until it settles. */
let hold: Promise<void> | undefined;
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
  vi.stubGlobal("document", page);
  vi.stubGlobal("window", frame);
  vi.stubGlobal("chrome", { runtime: { sendMessage: send } });
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
/** Lets an answer to the wake arrive. */
const answered = () => new Promise((resolve) => setTimeout(resolve));
const running = () => (globalThis as { canvasWatcher?: () => void }).canvasWatcher;
function show(visibilityState: DocumentVisibilityState) {
  page.visibilityState = visibilityState;
  page.dispatchEvent(new Event("visibilitychange"));
}
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
    show("visible");
    expect(send).toHaveBeenCalledExactlyOnceWith({ action: "wake" });
  });
  it("reports the tab being shown, the window regaining focus, and a return to the page", async () => {
    await inject("hidden");
    show("hidden");
    frame.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: false }));
    expect(send).not.toHaveBeenCalled();
    show("visible");
    await answered();
    frame.dispatchEvent(new Event("focus"));
    await answered();
    // Restored from the back-forward cache, where the script is not injected again.
    frame.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
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
    vi.useFakeTimers();
    // A tab switch and a window focus while the report of the load is still unanswered.
    show("hidden");
    show("visible");
    frame.dispatchEvent(new Event("focus"));
    expect(send).toHaveBeenCalledOnce();
    answer();
    await vi.advanceTimersByTimeAsync(59_000);
    frame.dispatchEvent(new Event("focus"));
    show("hidden");
    show("visible");
    expect(send).toHaveBeenCalledOnce();
    // Once a scan could be due, the next return to the page is reported again.
    await vi.advanceTimersByTimeAsync(1_000);
    frame.dispatchEvent(new Event("focus"));
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("adds no second set of listeners when injected into the same page again", async () => {
    await inject("visible");
    await again();
    frame.dispatchEvent(new Event("focus"));
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("stops reporting when the worker stops it, or answers that sync is off", async () => {
    await inject("visible");
    running()!();
    expect(running()).toBeUndefined();
    show("hidden");
    show("visible");
    frame.dispatchEvent(new Event("focus"));
    expect(send).toHaveBeenCalledOnce();
    // The worker answers stop to a page it could not reach when sync turned off.
    reply = { stop: true };
    await inject("visible");
    expect(running()).toBeUndefined();
    frame.dispatchEvent(new Event("focus"));
    frame.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    expect(send).toHaveBeenCalledOnce();
    // Enable sync injects it again into that page, which then reports once more.
    reply = { stop: false };
    await again();
    frame.dispatchEvent(new Event("focus"));
    expect(send).toHaveBeenCalledTimes(3);
    expect(running()).toBeDefined();
  });
});
