import { afterEach, describe, expect, it, vi } from "vitest";

let page: EventTarget & { visibilityState: DocumentVisibilityState };
let frame: EventTarget;
let send: ReturnType<typeof vi.fn>;
/** Injects the script into a Canvas page, as Chrome does once the page has loaded. */
async function inject(visibilityState: DocumentVisibilityState) {
  page = Object.assign(new EventTarget(), { visibilityState });
  frame = new EventTarget();
  // The worker never answers, and Chrome rejects the send when no answer comes.
  send = vi.fn(() => Promise.reject(new Error("The message port closed before a response")));
  vi.stubGlobal("document", page);
  vi.stubGlobal("window", frame);
  vi.stubGlobal("chrome", { runtime: { sendMessage: send } });
  vi.resetModules();
  await import("../src/canvas.ts");
}
function show(visibilityState: DocumentVisibilityState) {
  page.visibilityState = visibilityState;
  page.dispatchEvent(new Event("visibilitychange"));
}
afterEach(() => {
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
});
