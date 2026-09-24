import { afterEach, describe, expect, it, vi } from "vitest";

let page: EventTarget & { visibilityState: DocumentVisibilityState };
let frame: EventTarget;
let send: ReturnType<typeof vi.fn>;
/** The worker's answer to a wake, or nothing when it does not answer at all. */
let reply: { stop: boolean } | undefined;
/** Injects the script into a Canvas page, as Chrome does once the page has loaded. */
async function inject(visibilityState: DocumentVisibilityState) {
  page = Object.assign(new EventTarget(), { visibilityState });
  frame = new EventTarget();
  // Chrome rejects the send when no answer comes.
  send = vi.fn(() =>
    reply
      ? Promise.resolve(reply)
      : Promise.reject(new Error("The message port closed before a response")),
  );
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
  // Lets an answer to the wake arrive.
  await Promise.resolve();
}
const running = () => (globalThis as { canvasWatcher?: () => void }).canvasWatcher;
function show(visibilityState: DocumentVisibilityState) {
  page.visibilityState = visibilityState;
  page.dispatchEvent(new Event("visibilitychange"));
}
afterEach(() => {
  reply = undefined;
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
    frame.dispatchEvent(new Event("focus"));
    // Restored from the back-forward cache, where the script is not injected again.
    frame.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    expect(send).toHaveBeenCalledTimes(3);
    for (const [message] of send.mock.calls) expect(message).toEqual({ action: "wake" });
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
